# `smooai-next` Helm chart

Reusable Helm chart for the **Kubernetes workload plane** of a containerized
Next.js app — the Next standalone server (`node server.js`) running at scale on
EKS, fronted by a **dedicated internet-facing ALB** that serves as the **custom
origin for a CloudFront distribution**. The CloudFront distribution, the edge
ACM cert, WAF, and public DNS are provisioned **separately** by the
`SmoothNextEdge` SST construct in [`@smooai/deploy`](https://github.com/SmooAI/deploy/tree/main/sst) —
this chart owns the in-cluster half only.

```
                 ┌──────────────┐    HTTPS     ┌────────────────────┐
   public ─────▶ │  CloudFront  │ ───────────▶ │  ALB (this chart)  │ ──▶ pods
                 │ (SmoothNext  │  originHost   │  internet-facing   │   node server.js
                 │  Edge / SST) │               │  group=…           │   :3000
                 └──────────────┘               └────────────────────┘
                       edge half                     workload half (here)
```

This is the Kubernetes / self-host half of the dual SST-(AWS)/k8s plan; the
AWS-serverless edge half is the `@smooai/deploy` SST constructs in `../../sst`.

```
helm/smooai-next/
├── Chart.yaml
├── values.yaml
├── templates/
│   ├── _helpers.tpl
│   ├── deployment.yaml               # node server.js; graceful shutdown; /api/health probes; S3 cache env
│   ├── service.yaml                  # ClusterIP, port → http (3000)
│   ├── hpa.yaml                      # HPA (min/max/cpuTarget)
│   ├── pdb.yaml                      # PodDisruptionBudget (minAvailable)
│   ├── serviceaccount.yaml           # IRSA-annotated ServiceAccount
│   ├── ingress.yaml                  # dedicated internet-facing ALB = the CloudFront origin
│   ├── externalsecret-config.yaml    # app config → envFrom Secret (External Secrets)
│   ├── externalsecret-ghcr.yaml      # private-registry dockerconfigjson pull secret
│   └── NOTES.txt
├── argocd/
│   └── application.yaml              # templated ArgoCD Application (automated sync, prune, selfHeal)
└── README.md
```

---

## Consume it

### A) `helm install` directly

```bash
helm lint helm/smooai-next
helm template smooai-next helm/smooai-next

helm upgrade --install smooai-next helm/smooai-next \
  --namespace smooai-next --create-namespace \
  --set image.repository=ghcr.io/smooai/next-app \
  --set image.tag=0.1.0 \
  --set originHost=next-origin.smoo.ai \
  --set cacheBucketName=smooai-next-cache \
  --set cacheBucketRegion=us-east-1 \
  --set irsaRoleArn=arn:aws:iam::151408561542:role/smooai-next-irsa \
  --set ingress.groupName=smooai-next
```

### B) As a dependency / values overlay

A consuming repo can ship a **thin values overlay** and reference this chart as
a Helm dependency:

```yaml
# Chart.yaml in the consumer
dependencies:
  - name: smooai-next
    version: 0.1.x
    repository: file://../../deploy/helm/smooai-next   # local path dep
    # or an OCI/HTTP repo once published, e.g.
    # repository: oci://ghcr.io/smooai/charts
```

then `helm dependency update` + `helm install` the overlay.

---

## The seam to CloudFront + the Next S3 cacheHandler

This chart deliberately stops at the ALB. The keys that wire it to the edge:

| Value               | What it drives                                                                  |
| ------------------- | ------------------------------------------------------------------------------- |
| `originHost`        | The host the dedicated ALB answers on — CloudFront's custom origin domain.      |
| `cacheBucketName`   | `CACHE_BUCKET_NAME` env → the S3 bucket the Next `cacheHandler` reads/writes.    |
| `cacheBucketRegion` | `CACHE_BUCKET_REGION` env for the same.                                          |
| `irsaRoleArn`       | IAM role annotated on the ServiceAccount; the pod assumes it for S3 cache I/O.  |

The CloudFront distribution, the bucket itself, and the IAM role are provisioned
**out-of-band** (the `SmoothNextEdge` SST construct / your infra). This chart
only consumes their names. ACM at the ALB is **auto-discovered by host** — no
`certificate-arn` annotation to copy or maintain.

---

## Graceful shutdown (zero-downtime rollouts)

On rollout/scale-down the kubelet sends `SIGTERM` and starts the
`terminationGracePeriodSeconds` clock. A pod removed from a Service endpoint is
**not** instantly removed from the ALB target group, so the container must keep
serving until the ALB finishes deregistering it. The chart's `lifecycle.preStop`
sleeps `gracefulShutdown.preStopSleepSeconds` (default 10s) before the process
exits, and the grace period (default 30s) is sized to cover that plus drain.
Result: a rollout drops **zero** in-flight requests.

---

## Health

Both probes and the ALB healthcheck hit `healthPath` (default `/api/health`).
Point this at a **dependency-free** route that reflects only "the Next process
is up and serving" (no DB / config calls) so a transient backend blip doesn't
flap pods out of the ALB.

---

## Pod hardening

Non-root (`runAsNonRoot`, uid/gid 1000), `seccompProfile: RuntimeDefault`, all
capabilities dropped, no privilege escalation. **`readOnlyRootFilesystem` is
`false`** on purpose — Next writes `.next/cache` at runtime, so a read-only root
FS would break it.

---

## Secrets (External Secrets Operator)

Two `external-secrets.io/v1beta1` ExternalSecrets, both fully parameterized
(no app-specific keys hardcoded):

### App config — `config.externalSecret`

Syncs secret-tier config from a `ClusterSecretStore` into a Secret that the
Deployment `envFrom`'s. Map `{envVar -> remote key}`:

```yaml
config:
  externalSecret:
    enabled: true
    name: next-config-eso
    secretStoreRef: { kind: ClusterSecretStore, name: smooai-config }
    data:
      SMOOAI_CONFIG_CLIENT_ID: smooaiM2mClientId
      SMOOAI_CONFIG_CLIENT_SECRET: smooaiM2mClientSecret
```

### Private-registry pull secret — `ghcr.externalSecret`

Renders a `kubernetes.io/dockerconfigjson` Secret from a synced token (auth =
`base64(username:token)`) via an ESO v2 template, wired as `imagePullSecrets`:

```yaml
ghcr:
  externalSecret:
    enabled: true
    name: ghcr-pull-secret
    secretStoreRef: { kind: ClusterSecretStore, name: smooai-config }
    registry: ghcr.io
    username: smooai-bot
    tokenRemoteKey: ghcrPullToken
```

Disable either (`enabled: false`) if you manage the Secret yourself.

---

## Ingress / ALB

A single **dedicated** ALB (`ingress.groupName`) so CloudFront can point at it
specifically. `scheme: internet-facing`, `target-type: ip` (pods directly),
HTTPS:443 with the ACM cert auto-discovered by `originHost`, and an ALB
healthcheck on `healthPath`. Add WAF / access-log annotations via
`ingress.extraAnnotations`.

---

## ArgoCD

`argocd/application.yaml` is a **templated** ArgoCD `Application` (REPLACE_ME
placeholders for repo/path/host/namespace) with automated sync (`prune: true`,
`selfHeal: true`), `CreateNamespace=true`, a sync-wave annotation, and a
retry/backoff. Its `helm.valuesObject` references External Secrets, so no
credentials live in the manifest.

```bash
kubectl apply -n argocd -f argocd/application.yaml
```

---

MIT-licensed (see repo `LICENSE`). Portable: no namespaces, hostnames, ARNs, or
bucket names are hardcoded — everything flows through values.
