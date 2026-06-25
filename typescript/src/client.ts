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

// LIVE-tenant client — primary client used by most specs
export const client = new VectrosClient({
    token: requireEnv('VECTROS_API_KEY'),
    environment: requireEnv('VECTROS_API_BASE_URL'),
});

// TEST-tenant client — same org, separate tenant. Used by tenant
// isolation tests in documents-text.spec.ts.
export function getTestTenantClient(): VectrosClient {
    return new VectrosClient({
        token: requireEnv('VECTROS_TEST_API_KEY'),
        environment: requireEnv('VECTROS_API_BASE_URL'),
    });
}

// Helper for scoped-token tests: returns a fresh client using the provided
// st_* token, keeping the same base URL as the live-tenant client.
export function getScopedClient(scopedToken: string): VectrosClient {
    return new VectrosClient({
        token: scopedToken,
        environment: requireEnv('VECTROS_API_BASE_URL'),
    });
}
