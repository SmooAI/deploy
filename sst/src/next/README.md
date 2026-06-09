# `@smooai/deploy/next` — portable Next.js S3 cache handler

A drop-in Next.js `cacheHandler` (plus a `withSmooaiCache()` config helper) for hosting Next.js as a **horizontally-scaled container** — multiple pods/replicas behind a load balancer.

## Why

Next's default incremental cache is the per-pod filesystem (`.next/cache`). With more than one replica, that means:

- each replica has its **own** ISR/SSG/fetch cache (inconsistent across pods),
- caches are **lost** on restart / reschedule, and
- on-demand revalidation only invalidates the replica that handled the request.

This handler points every replica at **one shared S3 bucket**, so the incremental cache (ISR/SSG/fetch) is consistent across replicas and survives restarts. It's the runtime-cache piece of running `output: 'standalone'` Next.js in a container.

## What it does

- **Faithful round-trip.** Serializes Next's `IncrementalCacheValue` verbatim (Buffers → base64) and returns it identically — version-robust across Next releases, no kind-interpretation.
- **buildId-namespaced keys.** A new deploy never reads a previous build's binary-incompatible payload. Expire stale build prefixes with an S3 lifecycle rule.
- **Fail-safe.** A cache miss/error NEVER breaks rendering: `get()` returns `null` on any error (→ regenerate), `set()` swallows write errors.
- **No-op degrade.** If `CACHE_BUCKET_NAME` is unset, the handler is a no-op and the site serves uncached. Safe for local dev.
- **IRSA / default-chain creds.** The S3 client uses the AWS default provider chain — on EKS that's the pod's IRSA role. No keys baked into the container.

## Usage

In `next.config.ts` (or `.js` / `.mjs`):

```ts
import { withSmooaiCache } from '@smooai/deploy/next';

const nextConfig = {
    output: 'standalone',
    // …your config…
};

export default withSmooaiCache(nextConfig);
```

`withSmooaiCache(config)` preserves your config and sets three keys:

| Key                  | Value                                          | Why                                                            |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `cacheHandler`       | resolved path to the shipped `cache-handler.cjs` | routes the incremental cache to S3                            |
| `cacheMaxMemorySize` | `0`                                            | disable the in-memory LRU so S3 is authoritative across pods |
| `compress`           | `false`                                        | let the CDN/ALB compress (avoids double-compression)         |

Signature: `withSmooaiCache<T extends SmooaiCacheConfig>(nextConfig?: T): T & SmooaiCacheConfig`. The helper has no `next` dependency — it reads/writes only the well-known cache keys and forwards the rest.

If you wire the handler yourself instead of using the helper, `smooaiCacheHandlerPath()` returns the resolved path to the shipped `cache-handler.cjs`.

## Configuration (env only)

The handler is configured entirely through environment variables — your app is responsible for populating them from whatever its config source of truth is (an instrumentation hook, a secrets manager, etc.).

| Variable                 | Required | Default                                 | Purpose                                                                                  |
| ------------------------ | -------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `CACHE_BUCKET_NAME`      | yes      | — (absent → no-op cache, serves uncached) | S3 bucket holding the shared incremental cache.                                          |
| `CACHE_BUCKET_REGION`    | no       | `AWS_REGION`, then `us-east-1`          | Region for the S3 client.                                                                |
| `CACHE_BUCKET_KEY_PREFIX`| no       | `next-cache`                            | Key prefix under which cache entries are stored (keys are `<prefix>/<buildId>/<key>.…`). |
| `CACHE_DEBUG`            | no       | unset                                   | Truthy → log cache hit/miss/error events to console (when no observability hook is set). |

## Required AWS permissions

The runtime role (on EKS, the pod's IRSA role) needs, scoped to the cache bucket:

- `s3:GetObject`
- `s3:PutObject`

on `arn:aws:s3:::<CACHE_BUCKET_NAME>/*`. No `ListBucket` or delete permissions are required by the handler (old build prefixes are reaped by an S3 lifecycle rule, not by the app).

Only dependency at runtime: `@aws-sdk/client-s3` (declared as an **optional peer dependency** — it normally already lives in your Next app's `node_modules`).

## Observability

Set a callback to receive structured cache events without coupling this module to any metrics client:

```ts
// e.g. in instrumentation.ts, before the cache handler is first used
globalThis.__SMOOAI_CACHE_ON_EVENT = (event) => {
    // event = { type: 'hit' | 'miss' | 'error',
    //           op: 'get' | 'set' | 'revalidateTag',
    //           key?: string, fetch?: boolean, error?: string }
    metrics.increment(`next_cache.${event.op}.${event.type}`);
};
```

If no callback is set and `CACHE_DEBUG` is truthy, events are logged to the console instead.

## On-demand tag revalidation

`revalidateTag` is a **deliberate no-op**. On-demand tag invalidation needs a tag→key index (to avoid scanning all of S3) — typically a DynamoDB tag tier (as OpenNext maintains). This handler is **time-based only**: Next decides staleness from each entry's `lastModified` + the route's `revalidate`. If you need on-demand `revalidateTag`/`revalidatePath`, add a DynamoDB tag store; that's the intended future extension.
