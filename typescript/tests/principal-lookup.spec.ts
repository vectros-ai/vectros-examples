/**
 * principal-lookup.spec.ts — /v1/principals/{principalId}/profiles
 * cross-context lookup.
 *
 * Verifies:
 *   - The same principal in multiple app contexts surfaces all their
 *     profiles in a single lookup
 *   - Malformed principalId rejected with 400 (structural-char attack vector)
 *   - Lookup for an unknown principal returns an empty list (200), not 404 —
 *     "not having any profiles" is a valid state for a tenant-known principal
 *
 * Use case: an Admin UX answering "what apps does Alice have access to?"
 * across all contexts you have provisioned.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

describe('principal-lookup', () => {

    test('same principal in two contexts surfaces in cross-context lookup', async () => {
        const ctxA = ('a' + uniqueTag()).slice(0, 31);
        const ctxB = ('b' + uniqueTag()).slice(0, 31);
        const principalId = 'usr_' + uniqueTag();

        await client.auth.createAppContext({ contextId: ctxA, name: 'lookup ctx A' });
        await client.auth.createAppContext({ contextId: ctxB, name: 'lookup ctx B' });
        await client.auth.createAccessProfile({
            contextId: ctxA,
            body: { principalId, scopes: [{ allowed_actions: ['records:r'] }] },
        });
        await client.auth.createAccessProfile({
            contextId: ctxB,
            body: { principalId, scopes: [{ allowed_actions: ['search:r'] }] },
        });

        try {
            // Cross-context lookup — should surface both profiles. {data, nextCursor} envelope.
            const profiles = await client.auth.listProfilesForPrincipal({ principalId });
            const ids = (profiles.data as unknown as { contextId?: string }[]).map((p) => p.contextId);
            expect(ids).toContain(ctxA);
            expect(ids).toContain(ctxB);
            expect(ids.length).toBeGreaterThanOrEqual(2);
        } finally {
            // Clean up children first, then parents (409 cascade guard).
            await tryCleanup('profile A', () =>
                client.auth.deleteAccessProfile({ contextId: ctxA, principalId }));
            await tryCleanup('profile B', () =>
                client.auth.deleteAccessProfile({ contextId: ctxB, principalId }));
            // Context deletion needs a matching `confirm` token.
            await tryCleanup('ctxA', () => client.auth.deleteAppContext({ contextId: ctxA, confirm: ctxA }));
            await tryCleanup('ctxB', () => client.auth.deleteAppContext({ contextId: ctxB, confirm: ctxB }));
        }
    });

    test('lookup for principal with no profiles returns empty array (200, not 404)', async () => {
        const principalId = 'usr_' + uniqueTag();
        const profiles = await client.auth.listProfilesForPrincipal({ principalId });
        // {data, nextCursor} envelope — data is the (empty) array.
        expect(Array.isArray(profiles.data)).toBe(true);
        expect(profiles.data ?? []).toHaveLength(0);
    });

    test('malformed principalId rejected with 400 (structural-char attack)', async () => {
        // The ':' is the internal key separator — accepting it would let a
        // malicious principalId inject key segments. The handler validates
        // format eagerly so this surfaces as a clean 400.
        await expect(client.auth.listProfilesForPrincipal({ principalId: 'bad:value' }))
            .rejects.toMatchObject({ statusCode: 400 });
    });
});
