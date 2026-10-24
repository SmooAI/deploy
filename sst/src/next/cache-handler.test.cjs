// SMOODEV-3805: cached route bodies (favicon.ico, opengraph-image) must come back
// as Buffers. They used to come back as `{ type: 'Buffer', data }`, which Next
// wrote to the response as the 15-byte text "[object Object]".
//
//   node --test src/next/cache-handler.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// In-memory stand-in for @aws-sdk/client-s3.
const objects = new Map();
class GetObjectCommand {
    constructor(input) {
        this.input = input;
    }
}
class PutObjectCommand {
    constructor(input) {
        this.input = input;
    }
}
class S3Client {
    async send(cmd) {
        if (cmd instanceof PutObjectCommand) return void objects.set(cmd.input.Key, cmd.input.Body);
        if (!objects.has(cmd.input.Key)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        const body = objects.get(cmd.input.Key);
        return { Body: { transformToString: async () => body } };
    }
}
const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === '@aws-sdk/client-s3') return { S3Client, GetObjectCommand, PutObjectCommand };
    return realLoad.call(this, request, ...rest);
};
process.env.CACHE_BUCKET_NAME = 'test-bucket';
process.env.NEXT_BUILD_ID = 'test-build';

const S3CacheHandler = require('./cache-handler.cjs');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

test('an APP_ROUTE body round-trips as the same Buffer', async () => {
    const handler = new S3CacheHandler({});
    await handler.set('/favicon.ico', { kind: 'APP_ROUTE', status: 200, body: PNG, headers: { 'content-type': 'image/x-icon' } }, {});
    const hit = await handler.get('/favicon.ico', {});
    assert.ok(Buffer.isBuffer(hit.value.body), 'body should be a Buffer');
    assert.deepEqual(hit.value.body, PNG);
    assert.equal(hit.value.headers['content-type'], 'image/x-icon');
});

test('an entry written before the fix ({ type: "Buffer", data }) still decodes to a Buffer', async () => {
    objects.set('next-cache/test-build/opengraph-image.cache', JSON.stringify({ value: { kind: 'APP_ROUTE', body: PNG }, lastModified: 1 }));
    const hit = await new S3CacheHandler({}).get('/opengraph-image', {});
    assert.ok(Buffer.isBuffer(hit.value.body));
    assert.deepEqual(hit.value.body, PNG);
});

// SMOODEV-4146: Next 16 keeps an APP_PAGE's per-segment prefetch payloads in a
// Map. JSON.stringify turned it into {}, so on a hit Next's
// `cachedData.segmentData.get(...)` threw and every segment prefetch of a cached
// page (Next-Router-Segment-Prefetch: /_tree) answered 500.
const RSC = Buffer.from('0:{"tree":1}');
const SEGMENTS = new Map([
    ['/_tree', Buffer.from('tree-payload')],
    ['/_index', Buffer.from('index-payload')],
]);

test('an APP_PAGE segmentData Map round-trips as a Map of Buffers', async () => {
    const handler = new S3CacheHandler({});
    await handler.set('/help', { kind: 'APP_PAGE', html: '<html></html>', rscData: RSC, segmentData: SEGMENTS, status: 200, headers: {} }, {});
    const hit = await handler.get('/help', {});
    assert.ok(hit.value.segmentData instanceof Map, 'segmentData should be a Map');
    assert.deepEqual([...hit.value.segmentData.keys()], ['/_tree', '/_index']);
    assert.ok(Buffer.isBuffer(hit.value.segmentData.get('/_tree')));
    assert.deepEqual(hit.value.segmentData.get('/_tree'), SEGMENTS.get('/_tree'));
    assert.deepEqual(hit.value.rscData, RSC);
});

test('an APP_PAGE written before the fix (segmentData lost as {}) is a miss, so Next regenerates it', async () => {
    objects.set(
        'next-cache/test-build/privacy-policy.cache',
        JSON.stringify({ value: { kind: 'APP_PAGE', html: '<html></html>', rscData: { __b64: RSC.toString('base64') }, segmentData: {} }, lastModified: 1 }),
    );
    assert.equal(await new S3CacheHandler({}).get('/privacy-policy', {}), null);
});
