/**
 * `WebSocketLambdaApi` — a reusable API Gateway WebSocket + (Rust) Lambda
 * building block.
 *
 * One prebuilt Lambda artifact (the SmooAI standard is a `cargo lambda`
 * `provided.al2023`/`arm64` bootstrap, but any handler dir works) serves every
 * route; `requestContext.routeKey` selects the behavior inside the binary.
 * All routes share the same artifact + environment + links + permissions, so
 * adding a route is one line.
 *
 * Because API Gateway WS invokes the function **once per message** (no
 * persistent socket), the handler is expected to post events **back** via the
 * API Gateway Management API (`execute-api:ManageConnections`) — granted here by
 * default.
 *
 * Factored out of `smooth-operator/deploy/sst/sst.config.ts`.
 */

/**
 * SST Lambda timeout/memory literal-union types, re-declared so consumers stay
 * type-safe without importing SST's internal `Duration`/`Size` modules.
 */
export type RouteTimeout = `${number} second` | `${number} seconds` | `${number} minute` | `${number} minutes`;
export type RouteMemory = `${number} MB` | `${number} GB`;

/** Per-route override of timeout / memory. */
export interface RouteSpec {
    /** The API Gateway WebSocket route key (e.g. `$connect`, `send_message`). */
    routeKey: string;
    timeout: RouteTimeout;
    memory: RouteMemory;
}

/** Tunables for {@link WebSocketLambdaApi}. */
export interface WebSocketLambdaApiArgs {
    /**
     * The prebuilt Lambda handler/artifact directory. For the SmooAI Rust path
     * this is the `cargo lambda` output dir holding `bootstrap`
     * (e.g. `../../rust/target/lambda/<crate>`).
     */
    handler: string;
    /** Lambda runtime. Defaults to `'provided.al2023'` (the Rust custom runtime). */
    runtime?: sst.aws.FunctionArgs['runtime'];
    /** Lambda architecture. Defaults to `'arm64'`. */
    architecture?: sst.aws.FunctionArgs['architecture'];
    /** Environment injected into every route's Lambda. */
    environment?: Record<string, $util.Input<string>>;
    /** SST `link`ables (tables, buckets, secrets) granted to every route. */
    link?: sst.aws.FunctionArgs['link'];
    /**
     * Extra IAM permissions granted to every route, merged with the built-in
     * `execute-api:ManageConnections` (post-back) grant.
     */
    permissions?: sst.aws.FunctionArgs['permissions'];
    /**
     * The route table. Defaults to the SmooAI WebSocket protocol set
     * (`$connect`, `$disconnect`, `send_message`, `ping`, `$default`).
     */
    routes?: RouteSpec[];
    /** Pass-through transform for the underlying `ApiGatewayWebSocket`. */
    transform?: sst.aws.ApiGatewayWebSocketArgs['transform'];
}

/**
 * The default SmooAI WebSocket route table — the schema-driven protocol routes.
 * Non-protocol actions arrive on `$default` (the SDK clients send a JSON
 * envelope with an `action` field) and are dispatched inside the handler.
 */
export const DEFAULT_WEBSOCKET_ROUTES: RouteSpec[] = [
    { routeKey: '$connect', timeout: '30 seconds', memory: '256 MB' },
    { routeKey: '$disconnect', timeout: '30 seconds', memory: '256 MB' },
    { routeKey: 'send_message', timeout: '5 minutes', memory: '1024 MB' },
    { routeKey: 'ping', timeout: '10 seconds', memory: '256 MB' },
    { routeKey: '$default', timeout: '2 minutes', memory: '512 MB' },
];

/** What {@link WebSocketLambdaApi} returns. */
export interface WebSocketLambdaApi {
    /** The underlying API Gateway WebSocket API. */
    api: sst.aws.ApiGatewayWebSocket;
    /** Convenience: the `wss://…` management/connection URL. */
    url: $util.Output<string>;
}

/**
 * Create an API Gateway WebSocket fronting a single (Rust) Lambda, wired across
 * the SmooAI protocol routes.
 */
export function WebSocketLambdaApi(name: string, args: WebSocketLambdaApiArgs): WebSocketLambdaApi {
    const api = new sst.aws.ApiGatewayWebSocket(name, args.transform ? { transform: args.transform } : {});

    const routes = args.routes ?? DEFAULT_WEBSOCKET_ROUTES;
    const permissions: NonNullable<sst.aws.FunctionArgs['permissions']> = [
        // Post events back to the connected client.
        { actions: ['execute-api:ManageConnections'], resources: ['*'] },
        ...((args.permissions as unknown[]) ?? []),
    ] as NonNullable<sst.aws.FunctionArgs['permissions']>;

    for (const r of routes) {
        api.route(r.routeKey, {
            handler: args.handler,
            runtime: args.runtime ?? 'provided.al2023',
            architecture: args.architecture ?? 'arm64',
            timeout: r.timeout,
            memory: r.memory,
            ...(args.environment ? { environment: args.environment } : {}),
            ...(args.link ? { link: args.link } : {}),
            permissions,
        });
    }

    return { api, url: api.url };
}
