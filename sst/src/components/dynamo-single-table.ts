/**
 * `DynamoSingleTable` — a reusable single-table DynamoDB building block.
 *
 * NOTE: these constructs reference SST's ambient `$`-globals (`sst.aws.*`,
 * `$util`, `$interpolate`, `$app`). Those types come from the *consuming* SST
 * app's `.sst/platform/config.d.ts` (which the app's tsconfig already
 * includes). The package's own standalone typecheck wires the same types via
 * `tsconfig.json`'s `include`. We deliberately do NOT carry a relative
 * `/// <reference path=".sst/platform/config.d.ts" />` here — that path doesn't
 * exist once the package is installed into a consumer's `node_modules`.
 *
 * Mirrors the key design the smooth-operator DynamoDB adapter expects
 * (`rust/adapters/dynamodb/src/keys.rs`): an overloaded `pk`/`sk` primary key
 * plus one all-projecting GSI (`gsi1`) over `gsi1pk`/`gsi1sk`, with a `ttl`
 * attribute powering the `$connect`/`$disconnect` connection-registry rows.
 *
 * Factored out of `smooth-operator-agent/deploy/sst/sst.config.ts` so any SmooAI
 * SST app can adopt the same overloaded-key table without re-deriving the field
 * map. PAY_PER_REQUEST is SST's `Dynamo` default.
 *
 * The component is a thin wrapper around `sst.aws.Dynamo`: it returns the raw
 * `sst.aws.Dynamo` instance so callers keep full access to `.name`, `.arn`, and
 * SST `link()` semantics.
 */

/** Tunables for {@link DynamoSingleTable}. */
export interface DynamoSingleTableArgs {
    /**
     * The single-table key design. Defaults to the smooth-operator overloaded
     * `pk`/`sk` + `gsi1pk`/`gsi1sk` shape. Override only if a consumer needs a
     * different field map (e.g. extra GSIs).
     */
    fields?: Record<string, 'string' | 'number' | 'binary'>;
    /** Primary index. Defaults to `{ hashKey: 'pk', rangeKey: 'sk' }`. */
    primaryIndex?: { hashKey: string; rangeKey?: string };
    /**
     * Global secondary indexes. Defaults to one all-projecting `gsi1` over
     * `gsi1pk`/`gsi1sk`.
     */
    globalIndexes?: Record<string, { hashKey: string; rangeKey?: string }>;
    /**
     * The TTL attribute name (DynamoDB auto-expiry). Defaults to `'ttl'`; pass
     * `false` to disable TTL entirely.
     */
    ttl?: string | false;
    /** Pass-through `$transform`/component options for the underlying `Dynamo`. */
    transform?: sst.aws.DynamoArgs['transform'];
}

/** The smooth-operator overloaded-key field map (the default). */
export const SMOOTH_AGENT_TABLE_FIELDS = {
    pk: 'string',
    sk: 'string',
    gsi1pk: 'string',
    gsi1sk: 'string',
} as const;

/**
 * Create a single-table `sst.aws.Dynamo` with the SmooAI overloaded-key design.
 *
 * @returns the underlying `sst.aws.Dynamo` (so `link()`, `.name`, `.arn` work).
 */
export function DynamoSingleTable(name: string, args: DynamoSingleTableArgs = {}): sst.aws.Dynamo {
    const ttl = args.ttl ?? 'ttl';
    return new sst.aws.Dynamo(name, {
        fields: args.fields ?? { ...SMOOTH_AGENT_TABLE_FIELDS },
        primaryIndex: args.primaryIndex ?? { hashKey: 'pk', rangeKey: 'sk' },
        globalIndexes: args.globalIndexes ?? {
            gsi1: { hashKey: 'gsi1pk', rangeKey: 'gsi1sk' },
        },
        ...(ttl === false ? {} : { ttl }),
        ...(args.transform ? { transform: args.transform } : {}),
    });
}
