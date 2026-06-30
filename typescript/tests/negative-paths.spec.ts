/**
 * negative-paths.spec.ts — the failure-mode contract your integration
 * actually depends on. Most specs assert the 2xx happy path; this one proves
 * the API rejects the wrong things, with the RIGHT status AND a usable error
 * BODY (a human-readable message + a requestId to quote to support), and that
 * it never leaks server internals in the process.
 *
 * Covered rejection classes:
 *   - 403 auth-denied   — a scoped credential acting outside its granted scope
 *   - 404 not-found     — a well-formed id that doesn't exist
 *   - 400 validation    — a request that violates the schema/contract
 *   - 409 conflict      — a unique-lookup-field collision
 *
 * Cross-context 404/empty isolation has its own dedicated spec
 * (cross-context-isolation.spec.ts); optimistic-lock 409 + PATCH validation
 * live in patch.spec.ts. This file is the consolidated auth/validation surface.
 *
 * On 402 over-balance enforcement: it IS a real gate (the inference handlers
 * return 402 when the prepaid wallet can't cover a call), but it cannot be
 * exercised non-destructively against the SHARED smoke tenant — triggering it
 * means draining the tenant's real balance, which would break every other
 * inference spec in the run. It is validated at the integration-test layer
 * where the wallet can be set deterministically. Asserting it here would
 * require either a throwaway tenant or a destructive drain; neither fits a
 * smoke suite, so it is intentionally out of scope (see README "What's NOT
 * covered").
 */
import { VectrosClient } from '@vectros-ai/sdk';
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

interface MintedToken { token: string; expiresAt: number; }
interface ErrorBody { message?: string; requestId?: string; [k: string]: unknown }

/** Markers that would indicate a server-internal leak in an error body. */
const LEAK_MARKERS = [
    /com\.fasterxml/, /com\.[a-z]+\.(core|api|model)/, /MismatchedInput/, /NullPointerException/,
    /\bat [\w$.]+\([\w.]+:\d+\)/, /Exception:.*\n\s+at /, /software\.amazon\.awssdk/,
    // A misconfigured API gateway can return a raw ACCESS_DENIED body that leaks
    // the internal IAM authz shape ("...explicit deny in an identity-based
    // policy"). The API overrides it with a clean error contract — these markers
    // catch any regression that lets the IAM text reach a caller.
    /identity-based policy/i, /explicit deny/i, /execute-api/i,
];

/** A syntactically valid but nonexistent key — the authorizer hashes it, finds no
 *  matching key, and denies (key_not_found → deny). This is the SAME path a
 *  genuinely revoked key takes, so it exercises the invalid-key contract without
 *  provisioning-then-revoking a real key. */
function badKeyClient(token: string): VectrosClient {
    return new VectrosClient({ token, environment: process.env.VECTROS_API_BASE_URL! });
}

/**
 * Runs a call expected to reject and returns the {statusCode, body}. Fails
 * loudly if the call RESOLVES (a silent success is the worst outcome for a
 * negative-path test — it must never pass vacuously).
 */
async function captureError(p: Promise<unknown>): Promise<{ statusCode?: number; body: ErrorBody }> {
    try {
        await p;
    } catch (e) {
        const err = e as { statusCode?: number; body?: unknown };
        if (err.statusCode === undefined) throw e; // not an API error — surface it
        return { statusCode: err.statusCode, body: (err.body ?? {}) as ErrorBody };
    }
    throw new Error('expected the call to reject, but it resolved successfully');
}

/** Asserts an error body is usable by callers and leaks no server internals. */
function assertCleanErrorBody(body: ErrorBody): void {
    // A human-readable message...
    expect(typeof body.message).toBe('string');
    expect((body.message ?? '').length).toBeGreaterThan(0);
    // ...and a requestId you can quote to support.
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId).toBeTruthy();
    // ...and NO server internals leaked.
    const serialized = JSON.stringify(body);
    for (const marker of LEAK_MARKERS) {
        expect(serialized).not.toMatch(marker);
    }
}

describe('negative paths', () => {
    let schemaId: string;
    let recordType: string;
    let anchorRecordId: string;

    beforeAll(async () => {
        recordType = `smoke_neg_${uniqueTag()}`.replace(/-/g, '_');
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Negative-path Schema',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'name', fieldType: 'string', required: true },
                { fieldId: 'mrn', fieldType: 'string', required: false },
            ],
            lookupFields: [{ fieldName: 'mrn', unique: true }],
        } });
        schemaId = schema.id!;
        const anchor = await client.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { name: 'Anchor', mrn: `MRN-${uniqueTag()}` },
        } });
        anchorRecordId = anchor.id!;
    });

    afterAll(async () => {
        await tryCleanup('delete anchor', () => client.records.deleteRecord({ id: anchorRecordId }));
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    // =======================================================================
    // 403 — auth-denied (scope enforcement), with body assertions
    // =======================================================================
    test('403 — a read-only scoped token cannot create (action-letter enforcement)', async () => {
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['records:r'] },
        })) as MintedToken;
        const scoped = getScopedClient(minted.token);

        const { statusCode, body } = await captureError(scoped.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { name: 'blocked' },
        } }));
        expect(statusCode).toBe(403);
        assertCleanErrorBody(body);
    });

    test('403 — a scoped token without billing:r cannot read usage', async () => {
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['records:r'] },
        })) as MintedToken;
        const scoped = getScopedClient(minted.token);

        const { statusCode, body } = await captureError(scoped.auth.getUsage());
        expect(statusCode).toBe(403);
        assertCleanErrorBody(body);
    });

    // =======================================================================
    // 403 — auth-denied at the AUTHORIZER (invalid/revoked key)
    //
    // Distinct from the scope-enforcement 403s above: those are denied by the
    // request handler. These are denied UPSTREAM by the authorizer → an API
    // gateway ACCESS_DENIED response, which can otherwise return raw IAM text
    // "...explicit deny in an identity-based policy" — not actionable and
    // leaking the internal authz shape. The body must instead be a clean error
    // contract with an actionable `errorCode: INVALID_KEY`. Uniform across
    // scoped/unscoped and across revoked-vs-never-existed (non-oracle).
    // =======================================================================
    test('403 — invalid scoped key (ssk_*) → actionable INVALID_KEY, no IAM leak', async () => {
        const bad = badKeyClient('ssk_live_invalid000000000000000000000000000000');
        const { statusCode, body } = await captureError(bad.auth.ping());
        expect(statusCode).toBe(403);
        assertCleanErrorBody(body);
        expect(body.errorCode).toBe('INVALID_KEY');
        // The actionable message must not re-leak the IAM "identity-based policy" shape.
        expect((body.message ?? '').toLowerCase()).not.toContain('identity-based policy');
    });

    test('403 — invalid root key (sk_*) → same uniform INVALID_KEY contract', async () => {
        const bad = badKeyClient('sk_live_invalid0000000000000000000000000000000');
        const { statusCode, body } = await captureError(bad.auth.ping());
        expect(statusCode).toBe(403);
        assertCleanErrorBody(body);
        expect(body.errorCode).toBe('INVALID_KEY');
    });

    test('401 — NO Authorization header → UNAUTHORIZED contract (the other reachable gateway leg)', async () => {
        // With the authorizer's identitySource=method.request.header.Authorization,
        // a request that omits the header short-circuits to a 401 UNAUTHORIZED gateway
        // response WITHOUT invoking the authorizer — the one path the UNAUTHORIZED body
        // is reachable (vs the 403 ACCESS_DENIED above). The SDK always attaches a token,
        // so use raw fetch to send no Authorization header at all.
        const base = process.env.VECTROS_API_BASE_URL!.replace(/\/+$/, '');
        const resp = await fetch(`${base}/v1/ping`); // no headers
        expect(resp.status).toBe(401);
        const raw = await resp.text();
        const body = JSON.parse(raw) as ErrorBody; // must be JSON, not raw AWS text
        assertCleanErrorBody(body);
        expect(body.errorCode).toBe('UNAUTHORIZED');
    });

    // =======================================================================
    // 404 — not found, with body assertions
    // =======================================================================
    test('404 — GET on a well-formed but nonexistent record id', async () => {
        const { statusCode, body } = await captureError(
            client.records.getRecord({ id: '44444444-4444-4444-4444-444444444444' }));
        expect(statusCode).toBe(404);
        assertCleanErrorBody(body);
    });

    // =======================================================================
    // 400 — validation, with body assertions
    // =======================================================================
    test('400 — create with a payload missing a required field', async () => {
        // The schema declares `name` required; omit it.
        const { statusCode, body } = await captureError(client.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { mrn: `MRN-${uniqueTag()}` },
        } }));
        expect(statusCode).toBe(400);
        assertCleanErrorBody(body);
    });

    // =======================================================================
    // Unique lookup-field collision
    // =======================================================================
    test('a second record with the same unique lookup value is rejected (uniqueness enforced)', async () => {
        const sharedMrn = `MRN-UNIQUE-${uniqueTag()}`;
        const first = await client.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { name: 'First', mrn: sharedMrn },
        } });
        try {
            const { statusCode, body } = await captureError(client.records.createRecord({ body: {
                typeName: recordType, schemaId, payload: { name: 'Second', mrn: sharedMrn },
            } }));
            // `mrn` is declared unique:true — the collision must be REJECTED, not
            // silently accepted (which would corrupt the uniqueness guarantee the
            // lookup endpoint relies on). The platform surfaces this as a 400
            // validation error whose message identifies the uniqueness conflict.
            expect(statusCode).toBe(400);
            assertCleanErrorBody(body);
            expect(body.message).toMatch(/uniqu|already|exist|duplicat/i);
        } finally {
            await tryCleanup('delete first', () => client.records.deleteRecord({ id: first.id! }));
        }
    });
});
