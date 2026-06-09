'use strict';
/**
 * @smooai/deploy/next — portable S3-backed Next.js `cacheHandler`.
 *
 * Hosting Next.js as a horizontally-scaled container (e.g. `output: 'standalone'`
 * behind an ALB / multiple pods) breaks Next's default per-pod `.next/cache`
 * filesystem cache: every replica has its own ISR/SSG/fetch cache, so caches are
 * inconsistent across pods and lost on restart/reschedule. This handler points
 * all replicas at ONE shared S3 store, so the incremental cache is consistent
 * across replicas and survives restarts.
 *
 * Design notes (all preserved from the reference handler this was extracted from):
 * - **Faithful round-trip, not kind-interpretation.** Next hands us an
 *   `IncrementalCacheValue` (PAGE/APP_PAGE/ROUTE/FETCH/…) whose exact shape
 *   shifts across Next versions and embeds Buffers (RSC payloads, route bodies).
 *   We don't parse the kinds — we serialize the value verbatim (Buffers → base64)
 *   and return it identically on get(). That's version-robust and the reason a
 *   from-scratch handler is viable without OpenNext's globalThis-coupled adapter.
 * - **Time-based only.** This handler stores/returns entries; Next decides
 *   staleness from `lastModified` + the route's `revalidate`. On-demand tag
 *   revalidation (`revalidateTag`/`revalidatePath`) is a deliberate no-op — see
 *   `revalidateTag` below.
 * - **buildId-namespaced keys** so a new deploy never reads a previous build's
 *   (binary-incompatible) payload. Expire stale build prefixes with an S3 bucket
 *   lifecycle rule.
 * - **Fail-safe.** A cache miss/error must NEVER break rendering: get() returns
 *   null on any error (→ regenerate), set() swallows. No bucket configured (local
 *   dev, or env not yet resolved) → no-op cache, site still serves uncached.
 * - **Creds via the default AWS provider chain.** The S3 client uses the default
 *   provider chain, which on EKS resolves to the pod's IRSA role — no keys baked
 *   into the container.
 *
 * Configuration is ENV-only (the consumer is responsible for wiring these from
 * whatever its config source of truth is):
 *   - `CACHE_BUCKET_NAME`       (required; absent → no-op cache, site serves uncached)
 *   - `CACHE_BUCKET_REGION`     (fallback: `AWS_REGION`, then `us-east-1`)
 *   - `CACHE_BUCKET_KEY_PREFIX` (default: `next-cache`)
 *   - `CACHE_DEBUG`             (truthy → console.warn cache hit/miss/error events)
 *
 * **Observability hook.** Set `globalThis.__SMOOAI_CACHE_ON_EVENT` to a function
 * `(event) => void` to receive structured cache events without coupling this
 * module to any metrics client. Each event is:
 *   { type: 'hit' | 'miss' | 'error', op: 'get' | 'set' | 'revalidateTag',
 *     key?: string, fetch?: boolean, error?: string }
 * If no callback is set and `CACHE_DEBUG` is truthy, events are logged to console.
 *
 * Kept as CommonJS (`.cjs`) so Next can `require.resolve` it in the standalone
 * build, and so the only runtime dependency (`@aws-sdk/client-s3`) is resolved
 * from the consumer's Next app (declared as a peer dependency).
 */

const fs = require('node:fs');
const path = require('node:path');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

// ── observability hook ───────────────────────────────────────────────────────
// Resolve a consumer-supplied callback at call time (it may be set after this
// module loads). Falls back to a CACHE_DEBUG-gated console so consumers can wire
// metrics without this module depending on any metrics client.
function emit(event) {
    try {
        const cb = globalThis.__SMOOAI_CACHE_ON_EVENT;
        if (typeof cb === 'function') {
            cb(event);
            return;
        }
    } catch {
        /* a broken observability hook must never break the cache */
    }
    if (process.env.CACHE_DEBUG) {
        const { type, op, key, error } = event;
        console.warn(`[smooai-cache] ${op} ${type}`, key ?? '', error ?? '');
    }
}

// ── buildId (read once) ──────────────────────────────────────────────────────
function readBuildId() {
    const candidates = [path.join(process.cwd(), '.next', 'BUILD_ID'), path.join(process.cwd(), '.next', 'standalone', '.next', 'BUILD_ID')];
    for (const p of candidates) {
        try {
            const id = fs.readFileSync(p, 'utf8').trim();
            if (id) return id;
        } catch {
            /* try next */
        }
    }
    return process.env.NEXT_BUILD_ID || 'nobuild';
}
const BUILD_ID = readBuildId();

// ── lazy S3 store (bucket name arrives via env) ──────────────────────────────
let resolved; // undefined = unresolved, null = no bucket (no-op), object = ready
function store() {
    if (resolved !== undefined) return resolved;
    const bucket = process.env.CACHE_BUCKET_NAME;
    if (!bucket) {
        resolved = null; // degrade to no-op; site serves uncached
        return resolved;
    }
    resolved = {
        s3: new S3Client({ region: process.env.CACHE_BUCKET_REGION || process.env.AWS_REGION || 'us-east-1' }),
        bucket,
        prefix: process.env.CACHE_BUCKET_KEY_PREFIX || 'next-cache',
    };
    return resolved;
}

function s3Key(prefix, key, isFetch) {
    const safe = String(key).replace(/^\/+/, ''); // no leading slash → no `//` in the key
    return `${prefix}/${BUILD_ID}/${safe}.${isFetch ? 'fetch' : 'cache'}`;
}

function isFetch(ctx) {
    return !!ctx && typeof ctx === 'object' && (ctx.fetchCache === true || ctx.kind === 'FETCH' || ctx.kindHint === 'fetch');
}

// Buffer-aware (de)serialization: preserve Buffers faithfully across the wire.
function serialize(entry) {
    return JSON.stringify(entry, (_k, v) => (Buffer.isBuffer(v) ? { __b64: v.toString('base64') } : v));
}
function deserialize(str) {
    return JSON.parse(str, (_k, v) => (v && typeof v === 'object' && typeof v.__b64 === 'string' ? Buffer.from(v.__b64, 'base64') : v));
}

async function streamToString(body) {
    if (typeof body.transformToString === 'function') return body.transformToString('utf8'); // SDK v3 helper
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
}

module.exports = class S3CacheHandler {
    constructor(options) {
        this.options = options;
    }

    async get(key, ctx) {
        const s = store();
        if (!s) return null;
        const fetchKind = isFetch(ctx);
        try {
            const res = await s.s3.send(new GetObjectCommand({ Bucket: s.bucket, Key: s3Key(s.prefix, key, fetchKind) }));
            const entry = deserialize(await streamToString(res.Body));
            emit({ type: 'hit', op: 'get', key, fetch: fetchKind });
            return { lastModified: entry.lastModified, value: entry.value };
        } catch (e) {
            // Miss (NoSuchKey/404) and any deserialize/format error → regenerate.
            if (e && (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404)) {
                emit({ type: 'miss', op: 'get', key, fetch: fetchKind });
                return null;
            }
            emit({ type: 'error', op: 'get', key, fetch: fetchKind, error: e?.name || String(e) });
            return null;
        }
    }

    async set(key, value, ctx) {
        const s = store();
        if (!s) return;
        const fetchKind = isFetch(ctx);
        try {
            const tags = (ctx && (ctx.tags || ctx.softTags)) || [];
            const body = serialize({ value, lastModified: Date.now(), tags, revalidate: ctx?.revalidate });
            await s.s3.send(
                new PutObjectCommand({
                    Bucket: s.bucket,
                    Key: s3Key(s.prefix, key, fetchKind),
                    Body: body,
                    ContentType: 'application/json',
                }),
            );
        } catch (e) {
            // Never break rendering on a cache write failure.
            emit({ type: 'error', op: 'set', key, fetch: fetchKind, error: e?.name || String(e) });
        }
    }

    /**
     * On-demand tag revalidation needs a tag→key index to avoid scanning all of
     * S3 — the kind of DynamoDB tag tier OpenNext maintains. This handler is
     * time-based only (no `revalidateTag`/`revalidatePath`), so this is a
     * deliberate no-op. Wiring a DynamoDB tag store is the future on-demand path.
     */
    async revalidateTag(tags) {
        emit({ type: 'miss', op: 'revalidateTag', key: Array.isArray(tags) ? tags.join(',') : String(tags) });
    }

    resetRequestCache() {}
};
