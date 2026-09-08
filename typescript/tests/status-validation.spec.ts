/**
 * status-validation.spec.ts — `status` on the UPDATE paths, which used to store whatever string you
 * sent while the create paths already normalised and rejected.
 *
 * Three endpoints were inconsistent with their own create branches:
 *
 *   PUT  /v1/users/{id}
 *   PUT  /v1/entities/{namespace}/{id}
 *   POST /v1/entities/{namespace}?upsert=true   (the matching-an-existing-entity branch)
 *
 * The last is the easy one to miss, and is asserted here for exactly that reason: on the entity
 * surface the upsert CREATE branch validated and only the UPDATE branch did not, so a single
 * endpoint answered differently depending on whether the row already existed.
 *
 * Every non-canonical value below is written `as any`, and that is a fact about the surface rather
 * than a test-writing convenience: the generated SDKs narrow `status` to `ACTIVE`/`SUSPENDED`, so a
 * typed TypeScript caller could never express these at all. The defect was always reachable from an
 * untyped caller — raw HTTP, a Python dict, a hand-rolled client — which is exactly the caller least
 * likely to notice that their row came back spelled differently from how they sent it.
 *
 * Why this is worth pinning against a running deployment: the consequences of a non-canonical row
 * land on OTHER endpoints. A user stored as `"active"` rather
 * than `"ACTIVE"` is refused at `POST /v1/auth/token/exchange`, which compares exactly — so the
 * defect was a write that silently broke sign-in later, and the fix is a write-path guard whose
 * value only shows up somewhere else.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

describe('status validation on the update paths', () => {
    // -------------------------------------------------------------------------
    // Users
    // -------------------------------------------------------------------------

    describe('PUT /v1/users/{id}', () => {
        let userId: string;
        const userExternalId = `smoke-status-${uniqueTag()}`;

        // `externalId` is optional on an update (it defaults to the stored value) and immutable;
        // re-sending it is simply the clearest shape for a status-only update.
        const put = (status: unknown) =>
            client.identity.updateUser({ id: userId, body: { externalId: userExternalId, status: status as any } });

        beforeAll(async () => {
            const user = await client.identity.createUser({ body: {
                externalId: userExternalId,
                type: 'HUMAN',
            } });
            userId = user.id!;
        });

        afterAll(async () => {
            await tryCleanup(`delete user ${userId}`, () => client.identity.deleteUser({ id: userId }));
        });

        // Every cell below mutates a shared user, so the reset runs whatever the cell did — an
        // assertion that throws part-way must not leave the next four cells failing for the wrong
        // reason. One real defect should report as one failure, not five.
        afterEach(async () => { await put('ACTIVE'); });

        test('a lowercase status is NORMALISED, not stored verbatim', async () => {
            const updated = await put('suspended');
            expect(updated.status).toBe('SUSPENDED');
            // Read back through a separate request: the response could echo without having stored it.
            const reread = await client.identity.getUser({ id: userId });
            expect(reread.status).toBe('SUSPENDED');
        });

        test('a value outside ACTIVE/SUSPENDED is refused rather than stored', async () => {
            await expect(put('nonsense')).rejects.toMatchObject({ statusCode: 400 });
            const reread = await client.identity.getUser({ id: userId });
            expect(reread.status).toBe('ACTIVE');
        });

        test('the EMPTY string is refused too', async () => {
            // Called out separately because it is the value a naive "only validate non-blank input"
            // guard lets through, and the one that made a row unable to sign in.
            await expect(put('')).rejects.toMatchObject({ statusCode: 400 });
            expect((await client.identity.getUser({ id: userId })).status).toBe('ACTIVE');
        });

        test('PENDING is refused — it is a server-managed state', async () => {
            // Sending it used to DEMOTE a live user into the invitation state, with no way back
            // through the API: the pending-to-active transition needs an inviteToken from an
            // invitation a demoted user never had.
            await expect(put('PENDING')).rejects.toMatchObject({ statusCode: 400 });
            expect((await client.identity.getUser({ id: userId })).status).toBe('ACTIVE');
        });

        test('an explicit null still means "leave it unchanged"', async () => {
            // The one shape that must NOT be caught by the new validation: null is not a value, it
            // is the absence of one, exactly as omitting the field is.
            //
            // Asserted from a NON-default state on purpose. Sending null to an already-ACTIVE user
            // and asserting ACTIVE cannot tell "left unchanged" from "reset to ACTIVE" — and reset
            // is the plausible regression, since the fix is a ternary whose else-branch returns the
            // stored value and could just as easily return a constant.
            await put('SUSPENDED');
            const updated = await put(null);
            expect(updated.status).toBe('SUSPENDED');
            expect((await client.identity.getUser({ id: userId })).status).toBe('SUSPENDED');
        });
    });

    // -------------------------------------------------------------------------
    // Identity entities — both write paths that reach the update branch
    // -------------------------------------------------------------------------

    describe('entities', () => {
        // 2-32 chars, lowercase letter first, then a-z 0-9 _ -
        const namespace = `ns${uniqueTag().replace(/[^a-z0-9]/g, '').slice(0, 24)}`;
        let entityId: string;
        const externalId = `ent-status-${uniqueTag()}`;

        beforeAll(async () => {
            await client.identity.registerNamespace({ body: {
                namespace, specificityRank: 500, entityBacked: true,
            } });
            const entity = await client.identity.createEntity({
                namespace,
                body: { externalId, name: 'status probe' },
            });
            entityId = entity.id!;
        });

        afterAll(async () => {
            await tryCleanup(`delete entity ${entityId}`,
                () => client.identity.deleteEntity({ namespace, id: entityId }));
            await tryCleanup(`delete namespace ${namespace}`,
                () => client.identity.deleteNamespace({ namespace }));
        });

        const putEntity = (status: unknown) => client.identity.updateEntity({
            namespace, id: entityId, body: { externalId, status: status as any },
        });

        afterEach(async () => { await putEntity('ACTIVE'); });

        test('PUT normalises a lowercase status', async () => {
            expect((await putEntity('suspended')).status).toBe('SUSPENDED');
            expect((await client.identity.getEntity({ namespace, id: entityId })).status)
                .toBe('SUSPENDED');
        });

        test('PUT refuses the EMPTY string on entities too', async () => {
            // The same shape called out on the user surface: the value a "reject blank input" guard
            // lets through. Asserted per surface because the two DTOs validate independently.
            await expect(putEntity('')).rejects.toMatchObject({ statusCode: 400 });
            expect((await client.identity.getEntity({ namespace, id: entityId })).status)
                .toBe('ACTIVE');
        });

        test('an explicit null leaves an entity status unchanged', async () => {
            await putEntity('SUSPENDED');
            expect((await putEntity(null)).status).toBe('SUSPENDED');
        });

        test('PUT refuses a value outside ACTIVE/SUSPENDED', async () => {
            await expect(client.identity.updateEntity({
                namespace, id: entityId, body: { externalId, status: 'nonsense' as any },
            })).rejects.toMatchObject({ statusCode: 400 });
            const reread = await client.identity.getEntity({ namespace, id: entityId });
            expect(reread.status).toBe('ACTIVE');
        });

        test('UPSERT matching an existing entity NORMALISES too, not just rejects', async () => {
            // The other half of the same fix. A regression that rejected garbage but still stored a
            // non-canonical value through upsert would pass every refusal cell here.
            const upserted = await client.identity.createEntity({
                namespace,
                upsert: true,
                body: { externalId, name: 'status probe', status: 'suspended' as any },
            });
            expect(upserted.status).toBe('SUSPENDED');
        });

        test('UPSERT matching an existing entity validates too — the branch that did not', async () => {
            // Same endpoint, same body, different branch: the create branch always validated, so a
            // test that only exercised a NEW externalId would have been green throughout the defect.
            await expect(client.identity.createEntity({
                namespace,
                upsert: true,
                body: { externalId, name: 'status probe', status: 'nonsense' as any },
            })).rejects.toMatchObject({ statusCode: 400 });
            const reread = await client.identity.getEntity({ namespace, id: entityId });
            expect(reread.status).toBe('ACTIVE');
        });

        test('UPSERT creating a NEW entity validates as it always did — the control', async () => {
            // Pins the half that was never broken, so the cell above reads as "both branches agree"
            // rather than "one branch rejects".
            await expect(client.identity.createEntity({
                namespace,
                upsert: true,
                body: { externalId: `ent-new-${uniqueTag()}`, name: 'new', status: 'nonsense' as any },
            })).rejects.toMatchObject({ statusCode: 400 });
        });
    });
});
