/**
 * `@smooai/deploy` — shared SmooAI deploy primitives (SST v4 constructs).
 *
 * These are reusable SST components factored out of
 * `smooth-operator-agent/deploy/sst/sst.config.ts`. They reference SST's
 * ambient `$`-globals (`sst.aws.*`, `$interpolate`, `$app`, …), so they must be
 * imported from inside an SST app's `run()` (where those globals exist). The
 * package ships no runtime entry point of its own — it is a construct library.
 *
 * Consumers:
 *  - `smooth-operator-agent/deploy/sst` (path/npm dep) — `new SmoothAgentApi(...)`.
 *  - `smooai` monorepo (dogfood) — adopts the smaller building blocks piecemeal.
 *
 * See `docs/` for consumption details.
 */

export { SmoothAgentApi, type SmoothAgentApiArgs, type SmoothAgentApiOutputs } from './components/smooth-agent-api';

export {
    WebSocketLambdaApi,
    DEFAULT_WEBSOCKET_ROUTES,
    type WebSocketLambdaApiArgs,
    type WebSocketLambdaApi as WebSocketLambdaApiResult,
    type RouteSpec,
    type RouteTimeout,
    type RouteMemory,
} from './components/websocket-lambda-api';

export {
    DynamoSingleTable,
    SMOOTH_AGENT_TABLE_FIELDS,
    type DynamoSingleTableArgs,
} from './components/dynamo-single-table';
