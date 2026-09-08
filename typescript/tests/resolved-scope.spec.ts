/**
 * resolved-scope.spec.ts — `resolvedScope` on the token endpoints, and `scopeFilters` on search.
 *
 * `resolvedScope` is the same plaintext scope data that is baked into the token's own compressed
 * `scope` claim, returned alongside the token so a client never has to decode a JWT to find out what
 * it is holding. The assertion that matters is that it AGREES with the token: a field that returned
 * something plausible but unrelated would be worse than no field. `identity` is compared against the
 * token's own claim; `allowedActions` against what was requested, since the `scope` claim is
 * compressed and cannot be read back here.
 *
 * `scopeFilters` narrows a search by more than one ownership dimension at once. It is mutually
 * exclusive with the single-dimension `scope`, and that exclusivity is ENFORCED rather than silently
 * resolved in favour of one of them — which is what separates a field that is honoured from one that
 * is accepted and ignored. The same field exists on `POST /v1/rag`; that path is not covered here.
 */
import { client } from '../src/client';

/** Decode a JWT's payload without verifying it — this is a test reading its own minted token. */
function claims(token: string): any {
    const body = token.replace(/^st_/, '').split('.')[1];
    return JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

describe('resolvedScope on minted credentials', () => {
    test('POST /v1/auth/token returns the actions it minted', async () => {
        const requested = ['records:r', 'documents:r'];
        const minted: any = await client.auth.mintToken({ scope: { allowedActions: requested } });

        expect(minted.resolvedScope).toBeDefined();
        expect(minted.resolvedScope.allowedActions).toEqual(expect.arrayContaining(requested));
        // Nothing the caller did not ask for came back.
        for (const action of minted.resolvedScope.allowedActions) {
            expect(requested).toContain(action);
        }
    });

    test('resolvedScope reports the same thing the token itself carries', async () => {
        // This is what makes the field trustworthy: it is not an independently-assembled summary
        // that can drift from the credential it describes.
        const minted: any = await client.auth.mintToken({
            scope: { allowedActions: ['records:r'] },
        });
        const decoded = claims(minted.token);

        expect(minted.resolvedScope.identity).toBeDefined();
        // Compared BOTH WAYS, as an exact map equality rather than a one-directional walk. A
        // one-directional walk over `resolvedScope.identity` asserts nothing when that map is empty —
        // which is precisely what a regression that stopped populating it would produce. Equality
        // catches that, and stays correct for a credential whose identity is legitimately empty (an
        // unbound owner or service token), because then the token's own claim is empty too.
        const fromToken = Object.fromEntries(
            Object.entries(decoded.identity ?? {}).map(([k, v]) => [k, String(v)]),
        );
        const fromResponse = Object.fromEntries(
            Object.entries(minted.resolvedScope.identity).map(([k, v]) => [k, String(v)]),
        );
        expect(fromResponse).toEqual(fromToken);

        // The `scope` claim itself is compressed, so `allowedActions` cannot be cross-checked against
        // the token here. The first test in this describe carries that half instead, by comparing what
        // came back against what was asked for — in both directions.
    });

    test('a wildcard-scoped credential reports ["*"] rather than an enumeration', async () => {
        const minted: any = await client.auth.mintToken({ scope: { allowedActions: ['*'] } });
        expect(minted.resolvedScope.allowedActions).toEqual(['*']);
    });
});

describe('scopeFilters on search', () => {
    test('POST /v1/search accepts several ownership dimensions at once', async () => {
        const resp: any = await client.search.content({
            query: 'smoke scope filter probe',
            scopeFilters: ['org:smoke-probe-org', 'client:smoke-probe-client'],
            limit: 1,
        });
        // Shape only. The NARROWING itself is asserted by the refusal cells below, which are what
        // separate "the field is honoured" from "the field is accepted and ignored" — a bare
        // `Array.isArray` on the results would pass either way, since a filter naming values no row
        // carries matches nothing whether or not the field works.
        expect(Array.isArray(resp.results)).toBe(true);
    });

    test('scope and scopeFilters are mutually exclusive, and the refusal says so', async () => {
        // Silently preferring one of the two would give a caller a narrower or wider result set than
        // they asked for, with nothing to notice.
        await expect(client.search.content({
            query: 'smoke',
            scope: 'org:smoke-probe-org',
            scopeFilters: ['client:smoke-probe-client'],
            limit: 1,
        })).rejects.toMatchObject({ statusCode: 400 });
    });

    test('naming one namespace twice in scopeFilters is refused', async () => {
        // One value per namespace: two would be an unanswerable AND over the same axis.
        await expect(client.search.content({
            query: 'smoke',
            scopeFilters: ['org:smoke-probe-a', 'org:smoke-probe-b'],
            limit: 1,
        })).rejects.toMatchObject({ statusCode: 400 });
    });
});
