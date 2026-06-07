/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Minimal SST app config — present ONLY so `sst install` can generate the
 * platform types (`.sst/platform/config.d.ts`) that the constructs in `src/`
 * typecheck against. `@smooai/deploy` is a construct LIBRARY, not a deployable
 * app: this config is never deployed and exposes no resources. Consumers import
 * the constructs from `src/` into THEIR own `sst.config.ts`.
 */
export default $config({
    app() {
        return {
            name: 'smooai-deploy-types',
            removal: 'remove',
            home: 'aws',
        };
    },
    async run() {
        // Intentionally empty — type-generation host only. Never deployed.
    },
});
