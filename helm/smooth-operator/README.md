# `smooth-operator` Helm chart

Reusable Helm chart for a smooth-operator-style WebSocket agent service — an
axum `/ws` server speaking the schema-driven protocol over a smooth-operator
`KnowledgeChatRuntime`, backed by a **pgvector Postgres** (OLTP + checkpoints +
vectors), fronted by an Ingress with WebSocket-friendly settings, and synced by
ArgoCD.

This is the shared chart extracted from `smooth-operator/deploy/k8s` into
[`SmooAI/deploy`](https://github.com/SmooAI/deploy). It is the Kubernetes /
self-host half of the dual SST-(AWS)/k8s plan; the AWS-serverless half is the
`@smooai/deploy` SST constructs in `../../sst`.

```
helm/smooth-operator/
├── Chart.yaml
├── values.yaml
├── templates/
│   ├── _helpers.tpl
│   ├── configmap.yaml      # non-secret env (the SMOOTH_AGENT_* / SMOOAI_GATEWAY_URL contract)
│   ├── secret.yaml         # chart-managed Secret (inline values only; prefer external secrets)
│   ├── deployment.yaml     # the server container; TCP liveness/readiness on the WS port
│   ├── service.yaml        # ClusterIP, port → ws
│   ├── ingress.yaml        # WebSocket annotations + optional TLS
│   ├── hpa.yaml            # optional HPA
│   ├── serviceaccount.yaml
│   └── NOTES.txt
├── argocd/
│   └── application.yaml    # templated ArgoCD Application (automated sync, prune, selfHeal)
└── README.md
```

---

## Consume it

### A) `helm install` directly

```bash
helm lint helm/smooth-operator
helm template smooth-operator helm/smooth-operator

helm upgrade --install smooth-operator helm/smooth-operator \
  --namespace smooai-smooth-operator --create-namespace \
  --set image.repository=ghcr.io/smooai/smooth-operator \
  --set image.tag=0.1.0 \
  --set gateway.keySecretRef.name=smooth-operator-gateway \
  --set database.urlSecretRef.name=smooth-operator-db \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.host=smooth-operator.smoo.ai \
  --set ingress.tls.enabled=true
```

### B) As a dependency / values overlay

A consuming repo (e.g. `smooth-operator`) can ship a **thin values
overlay** and reference this chart as a Helm dependency:

```yaml
# Chart.yaml in the consumer
dependencies:
  - name: smooth-operator
    version: 0.1.x
    repository: file://../../deploy/helm/smooth-operator   # local path dep
    # or an OCI/HTTP repo once published, e.g.
    # repository: oci://ghcr.io/smooai/charts
```

then `helm dependency update` + `helm install` the overlay.

---

## pgvector requirement

The server's Postgres adapter reads `SMOOTH_AGENT_DATABASE_URL` first, then
`DATABASE_URL`. The database **must have the `pgvector` extension available** —
the adapter runs `CREATE EXTENSION IF NOT EXISTS vector;` and creates a
`knowledge_vectors` table with a `vector(N)` column for dense HNSW retrieval
(∪ sparse `tsvector` BM25). A plain Postgres image will fail.

Use a pgvector-enabled Postgres:

- `pgvector/pgvector:pg16` (or `ankane/pgvector`) for a self-managed pod,
- CloudNativePG with the `pgvector` extension enabled,
- AWS RDS / Aurora Postgres with the `pgvector` extension installed.

This chart treats Postgres as **external** (`postgres.external: true`) and does
**not** create a Postgres pod. To spin up a throwaway in-cluster pgvector for
dev, add a Postgres subchart dependency (see the commented note in
`Chart.yaml`) and point a pgvector image in its values.

---

## Secrets

Two secrets feed the server: the **gateway key** (`SMOOAI_GATEWAY_KEY`) and the
**database URL**. Each can be supplied two ways:

### Recommended (prod): reference an existing Secret

```bash
kubectl create secret generic smooth-operator-gateway \
  --namespace smooai-smooth-operator \
  --from-literal=SMOOAI_GATEWAY_KEY="$GATEWAY_KEY"

kubectl create secret generic smooth-operator-db \
  --namespace smooai-smooth-operator \
  --from-literal=DATABASE_URL="postgresql://user:pass@pg-host:5432/smooth?sslmode=require"
```

```yaml
gateway:
  keySecretRef: { name: smooth-operator-gateway, key: SMOOAI_GATEWAY_KEY }
database:
  urlSecretRef: { name: smooth-operator-db, key: DATABASE_URL }
```

### Dev only: inline values

`--set gateway.key=sk-...` and `--set database.url=postgres://...` write a
chart-managed `Secret`. Convenient locally; **don't** commit these.

> The gateway key is **optional at startup**. With no key the server still binds
> and answers protocol-only actions (`ping`, `create_conversation_session`);
> `send_message` returns a clean `error` event.

---

## Ingress / WebSocket notes

Probes are **TCP** on the WS port (`ws`) — a WebSocket upgrade isn't a plain
HTTP GET, so an HTTP probe on `/ws` would 400; a TCP probe just confirms the
listener is up.

`ingress.yaml` ships nginx WebSocket annotations
(`proxy-read-timeout`/`proxy-send-timeout: 3600`, `websocket-services`
auto-filled with the Service name). For **AWS ALB** swap `ingress.annotations`
to the ALB set, matching smooai's api-prime ingress:

```yaml
ingress:
  className: alb
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=3600
    cert-manager.io/cluster-issuer: letsencrypt-prod
```

---

## ArgoCD

`argocd/application.yaml` is a **templated** ArgoCD `Application` (REPLACE_ME
placeholders for repo/path/host/namespace) with automated sync (`prune: true`,
`selfHeal: true`), `CreateNamespace=true`, a sync-wave annotation, and a
retry/backoff — mirroring the smooai api-prime / ArgoCD pattern. Its
`helm.valuesObject` references external secrets, so no credentials live in the
manifest.

```bash
kubectl apply -n argocd -f argocd/application.yaml
```

---

## ⚠️ Server bind follow-up (consumer-side)

The smooth-operator server historically bound `127.0.0.1`, unreachable
from inside the cluster. This chart sets `SMOOTH_AGENT_BIND: "0.0.0.0"` in the
ConfigMap; the server must honor `SMOOTH_AGENT_BIND` (default `127.0.0.1`
locally) for in-cluster traffic to reach the pod. See the consuming repo's
`rust/.../server.rs` for the bind logic.
