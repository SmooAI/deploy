/**
 * `@smooai/deploy/next` — portable Next.js runtime-cache helpers for hosting
 * Next.js as a horizontally-scaled container.
 *
 * `withSmooaiCache(nextConfig)` wires Next's incremental cache to the shared
 * S3-backed `cacheHandler` shipped alongside this module, so every replica
 * reads/writes one S3 store instead of a per-pod `.next/cache`. See
 * `./cache-handler.cjs` for the env-var contract and fail-safe behavior, and
 * `./README.md` for IRSA/S3 permissions and usage.
 */

/**
 * The minimal slice of Next's config this helper reads/writes. We intentionally
 * avoid importing `next`'s `NextConfig` type so this subpath has no `next` build
 * dependency — the helper only sets a handful of well-known string/number keys
 * and forwards everything else untouched.
 */
export interface SmooaiCacheConfig {
    /** Absolute path to a Next.js `cacheHandler` module. */
    cacheHandler?: string;
    /** In-memory LRU cache size, in bytes. `0` disables it (S3 is the source of truth). */
    cacheMaxMemorySize?: number;
    /** Whether Next gzip-compresses responses. Disabled so the CDN/ALB compresses instead. */
    compress?: boolean;
    /**
     * Packages Next should NOT bundle into the server build (run from
     * `node_modules` + traced into the standalone output instead). We add
     * `@aws-sdk/client-s3` here so webpack never tries to bundle the SDK's
     * `node:`-scheme internals when it compiles the cacheHandler.
     */
    serverExternalPackages?: string[];
    [key: string]: unknown;
}

/**
 * Absolute path to the shipped portable S3 cache handler. Resolves the file as
 * published in `@smooai/deploy`, so it works from a consumer's `node_modules`
 * (including Next's `output: 'standalone'` build, which calls `require.resolve`
 * on the configured handler).
 */
export function smooaiCacheHandlerPath(): string {
    return require.resolve('@smooai/deploy/next/cache-handler.cjs');
}

/**
 * Wrap a Next.js config so the incremental cache (ISR/SSG/fetch) is served from
 * the shared S3 store instead of each container's local `.next/cache`.
 *
 * - `cacheHandler` → the shipped `cache-handler.cjs` (resolved from the package).
 * - `cacheMaxMemorySize: 0` → disable the in-memory LRU so S3 is authoritative
 *   across replicas (no per-pod memory cache to drift).
 * - `compress: false` → let the CDN/ALB compress; avoids double-compression.
 *
 * The caller's existing config is preserved; only the three keys above are set.
 * Behavior degrades safely: if `CACHE_BUCKET_NAME` is unset at runtime, the
 * handler no-ops and the site serves uncached (see `./cache-handler.cjs`).
 *
 * @typeParam T - the caller's Next config shape (returned widened with the cache keys).
 */
// `T extends object` (not `SmooaiCacheConfig`): we only ADD the three cache
// keys, never require them on input — constraining to SmooaiCacheConfig wrongly
// rejected a full Next `NextConfig` whose `cacheHandler`/`compress` field types
// don't structurally match this minimal shape. Any config object is accepted.
export function withSmooaiCache<T extends object>(nextConfig: T = {} as T): T & SmooaiCacheConfig {
    // Merge (don't clobber) any serverExternalPackages the caller already set, and
    // ensure @aws-sdk/client-s3 is externalized so webpack doesn't bundle the SDK's
    // node:-scheme internals when compiling the cacheHandler. De-duped.
    const existing = (nextConfig as { serverExternalPackages?: string[] }).serverExternalPackages;
    const serverExternalPackages = Array.from(new Set([...(Array.isArray(existing) ? existing : []), '@aws-sdk/client-s3']));
    return {
        ...nextConfig,
        cacheHandler: smooaiCacheHandlerPath(),
        cacheMaxMemorySize: 0,
        compress: false,
        serverExternalPackages,
    };
}

export default withSmooaiCache;
