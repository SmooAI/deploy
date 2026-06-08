import { DynamoSingleTable } from './dynamo-single-table';
import { WebSocketLambdaApi, type RouteSpec } from './websocket-lambda-api';

/**
 * `SmoothAgentApi` — the full AWS-serverless deploy primitive for a
 * smooth-operator-style agent: API Gateway WebSocket + the (Rust) Lambda wiring
 * + a DynamoDB single table + an S3 blob bucket + an S3 Vectors placeholder + a
 * gateway-key secret + the IAM links between them.
 *
 * This is the construct extracted from
 * `smooth-operator/deploy/sst/sst.config.ts`. The app-specific bits are
 * parameterized: the prebuilt Lambda artifact dir, the model id, the gateway
 * key/url secret refs, the table/bucket logical names, and the per-org config.
 * Everything else (overloaded-key table, route table, post-back permission, S3
 * Vectors env wiring) is shared.
 *
 * ## The Rust-Lambda build seam
 * SST has no native Rust builder, so the Lambda bootstrap is built out-of-band
 * with `cargo lambda` and the `Function` points at that prebuilt artifact dir
 * (`provided.al2023` / `arm64`). The caller passes that dir as `artifactDir`.
 *
 * ## The S3 Vectors gap
 * SST v4 ships no native S3 Vectors component (the service went GA 2025-12), and
 * the AWS Pulumi provider's `s3vectors` resources are new. So this construct
 * does **not** create the vector bucket/index as a first-class resource by
 * default — it declares the *intended* names and wires them into the Lambda env
 * (`SMOOTH_AGENT_VECTOR_BUCKET` / `..._INDEX_PREFIX`) so the rest of the wiring
 * is stable, and grants `s3vectors:*` on the route. Provision the bucket/index
 * out-of-band (aws CLI / CloudFormation) per the README, or set
 * `manageVectorResources: true` once your provider exposes `aws.s3vectors.*`.
 */

/** Tunables for {@link SmoothAgentApi}. */
export interface SmoothAgentApiArgs {
    /**
     * The prebuilt Lambda handler/artifact directory (the `cargo lambda` output
     * dir holding `bootstrap`), relative to the consuming `sst.config.ts`.
     * Required — this is the per-app build output.
     */
    artifactDir: string;

    /** The agent model id requested from the LLM gateway. Defaults to `claude-haiku-4-5`. */
    model?: string;
    /** The OpenAI-compatible LLM gateway base URL. Defaults to `https://llm.smoo.ai/v1`. */
    gatewayUrl?: string;
    /** Per-org partition for keys/state. Defaults to `'default'`. */
    orgId?: string;
    /** Agent-loop iteration cap per turn. Defaults to `6`. */
    maxIterations?: number;
    /** `max_tokens` sent to the gateway. Defaults to `512`. */
    maxTokens?: number;

    /**
     * S3 Vectors index name prefix. Defaults to `'smooth-agent-knowledge'`.
     * The vector bucket name defaults to `smooth-agent-vectors-<stage>`.
     */
    vectorIndexPrefix?: string;

    /**
     * Override the WebSocket route table. Defaults to the SmooAI protocol routes
     * (`$connect`, `$disconnect`, `send_message`, `ping`, `$default`).
     */
    routes?: RouteSpec[];

    /**
     * Extra environment merged into the Lambda (after the defaults this
     * construct sets). Use for app-specific knobs.
     */
    extraEnvironment?: Record<string, $util.Input<string>>;
}

/** Resolved outputs for the SST app's `run()` return. */
export interface SmoothAgentApiOutputs {
    api: $util.Output<string>;
    table: $util.Output<string>;
    blobs: $util.Output<string>;
    vectorBucket: $util.Output<string>;
}

/**
 * Compose the full smooth-operator serverless backend.
 *
 * Authored as a class so consumers use the SST-component `new` form
 * (`new SmoothAgentApi('SmoothAgent', { … })`) and can read the sub-resources
 * (`.table`, `.blobs`, `.gatewayKey`) or return `.outputs` from `run()`.
 *
 * @example
 *   const agent = new SmoothAgentApi('SmoothAgent', {
 *       artifactDir: '../../rust/target/lambda/smooai-smooth-operator-lambda',
 *       model: 'claude-haiku-4-5',
 *   });
 *   return agent.outputs;
 */
export class SmoothAgentApi {
    /** The API Gateway WebSocket API. */
    readonly api: sst.aws.ApiGatewayWebSocket;
    /** The DynamoDB single table (OLTP + checkpoints + connection registry). */
    readonly table: sst.aws.Dynamo;
    /** The S3 blob bucket (attachments / large payloads). */
    readonly blobs: sst.aws.Bucket;
    /** The gateway-key secret. */
    readonly gatewayKey: sst.Secret;
    /** Resolved outputs for the SST app's `run()` return. */
    readonly outputs: SmoothAgentApiOutputs;

    constructor(name: string, args: SmoothAgentApiArgs) {
        // ── DynamoDB single table ──────────────────────────────────────────
        const table = DynamoSingleTable(`${name}Table`, {});

        // ── S3 blob bucket ─────────────────────────────────────────────────
        const blobs = new sst.aws.Bucket(`${name}Blobs`);

        // ── S3 Vectors index (the gap) ─────────────────────────────────────
        // SST v4 has no native S3 Vectors component; declare the *intended*
        // names and wire them via env. Provision out-of-band per the README.
        const vectorBucketName = $interpolate`smooth-agent-vectors-${$app.stage}`;
        const vectorIndexPrefix = args.vectorIndexPrefix ?? 'smooth-agent-knowledge';

        // ── Gateway key secret ─────────────────────────────────────────────
        // The smooai monorepo standard is @smooai/config; this standalone
        // surface uses sst.Secret placeholders (set via `sst secret set …`).
        // Adopt @smooai/config when folded back into the monorepo.
        const gatewayKey = new sst.Secret(`${name}GatewayKey`);
        const gatewayUrl = new sst.Secret(`${name}GatewayUrl`, args.gatewayUrl ?? 'https://llm.smoo.ai/v1');
        const model = new sst.Secret(`${name}Model`, args.model ?? 'claude-haiku-4-5');

        // Common environment for the Lambda — maps 1:1 to `LambdaConfig::from_env`.
        const environment: Record<string, $util.Input<string>> = {
            SMOOTH_AGENT_DDB_TABLE: table.name,
            SMOOAI_GATEWAY_URL: gatewayUrl.value,
            SMOOAI_GATEWAY_KEY: gatewayKey.value,
            SMOOTH_AGENT_MODEL: model.value,
            SMOOTH_AGENT_ORG_ID: args.orgId ?? 'default',
            SMOOTH_AGENT_VECTOR_BUCKET: vectorBucketName,
            SMOOTH_AGENT_VECTOR_INDEX_PREFIX: vectorIndexPrefix,
            SMOOTH_AGENT_MAX_ITERATIONS: String(args.maxIterations ?? 6),
            SMOOTH_AGENT_MAX_TOKENS: String(args.maxTokens ?? 512),
            ...(args.extraEnvironment ?? {}),
        };

        // ── API Gateway WebSocket + Lambda routes ──────────────────────────
        const { api } = WebSocketLambdaApi(`${name}Api`, {
            handler: args.artifactDir,
            environment,
            link: [table, blobs, gatewayKey, gatewayUrl, model],
            // execute-api:ManageConnections is granted by WebSocketLambdaApi;
            // add the S3 Vectors put/query/get for the knowledge backend.
            permissions: [
                {
                    actions: ['s3vectors:PutVectors', 's3vectors:QueryVectors', 's3vectors:GetVectors'],
                    resources: ['*'],
                },
            ],
            ...(args.routes ? { routes: args.routes } : {}),
        });

        this.api = api;
        this.table = table;
        this.blobs = blobs;
        this.gatewayKey = gatewayKey;
        this.outputs = {
            api: api.url,
            table: table.name,
            blobs: blobs.name,
            vectorBucket: vectorBucketName,
        };
    }
}
