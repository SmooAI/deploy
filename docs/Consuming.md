# Consuming `@smooai/deploy`

How the two consumers — `smooth-operator` and the `smooai` monorepo — wire
up the shared deploy primitives.

---

## 1. SST constructs (`@smooai/deploy`)

### What it exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `new SmoothAgentApi(name, args)` | composite (class) | Full serverless backend: API GW WebSocket + (Rust) Lambda routes + DynamoDB single-table + S3 blob bucket + S3 Vectors env wiring + gateway secret + IAM links. |
| `WebSocketLambdaApi(name, args)` | building block | API GW WebSocket fronting one Lambda across the SmooAI protocol routes; grants `execute-api:ManageConnections` for post-back. |
| `DynamoSingleTable(name, args)` | building block | `sst.aws.Dynamo` with the overloaded `pk`/`sk` + all-projecting `gsi1` GSI + `ttl` design the adapter expects. |

`SmoothAgentApiArgs` (the composite's knobs):

```ts
interface SmoothAgentApiArgs {
    artifactDir: string;          // REQUIRED — cargo-lambda output dir (holds `bootstrap`)
    model?: string;               // default 'claude-haiku-4-5'
    gatewayUrl?: string;          // default 'https://llm.smoo.ai/v1'
    orgId?: string;               // default 'default'
    maxIterations?: number;       // default 6
    maxTokens?: number;           // default 512
    vectorIndexPrefix?: string;   // default 'smooth-agent-knowledge'
    routes?: RouteSpec[];         // default: $connect/$disconnect/send_message/ping/$default
    extraEnvironment?: Record<string, $util.Input<string>>;
}
```

It returns `{ api, table, blobs, gatewayKey, outputs }`. Return `agent.outputs`
from your SST `run()`.

### Importing it

The constructs reference SST's ambient `$`-globals (`sst.aws.*`,
`$interpolate`, `$app`), so they only resolve **inside an SST app's `run()`**.
Import there, not at module top-level if your SST version is strict about it:

```ts
/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
    app(input) {
        return { name: 'smooth-operator', home: 'aws', /* … */ };
    },
    async run() {
        const { SmoothAgentApi } = await import('@smooai/deploy');
        const agent = new SmoothAgentApi('SmoothAgent', {
            artifactDir: '../../rust/target/lambda/smooai-smooth-operator-lambda',
        });
        return agent.outputs;
    },
});
```

> A top-level `import { SmoothAgentApi } from '@smooai/deploy'` also works under
> SST v4 (the bundler hoists it). smooth-operator uses the top-level form;
> the smooai monorepo uses `await import()` inside `run()` to match its
> "no top-level imports in sst.config.ts" convention.

### Wiring the dependency

**Local / path dep (today):**

```jsonc
// consumer deploy/sst/package.json
{
  "dependencies": { "@smooai/deploy": "file:../../deploy/sst" }
}
```

This resolves to a sibling checkout (`~/dev/smooai/deploy`), matching the
standard layout. Run `pnpm install` in the consumer's `deploy/sst`.

**Published (follow-up):** see [Publish follow-up](#publish-follow-up).

---

## 2. Helm chart (`smooth-operator`)

The chart is self-contained and reusable. Consumers pick one of:

### A) `helm install` the chart directly

Point at this repo's `helm/smooth-operator` (or a published OCI/HTTP repo) and pass
a values overlay / `--set`s. See
[`helm/smooth-operator/README.md`](../helm/smooth-operator/README.md).

### B) Thin values overlay as a chart dependency

A consumer ships a tiny `Chart.yaml` declaring this chart as a dependency and a
`values.yaml` with only the per-env overrides:

```yaml
# consumer/deploy/k8s/Chart.yaml
apiVersion: v2
name: smooth-operator
version: 0.1.0
dependencies:
  - name: smooth-operator
    version: 0.1.x
    repository: file://../../../deploy/helm/smooth-operator   # local path dep
    # or, once published:
    # repository: oci://ghcr.io/smooai/charts
```

```yaml
# consumer/deploy/k8s/values.yaml  (overrides nested under the subchart name)
smooth-operator:
  image:
    repository: ghcr.io/smooai/smooth-operator
    tag: "0.1.0"
  gateway:
    keySecretRef: { name: smooth-operator-gateway, key: SMOOAI_GATEWAY_KEY }
  database:
    urlSecretRef: { name: smooth-operator-db, key: DATABASE_URL }
  ingress:
    enabled: true
    className: nginx
    host: smooth-operator.smoo.ai
```

then `helm dependency update consumer/deploy/k8s && helm install ...`.

### ArgoCD

`helm/smooth-operator/argocd/application.yaml` is a **templated** `Application`
(REPLACE_ME placeholders for repo/path/host/namespace). Point `source.repoURL`
+ `source.path` at either this repo (`SmooAI/deploy`, `helm/smooth-operator`) or
your overlay repo, fill the `valuesObject` overrides, and `kubectl apply -n
argocd -f`.

---

## Publish follow-up

Today both surfaces are consumed via **local path deps** (sibling checkout):

- SST: `"@smooai/deploy": "file:../../deploy/sst"`
- Helm: `repository: file://../../deploy/helm/smooth-operator`

To decouple consumers from a sibling checkout:

1. **npm-publish `@smooai/deploy`** (the `sst/` package — it already has
   `publishConfig.access: public`, `files: ["src"]`, MIT license, peer-dep on
   `sst`). Then consumers pin `"@smooai/deploy": "^0.1.0"` instead of `file:`.
   - Decide whether to ship raw TS (SST bundles consumer configs, so `main`/
     `types` pointing at `src/*.ts` is workable) or pre-built `.js`/`.d.ts`.
     Raw-TS keeps the build trivial; a `tsc` build step is the safer npm norm.
2. **Publish the `smooth-operator` chart** to an OCI registry
   (`oci://ghcr.io/smooai/charts`) or an HTTP Helm repo, so dependency
   `repository:` can be a real URL and consumers `helm dependency update` from
   a versioned source.
3. Update the consumers' `package.json` / `Chart.yaml` to the published
   coordinates and drop the `file:`/`file://` path deps.
