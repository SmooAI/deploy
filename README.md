# SmooAI `deploy` — shared deploy primitives

Reusable deploy building blocks for SmooAI services, extracted from
[`smooth-operator/deploy`](https://github.com/SmooAI/smooth-operator).
Two surfaces, one per deploy path:

| Surface | Path | What it is |
| --- | --- | --- |
| **SST v4 constructs** | [`sst/`](sst) — npm `@smooai/deploy` | API Gateway WebSocket + (Rust) Lambda + DynamoDB single-table + S3 blob bucket + S3 Vectors placeholder + secret + IAM links, as parameterized SST components. |
| **Helm chart + ArgoCD** | [`helm/smooth-agent/`](helm/smooth-agent) | The Kubernetes / self-host chart: axum `/ws` server + pgvector Postgres + WebSocket Ingress, with a templated ArgoCD `Application`. |

**Two consumers** justify the shared package:

1. [`smooth-operator`](https://github.com/SmooAI/smooth-operator) —
   the reference WebSocket agent service (consumes both surfaces today).
2. The **smooai monorepo** — dogfoods the SST constructs piecemeal once proven.

See [`docs/`](docs) for how each consumer wires it up.

---

## SST constructs (`@smooai/deploy`)

```ts
// consumer's sst.config.ts (inside run())
import { SmoothAgentApi } from '@smooai/deploy';

const agent = SmoothAgentApi('SmoothAgent', {
    artifactDir: '../../rust/target/lambda/smooai-smooth-operator-lambda',
    model: 'claude-haiku-4-5',
});
return agent.outputs;
```

Smaller building blocks (`WebSocketLambdaApi`, `DynamoSingleTable`) are exported
too, so smooai can adopt them independently. The constructs reference SST's
ambient `$`-globals, so they must be imported from inside an SST app's `run()`.

> These are **constructs**, not a deployable app. The `sst/sst.config.ts` in
> this repo exists only so `sst install` can generate the platform types the
> constructs typecheck against — it is never deployed.

### Verify (no AWS, no deploy)

```bash
cd sst
pnpm install
pnpm sst install      # generates .sst/platform types (no AWS creds)
npx tsc --noEmit
```

## Helm chart (`smooth-agent`)

```bash
helm lint helm/smooth-agent
helm template smooth-agent helm/smooth-agent
helm upgrade --install smooth-agent helm/smooth-agent \
  --namespace smooai-smooth-agent --create-namespace \
  --set image.tag=0.1.0 \
  --set gateway.keySecretRef.name=smooth-agent-gateway \
  --set database.urlSecretRef.name=smooth-agent-db
```

See [`helm/smooth-agent/README.md`](helm/smooth-agent/README.md) for the
pgvector requirement, secret wiring, WebSocket/Ingress notes, and ArgoCD.

---

## Publishing follow-up

`@smooai/deploy` is consumed today via a **path dep**
(`"@smooai/deploy": "file:../../deploy/sst"`) for local development. The
follow-up is to **publish `@smooai/deploy` to npm** (and the chart to an OCI/HTTP
Helm repo) so consumers pin a version instead of a sibling-checkout path. See
[`docs/Consuming.md`](docs/Consuming.md#publish-follow-up).

## License

[MIT](LICENSE) © Smoo AI.
