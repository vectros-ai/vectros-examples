/**
 * Singleton client instantiation for smoke tests.
 *
 * Reads credentials and target environment from environment variables. In CI,
 * your pipeline injects these from the appropriate secret store. For local
 * development, copy .env.example to .env and fill in real values.
 *
 *   VECTROS_API_KEY         — sk_live_* or sk_test_* API key for the test
 *                             tenant
 *   VECTROS_TEST_API_KEY    — TEST-environment key for the SAME org, used
 *                             by tenant isolation tests
 *   VECTROS_API_BASE_URL    — https://api.vectros.ai (your Vectros API base URL)
 */
import { VectrosClient } from '@vectros-ai/sdk';
import { rateLimitAwareFetch } from './rateLimitFetch';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value || value.length === 0) {
        throw new Error(
            `${name} is required. ` +
            `In CI, ensure the secret is wired in your pipeline variables. ` +
            `For local dev, set it in a .env file (see .env.example).`
        );
    }
    return value;
}

// Every client in this suite installs `rateLimitAwareFetch` and disables the
// SDK's own retry-on-429 (`maxRetries: 0`). See rateLimitFetch.ts for the
// full mechanism — in short: the SDK's default retry pays a shared-tenant
// rate-limit wait SILENTLY inside one `await` (up to ~120s, invisible to any
// caller timeout), which can look identical to a slow/missing backend
// response from the outside. This makes the same wait happen VISIBLY and
// BOUNDED instead; `maxRetries: 0` stops the SDK from retrying again on top
// of it. Any spec that constructs its OWN `VectrosClient` (rather than using
// this file) must spread the same options in — see auth.spec.ts /
// capabilities.spec.ts / logs.spec.ts / identity-scoped-key.spec.ts /
// negative-paths.spec.ts for the pattern.
const RATE_LIMIT_SAFE = { fetch: rateLimitAwareFetch, maxRetries: 0 } as const;

// LIVE-tenant client — primary client used by most specs
export const client = new VectrosClient({
    token: requireEnv('VECTROS_API_KEY'),
    environment: requireEnv('VECTROS_API_BASE_URL'),
    ...RATE_LIMIT_SAFE,
});

// TEST-tenant client — same org, separate tenant. Used by tenant
// isolation tests in documents-text.spec.ts.
export function getTestTenantClient(): VectrosClient {
    return new VectrosClient({
        token: requireEnv('VECTROS_TEST_API_KEY'),
        environment: requireEnv('VECTROS_API_BASE_URL'),
        ...RATE_LIMIT_SAFE,
    });
}

// Helper for scoped-token tests: returns a fresh client using the provided
// st_* token, keeping the same base URL as the live-tenant client.
export function getScopedClient(scopedToken: string): VectrosClient {
    return new VectrosClient({
        token: scopedToken,
        environment: requireEnv('VECTROS_API_BASE_URL'),
        ...RATE_LIMIT_SAFE,
    });
}
