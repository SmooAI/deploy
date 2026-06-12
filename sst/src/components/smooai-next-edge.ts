/**
 * `SmooaiNextEdge` — the AWS edge + cache plane for a containerized Next.js app
 * running on EKS (or any HTTPS origin) at scale.
 *
 * This is the construct that fronts a Next.js workload with CloudFront, fixes
 * the framework's edge-cache footguns, and provisions the shared S3 cache store
 * + the IRSA role the pods use to read/write it. It is the AWS half of a
 * two-plane deploy: this construct owns the *edge + cache* plane, and a Helm
 * chart (the k8s plane) owns the pods. The two planes meet at two seams:
 *
 *   1. `originHost` — the stable host the EKS ALB is exposed at. CloudFront's
 *      origin. The chart guarantees the ALB answers on this host; this construct
 *      points the distribution at `https://${originHost}`. Because it's a stable
 *      name (a CNAME the chart manages, not the ALB's churny AWS DNS name), the
 *      ALB can be recreated without touching the distribution.
 *   2. {@link SmooaiNextEdgeOutputs} — the `outputs` getter. The Helm chart
 *      consumes `cacheBucketName` (env into the cacheHandler), `irsaRoleArn`
 *      (the service-account annotation), and `distributionId` (the rollout's
 *      `cloudfront create-invalidation`). These names are the contract — do not
 *      rename them without updating the chart.
 *
 * ## Why a raw `aws.cloudfront.Distribution` (not `sst.aws.Router`)
 * `sst.aws.Router` is the right tool when you only need path → origin routing,
 * but it can't express the cache policy this plane needs:
 *
 *   - a **capped MaxTTL** on the default (HTML) behavior — the actual fix for
 *     Next.js emitting a bogus year-long `s-maxage` on SSR/ISR responses. We
 *     override it at the edge so a single stale render can't pin for a year.
 *   - **Origin Shield** on the origin (one regional cache layer in front of the
 *     pods, so N edge POPs collapse to one origin fetch on a cold key).
 *   - distinct **immutable long-cache** vs **edge-cached image** vs
 *     **auth-bypassing HTML** behaviors with per-path cache + origin-request
 *     policies.
 *
 * So we drop to the raw distribution. DNS (claiming `domain` + `aliases`) is
 * still pluggable via the {@link SmooaiNextEdgeArgs.dns} adapter so a consumer
 * can hand us `sst.cloudflare.dns(...)` (or manage records themselves).
 *
 * ## Portability
 * Nothing here is SmooAI-specific: no `@smooai/config`, no hardcoded account ids,
 * no SST-managed cluster coupling. The IRSA role trusts whatever OIDC provider
 * the consumer passes (`oidcProviderArn` / `oidcProviderUrl`), so the construct
 * works against any EKS cluster — the consumer wires their own cluster's OIDC.
 */

/** us-east-1 — CloudFront viewer certs (ACM) must live here. */
const CLOUDFRONT_ACM_REGION = 'us-east-1';

/**
 * AWS-managed origin-request policy `Managed-AllViewerExceptHostHeader` — forwards
 * all viewer headers, cookies, and query strings to the origin EXCEPT `Host`, so
 * CloudFront sends the origin's own host. The canonical policy for an ALB origin
 * that routes by a fixed host (the default for {@link SmooaiNextEdge}). This id is
 * stable across all AWS accounts/regions.
 */
const MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

/** One year, in seconds — the immutable-asset cache ceiling. */
const ONE_YEAR_SECONDS = 31_536_000;

/**
 * The minimal SST DNS-adapter surface this construct uses to claim public hosts.
 * Declared structurally (rather than importing SST's internal `Dns` union, which
 * isn't exposed under the ambient `sst.*` namespace) so any SST DNS adapter
 * satisfies it — `sst.cloudflare.dns(...)`, `sst.aws.dns(...)`, etc. — without
 * coupling to an un-exposed platform type.
 */
export interface DnsAdapter {
    /**
     * DNS provider id (`'cloudflare'` | `'aws'` | `'vercel'`). Used to decide
     * whether ACM needs CAA records: a non-Route53 zone must publish a
     * `CAA … issue "amazonaws.com"` record or DNS validation can be refused.
     */
    provider?: string;
    createAlias(
        namePrefix: string,
        record: { name: $util.Input<string>; aliasName: $util.Input<string>; aliasZone: $util.Input<string> },
        opts: Record<string, never>,
    ): unknown;
    /**
     * Create a generic DNS record. Used here to publish the ACM DNS-validation
     * CNAMEs so the us-east-1 viewer cert issues automatically. SST's
     * `sst.cloudflare.dns()` / `sst.aws.dns()` adapters provide this. When
     * absent, the construct leaves cert validation to the consumer (manual) and
     * references the raw (PENDING) cert ARN — only safe if you validate it
     * out-of-band before the distribution is created.
     */
    createRecord?(
        namePrefix: string,
        record: { type: $util.Input<string>; name: $util.Input<string>; value: $util.Input<string> },
        opts: $util.ComponentResourceOptions,
    ): $util.Output<$util.Resource>;
    /**
     * Create the CAA records authorizing ACM (`amazonaws.com`) to issue for the
     * domain — needed when the zone isn't on Route 53. Returns the created
     * records so the validation records can depend on them.
     */
    createCaa?(namePrefix: string, recordName: $util.Input<string>, opts: $util.ComponentResourceOptions): $util.Resource[] | $util.Output<$util.Resource>[] | undefined;
}

/** Tunables for {@link SmooaiNextEdge}. */
export interface SmooaiNextEdgeArgs {
    /**
     * The primary public host this edge serves (e.g. `app.example.com`). Used
     * as the CloudFront viewer-cert subject and the first alias.
     */
    domain: string;
    /** Additional public hosts (e.g. `www.app.example.com`). */
    aliases?: string[];
    /**
     * The stable host the EKS ALB is exposed at — CloudFront's origin and the
     * contract to the k8s plane. e.g. `web-origin.example.com`. Fronted over
     * HTTPS (auth cookies — never plain HTTP).
     */
    originHost: string;
    /**
     * Pluggable DNS adapter for claiming `domain` + `aliases`. Pass
     * `sst.cloudflare.dns({ proxy: true })` (or another SST DNS adapter) to have
     * SST create the records. Leave undefined to manage DNS yourself — the
     * distribution still gets the aliases + cert, you just point them by hand.
     */
    dns?: DnsAdapter;

    // ── IRSA / OIDC (the k8s-plane trust seam) ──────────────────────────────
    /** ARN of the EKS cluster's IAM OIDC provider the pods federate through. */
    oidcProviderArn: $util.Input<string>;
    /**
     * URL of the EKS cluster's OIDC issuer (no scheme prefix in the condition
     * key — e.g. `oidc.eks.us-east-1.amazonaws.com/id/ABC…`).
     */
    oidcProviderUrl: $util.Input<string>;
    /** Kubernetes namespace of the web service account. */
    serviceAccountNamespace: string;
    /** Kubernetes service-account name the web pods run as. */
    serviceAccountName: string;
    /**
     * Optional FIXED physical name for the IRSA role, so the ARN is stable and
     * predictable (`…:role/<roleName>`) instead of a Pulumi hash. Lets a Helm
     * chart that can't read Pulumi outputs annotate the service account with a
     * known ARN. Omit to keep Pulumi auto-naming.
     */
    irsaRoleName?: string;
    /**
     * Extra IAM statements to attach to the IRSA role, beyond the Next.js cache
     * bucket grant this construct always adds. Use this for a brownfield app
     * whose pods need *other* AWS access on the same role (e.g. a Payload CMS
     * media bucket) — pass those statements here and you keep a single role
     * instead of juggling two. Each entry is a standard IAM policy Statement.
     */
    extraInlinePolicy?: aws.types.input.iam.PolicyDocument['Statement'];

    // ── Cache-policy knobs (sensible defaults) ──────────────────────────────
    /**
     * MaxTTL (seconds) for the default HTML behavior — the **edge cap** that
     * overrides Next.js's bogus long `s-maxage`. Defaults to `300` (5 min).
     */
    htmlMaxTtl?: number;
    /**
     * DefaultTTL (seconds) for the default HTML behavior, applied when the
     * origin sends no cache headers. Defaults to `0` (treat uncached HTML as
     * dynamic unless the origin says otherwise).
     */
    htmlDefaultTtl?: number;
    /**
     * MaxTTL (seconds) for `/_next/image*` optimized images. Defaults to
     * `86_400` (1 day) — long enough to offload per-pod image optimization,
     * short enough to pick up source-image changes.
     */
    imageMaxTtl?: number;
    /**
     * Number of days to retain objects in the S3 cache bucket before expiry.
     * The Next.js shared cacheHandler rewrites live entries on every
     * revalidation, so only dead build-id prefixes age out. Defaults to `14`.
     */
    cacheBucketExpireDays?: number;
    /** Enable Origin Shield on the origin. Defaults to `true`. */
    originShield?: boolean;
    /**
     * Origin Shield region. Defaults to `us-east-1`. Set to the region closest
     * to your EKS cluster for the best collapse ratio.
     */
    originShieldRegion?: string;
    /**
     * Whether to forward the **viewer** `Host` header to the origin on the
     * dynamic (default) behavior.
     *
     * Defaults to `false` — CloudFront sends the **origin's** host
     * ({@link originHost}) as `Host`. This is the correct default for an EKS ALB
     * origin: the ALB Ingress routes by a fixed origin host (e.g. an Ingress
     * rule `host: web-origin.example.com`), so forwarding the viewer host
     * (`app.example.com`) would miss every rule and the ALB returns 404. With
     * the default, the ALB sees its expected host and routes to the pods; the
     * app sees the origin host (use relative URLs / `x-forwarded-*` for the
     * public host). Internally this uses the AWS-managed
     * `Managed-AllViewerExceptHostHeader` origin-request policy (still forwards
     * all cookies, auth headers, and query strings — just not `Host`).
     *
     * Set `true` only if your origin is host-agnostic (catch-all) or your app
     * genuinely needs the viewer `Host` (and your origin won't 404 on it).
     */
    forwardViewerHost?: boolean;
    /** CloudFront price class. Defaults to `'PriceClass_100'` (NA + EU). */
    priceClass?: 'PriceClass_All' | 'PriceClass_200' | 'PriceClass_100';
    /** Pass-through `$transform`/component options for the distribution. */
    transform?: aws.cloudfront.DistributionArgs;
}

/**
 * The seam the Helm chart consumes. **Do not rename these fields** — the k8s
 * plane reads them by exact name.
 */
export interface SmooaiNextEdgeOutputs {
    /** S3 bucket name for the Next.js shared cacheHandler store. */
    cacheBucketName: $util.Output<string>;
    /** ARN of the IRSA role the web pods assume (S3 cache access). */
    irsaRoleArn: $util.Output<string>;
    /** CloudFront distribution id — for `cloudfront create-invalidation`. */
    distributionId: $util.Output<string>;
    /** Public URL the edge serves (`https://<domain>`). */
    url: $util.Output<string>;
    /** The stable ALB-origin host the distribution points at (echoed back). */
    originHost: string;
}

/**
 * Provision the AWS edge + cache plane for a containerized Next.js app on EKS.
 *
 * Authored as a class so consumers use the SST-component `new` form
 * (`new SmooaiNextEdge('WebEdge', { … })`) and can read the sub-resources
 * (`.distribution`, `.cacheBucket`, `.irsaRole`) or return `.outputs` from
 * `run()`.
 *
 * @example
 *   const edge = new SmooaiNextEdge('WebEdge', {
 *       domain: 'app.example.com',
 *       aliases: ['www.app.example.com'],
 *       originHost: 'web-origin.example.com',
 *       dns: sst.cloudflare.dns({ proxy: true }),
 *       oidcProviderArn: cluster.core.oidcProvider.apply((p) => p.arn),
 *       oidcProviderUrl: cluster.core.oidcProvider.apply((p) => p.url),
 *       serviceAccountNamespace: 'web',
 *       serviceAccountName: 'web',
 *       irsaRoleName: 'web-edge-irsa',
 *   });
 *   return edge.outputs;
 */
export class SmooaiNextEdge {
    /** The CloudFront distribution (the edge). */
    readonly distribution: aws.cloudfront.Distribution;
    /** The S3 cache bucket (Next.js shared cacheHandler store). */
    readonly cacheBucket: sst.aws.Bucket;
    /** The IRSA role the web pods assume for S3 cache access. */
    readonly irsaRole: aws.iam.Role;
    /** The us-east-1 ACM viewer certificate. */
    readonly certificate: aws.acm.Certificate;
    /** The seam the Helm chart consumes. */
    readonly outputs: SmooaiNextEdgeOutputs;

    constructor(name: string, args: SmooaiNextEdgeArgs) {
        const {
            domain,
            aliases = [],
            originHost,
            htmlMaxTtl = 300,
            htmlDefaultTtl = 0,
            imageMaxTtl = 86_400,
            cacheBucketExpireDays = 14,
            originShield = true,
            originShieldRegion = 'us-east-1',
            priceClass = 'PriceClass_100',
            forwardViewerHost = false,
        } = args;

        const allHosts = [domain, ...aliases];

        // ── S3 cache bucket + 14-day lifecycle ─────────────────────────────
        // The Next.js shared cacheHandler reads/writes ISR/SSG/fetch entries
        // here so every pod sees one consistent cache that survives restarts.
        // Live entries are rewritten on each revalidation, so only dead
        // build-id prefixes age out; worst case on expiry is a cache miss →
        // regeneration, never incorrectness.
        const cacheBucket = new sst.aws.Bucket(`${name}CacheBucket`);

        new aws.s3.BucketLifecycleConfigurationV2(`${name}CacheBucketLifecycle`, {
            bucket: cacheBucket.name,
            rules: [
                {
                    id: 'abort-incomplete-multipart-uploads',
                    status: 'Enabled',
                    filter: { prefix: '' },
                    abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
                },
                {
                    id: 'expire-stale-cache-objects',
                    status: 'Enabled',
                    filter: { prefix: '' },
                    expiration: { days: cacheBucketExpireDays },
                },
            ],
        });

        // ── IRSA role (the k8s-plane trust seam) ───────────────────────────
        // Trusts the consumer's EKS OIDC provider for the given service
        // account — NO coupling to an SST-managed cluster. Mirrors the standard
        // `sts:AssumeRoleWithWebIdentity` IRSA shape; the federated principal is
        // the passed OIDC provider rather than a cluster handle.
        const assumeRolePolicy = $util
            .all([args.oidcProviderArn, args.oidcProviderUrl])
            .apply(([arn, url]: [string, string]) =>
                JSON.stringify({
                    Version: '2012-10-17',
                    Statement: [
                        {
                            Effect: 'Allow',
                            Principal: { Federated: arn },
                            Action: 'sts:AssumeRoleWithWebIdentity',
                            Condition: {
                                StringEquals: {
                                    [`${url}:aud`]: 'sts.amazonaws.com',
                                    [`${url}:sub`]: `system:serviceaccount:${args.serviceAccountNamespace}:${args.serviceAccountName}`,
                                },
                            },
                        },
                    ],
                }),
            );

        const irsaRole = new aws.iam.Role(`${name}Irsa`, {
            ...(args.irsaRoleName ? { name: args.irsaRoleName } : {}),
            assumeRolePolicy,
            description: `IRSA role for ${args.serviceAccountNamespace}/${args.serviceAccountName} (SmooaiNextEdge cache)`,
        });

        // Inline policy: read/write the Next.js shared cache bucket via the
        // default-provider-chain (IRSA) creds — no keys in the container.
        new aws.iam.RolePolicy(`${name}IrsaCachePolicy`, {
            role: irsaRole.name,
            policy: cacheBucket.arn.apply((bucketArn) =>
                JSON.stringify({
                    Version: '2012-10-17',
                    Statement: [
                        {
                            Sid: 'NextSharedCacheReadWrite',
                            Effect: 'Allow',
                            Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
                            Resource: [bucketArn, `${bucketArn}/*`],
                        },
                    ],
                }),
            ),
        });

        // Optional extra grants for a brownfield app sharing this role (e.g.
        // Payload media S3). Attached as a separate inline policy so it composes
        // cleanly with the cache grant above.
        if (args.extraInlinePolicy) {
            new aws.iam.RolePolicy(`${name}IrsaExtraPolicy`, {
                role: irsaRole.name,
                policy: JSON.stringify({ Version: '2012-10-17', Statement: args.extraInlinePolicy }),
            });
        }

        // ── us-east-1 ACM viewer certificate ───────────────────────────────
        // CloudFront viewer certs must be in us-east-1. We create a dedicated
        // provider pinned to that region so the construct works regardless of
        // the app's home region. DNS validation is left to the consumer's `dns`
        // adapter (or manual) — same pluggable-DNS contract as the distribution.
        const usEast1 = new aws.Provider(`${name}UsEast1`, { region: CLOUDFRONT_ACM_REGION });

        const certificate = new aws.acm.Certificate(
            `${name}Cert`,
            {
                domainName: domain,
                ...(aliases.length > 0 ? { subjectAlternativeNames: aliases } : {}),
                validationMethod: 'DNS',
            },
            { provider: usEast1 },
        );

        // Auto-issue the viewer cert when the DNS adapter can create records:
        // publish the ACM DNS-validation CNAMEs (+ a CAA for non-Route53 zones)
        // and gate on an `aws.acm.CertificateValidation` so the cert is ISSUED
        // before CloudFront tries to attach it. Without this gate the deploy
        // fails — CloudFront rejects a PENDING_VALIDATION cert. The validation
        // CNAMEs must NOT be proxied; SST's cloudflare adapter only proxies
        // alias records, so `createRecord` here stays grey-cloud as ACM needs.
        // No `createRecord` on the adapter (or no adapter) → manual validation:
        // reference the raw cert ARN (the consumer must validate out-of-band).
        let viewerCertificateArn: $util.Output<string> = certificate.arn;
        if (args.dns?.createRecord) {
            const dns = args.dns;
            const validationRecords = $util.all([certificate.domainValidationOptions]).apply(([options]) => {
                // De-dup: a domain + its SANs frequently share one CNAME.
                const seen: string[] = [];
                const unique = options.filter((option) => {
                    const key = option.resourceRecordType + option.resourceRecordName;
                    if (seen.includes(key)) return false;
                    seen.push(key);
                    return true;
                });
                const caaRecords = dns.provider !== 'aws' && dns.createCaa ? dns.createCaa(`${name}Cert`, domain, {}) : undefined;
                return unique.map((option) =>
                    dns.createRecord!(
                        `${name}Cert`,
                        { type: option.resourceRecordType, name: option.resourceRecordName, value: option.resourceRecordValue },
                        { dependsOn: caaRecords ? [...caaRecords] : [] },
                    ),
                );
            });

            const certificateValidation = new aws.acm.CertificateValidation(
                `${name}CertValidation`,
                { certificateArn: certificate.arn },
                { provider: usEast1, dependsOn: validationRecords },
            );
            viewerCertificateArn = certificateValidation.certificateArn;
        }

        // ── Cache + origin-request policies ────────────────────────────────
        // Immutable assets: cache hard, forward nothing (no cookies/headers/qs).
        const immutablePolicy = new aws.cloudfront.CachePolicy(`${name}ImmutablePolicy`, {
            name: $interpolate`${$app.name}-${$app.stage}-${name}-immutable`,
            defaultTtl: ONE_YEAR_SECONDS,
            maxTtl: ONE_YEAR_SECONDS,
            minTtl: ONE_YEAR_SECONDS,
            parametersInCacheKeyAndForwardedToOrigin: {
                cookiesConfig: { cookieBehavior: 'none' },
                headersConfig: { headerBehavior: 'none' },
                queryStringsConfig: { queryStringBehavior: 'none' },
                enableAcceptEncodingGzip: true,
                enableAcceptEncodingBrotli: true,
            },
        });

        // Optimized images: edge-cache to offload per-pod optimization; key on
        // the query string (the image url/width/quality live there).
        const imagePolicy = new aws.cloudfront.CachePolicy(`${name}ImagePolicy`, {
            name: $interpolate`${$app.name}-${$app.stage}-${name}-image`,
            defaultTtl: imageMaxTtl,
            maxTtl: imageMaxTtl,
            minTtl: 0,
            parametersInCacheKeyAndForwardedToOrigin: {
                cookiesConfig: { cookieBehavior: 'none' },
                headersConfig: { headerBehavior: 'whitelist', headers: { items: ['Accept'] } },
                queryStringsConfig: { queryStringBehavior: 'all' },
                enableAcceptEncodingGzip: true,
                enableAcceptEncodingBrotli: true,
            },
        });

        // Default HTML: the bogus-`s-maxage` fix. CAPPED maxTtl overrides Next's
        // year-long s-maxage at the edge. Cache key includes all cookies/qs so
        // authenticated pages get their own (effectively uncached, per-session)
        // entries rather than serving one user's HTML to another.
        //
        // CRITICAL for Next.js App Router: the cache key MUST include the RSC
        // request headers. Next serves the SAME URL as both the HTML document
        // (no `RSC` header) and the React Server Component / Flight payload
        // (`RSC: 1`, prefetch, router-state-tree, next-url). With these NOT in
        // the cache key the two responses collide — a cached RSC/Flight payload
        // gets served for a document request, so the page renders as raw text
        // (`1:"$Sreact.fragment"…`) and the app never hydrates (forms dead,
        // sign-in "does nothing"). Whitelisting them gives the document and each
        // RSC variant distinct cache entries. (Matches OpenNext / sst.aws.Nextjs.)
        const htmlPolicy = new aws.cloudfront.CachePolicy(`${name}HtmlPolicy`, {
            name: $interpolate`${$app.name}-${$app.stage}-${name}-html`,
            defaultTtl: htmlDefaultTtl,
            maxTtl: htmlMaxTtl,
            minTtl: 0,
            parametersInCacheKeyAndForwardedToOrigin: {
                cookiesConfig: { cookieBehavior: 'all' },
                headersConfig: { headerBehavior: 'whitelist', headers: { items: ['RSC', 'Next-Router-Prefetch', 'Next-Router-State-Tree', 'Next-Url'] } },
                queryStringsConfig: { queryStringBehavior: 'all' },
                enableAcceptEncodingGzip: true,
                enableAcceptEncodingBrotli: true,
            },
        });

        // Origin-request policy for the dynamic (default) behavior.
        //
        // Default (`forwardViewerHost: false`): the AWS-managed
        // `Managed-AllViewerExceptHostHeader` — forwards all cookies, auth
        // headers, and query strings, but NOT `Host`, so CloudFront sends the
        // ORIGIN's host. Required for an EKS ALB origin whose Ingress routes by a
        // fixed host: forwarding the viewer host (e.g. `app.example.com`) misses
        // every Ingress rule and the ALB returns 404. SSR still sees the full
        // request (cookies/auth/qs) so authenticated pages render / bypass cache.
        //
        // Opt-in (`forwardViewerHost: true`): a custom policy that forwards the
        // viewer host too — only for host-agnostic origins or apps that need it.
        const allViewerPolicy = forwardViewerHost
            ? new aws.cloudfront.OriginRequestPolicy(`${name}AllViewerPolicy`, {
                  name: $interpolate`${$app.name}-${$app.stage}-${name}-all-viewer`,
                  cookiesConfig: { cookieBehavior: 'all' },
                  headersConfig: { headerBehavior: 'allViewerAndWhitelistCloudFront', headers: { items: ['CloudFront-Viewer-Address'] } },
                  queryStringsConfig: { queryStringBehavior: 'all' },
              })
            : undefined;
        const defaultOriginRequestPolicyId = allViewerPolicy ? allViewerPolicy.id : MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER;

        const originId = `${name}-eks-origin`;

        // ── CloudFront distribution ────────────────────────────────────────
        const distribution = new aws.cloudfront.Distribution(`${name}Distribution`, {
            enabled: true,
            httpVersion: 'http2and3',
            isIpv6Enabled: true,
            priceClass,
            aliases: allHosts,
            comment: `SmooaiNextEdge — ${domain} → ${originHost}`,
            origins: [
                {
                    originId,
                    domainName: originHost,
                    // HTTPS-only to the ALB — auth cookies never traverse plain HTTP.
                    customOriginConfig: {
                        httpPort: 80,
                        httpsPort: 443,
                        originProtocolPolicy: 'https-only',
                        originSslProtocols: ['TLSv1.2'],
                        originReadTimeout: 30,
                        originKeepaliveTimeout: 5,
                    },
                    // Origin Shield: collapse N edge POPs to one regional origin
                    // fetch on a cold key — protects the pods from cache-fill
                    // stampedes at scale.
                    ...(originShield ? { originShield: { enabled: true, originShieldRegion } } : {}),
                },
            ],
            // Default behavior: HTML / SSR. Capped MaxTTL + full forwarding.
            defaultCacheBehavior: {
                targetOriginId: originId,
                viewerProtocolPolicy: 'redirect-to-https',
                allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
                cachedMethods: ['GET', 'HEAD'],
                compress: true,
                cachePolicyId: htmlPolicy.id,
                originRequestPolicyId: defaultOriginRequestPolicyId,
            },
            orderedCacheBehaviors: [
                // Immutable build assets — long-cache, forward nothing.
                {
                    pathPattern: '/_next/static/*',
                    targetOriginId: originId,
                    viewerProtocolPolicy: 'redirect-to-https',
                    allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
                    cachedMethods: ['GET', 'HEAD'],
                    compress: true,
                    cachePolicyId: immutablePolicy.id,
                },
                // Optimized images — edge-cache, offload per-pod optimization.
                {
                    pathPattern: '/_next/image*',
                    targetOriginId: originId,
                    viewerProtocolPolicy: 'redirect-to-https',
                    allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
                    cachedMethods: ['GET', 'HEAD'],
                    compress: true,
                    cachePolicyId: imagePolicy.id,
                },
            ],
            restrictions: {
                geoRestriction: { restrictionType: 'none' },
            },
            viewerCertificate: {
                acmCertificateArn: viewerCertificateArn,
                sslSupportMethod: 'sni-only',
                minimumProtocolVersion: 'TLSv1.2_2021',
            },
            // CloudFront natively serves stale-while-revalidate / stale-if-error
            // when the origin emits those Cache-Control directives; nothing extra
            // to enable here — the capped HTML maxTtl bounds the SWR window.
            ...args.transform,
        });

        // ── DNS (pluggable) ────────────────────────────────────────────────
        // If the consumer handed us a DNS adapter, claim every public host as a
        // record pointing at the distribution. Otherwise the consumer manages
        // DNS themselves (the distribution still carries the aliases + cert).
        if (args.dns) {
            for (const host of allHosts) {
                args.dns.createAlias(
                    `${name}Dns${host.replace(/[^a-zA-Z0-9]/g, '')}`,
                    {
                        name: host,
                        aliasName: distribution.domainName,
                        aliasZone: distribution.hostedZoneId,
                    },
                    {},
                );
            }
        }

        this.distribution = distribution;
        this.cacheBucket = cacheBucket;
        this.irsaRole = irsaRole;
        this.certificate = certificate;
        this.outputs = {
            cacheBucketName: cacheBucket.name,
            irsaRoleArn: irsaRole.arn,
            distributionId: distribution.id,
            url: $interpolate`https://${domain}`,
            originHost,
        };
    }
}
