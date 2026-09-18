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
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup, sleep } from '../src/helpers';

interface MintedToken { token: string; expiresAt: number; }

/** The isolated exact-billing counter — see billing-exact.spec.ts for the full rationale. Used
 *  here only as a bounded (not exact) check: this file isn't run in that spec's exclusive lane,
 *  so a little cross-talk from other concurrently-running specs is expected. */
const usedMilli = async (): Promise<number> => {
    const u = (await client.auth.getUsage()) as unknown as { credits: { usedMilli: number } };
    return u.credits.usedMilli;
};

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

    // -------------------------------------------------------------------------
    // 0.44.0 — DELETE under concurrency: a duplicate delete no longer records
    // an extra change-history entry for the same removal, and a delete racing
    // a concurrent update resolves cleanly instead of silently recording
    // whichever version happened to be current at that moment.
    // -------------------------------------------------------------------------

    describe('DELETE under concurrency', () => {
        test('two concurrent DELETEs of the same user settle cleanly — no crash, no double-delete', async () => {
            const externalId = `smoke-del-race-${uniqueTag()}`;
            const user = await client.identity.createUser({ body: { externalId, type: 'HUMAN' } });
            const userId = user.id!;

            // A same-shape control, deleted once and NOT raced, gives the fee ONE delete of an
            // identical row costs — the number the race below must not double. Measured fresh in
            // this test rather than pinned to a literal: the exact fee is an implementation detail
            // this spec doesn't otherwise depend on, and the two users are identical in every way
            // fee computation looks at (freshly created, HUMAN, no other fields).
            const controlExternalId = `smoke-del-race-control-${uniqueTag()}`;
            const control = await client.identity.createUser({ body: { externalId: controlExternalId, type: 'HUMAN' } });
            const beforeControl = await usedMilli();
            await client.identity.deleteUser({ id: control.id! });
            const oneDeleteFee = (await usedMilli()) - beforeControl;
            expect(oneDeleteFee).toBeGreaterThan(0);

            // Dispatched with no await in between so both requests are genuinely in flight at
            // once. A duplicate delete that finds the row already gone is itself a SUCCESSFUL
            // no-op (deleting something already deleted is not an error) rather than a conflict —
            // so the shape asserted here is "both settle cleanly", not "one wins, one is
            // refused". The only legitimate rejection for the loser is a 404, and only when its
            // own initial lookup happens to run after the winner has already fully committed.
            const beforeRace = await usedMilli();
            const results = await Promise.allSettled([
                client.identity.deleteUser({ id: userId }),
                client.identity.deleteUser({ id: userId }),
            ]);
            const raceFee = (await usedMilli()) - beforeRace;

            for (const r of results) {
                if (r.status === 'rejected') {
                    expect((r.reason as { statusCode?: number }).statusCode).toBe(404);
                }
            }

            // Whatever the settling order, the user is gone exactly once and stays gone.
            await expect(client.identity.getUser({ id: userId })).rejects.toMatchObject({ statusCode: 404 });

            // ...and it was billed exactly once, not twice. A generous upper bound rather than
            // exact equality: unlike billing-exact.spec.ts's exclusive lane, this file runs
            // alongside other specs writing to the same shared tenant and can pick up a small
            // amount of unrelated noise in the gap between snapshots. A charge that actually
            // doubled would still fail this comfortably; a few stray milli-credits from a
            // concurrent spec would not.
            expect(raceFee).toBeGreaterThan(0);
            expect(raceFee).toBeLessThan(oneDeleteFee * 2);
        });

        test('a DELETE racing concurrent UPDATEs on the same user never corrupts state', async () => {
            // The stricter contention outcome — a retryable 409 (errorCode VERSION_CONFLICT)
            // when the row keeps changing across the delete's own internal retry budget — is
            // real, but exhausting that budget needs the row to move on EVERY one of a small,
            // fast internal retry sequence. A handful of concurrently-fired HTTP updates can
            // land inside that window, but far more often a single well-timed update is simply
            // picked up by the delete's own retry and the delete still succeeds (204). So this
            // asserts the narrow VERSION_CONFLICT claim ONLY when it is actually observed, and
            // otherwise accepts the other legitimate outcomes — the invariant under test is that
            // nothing comes back malformed (no 500) and the end state is well-defined.
            const externalId = `smoke-del-upd-race-${uniqueTag()}`;
            const user = await client.identity.createUser({ body: { externalId, type: 'HUMAN' } });
            const userId = user.id!;

            const [deleteResult, ...updateResults] = await Promise.allSettled([
                client.identity.deleteUser({ id: userId }),
                client.identity.updateUser({ id: userId, body: { externalId, email: `a-${uniqueTag()}@test.com` } }),
                client.identity.updateUser({ id: userId, body: { externalId, email: `b-${uniqueTag()}@test.com` } }),
                client.identity.updateUser({ id: userId, body: { externalId, email: `c-${uniqueTag()}@test.com` } }),
            ]);

            if (deleteResult.status === 'rejected') {
                const err = deleteResult.reason as { statusCode?: number; body?: { errorCode?: string } };
                expect([404, 409]).toContain(err.statusCode);
                if (err.statusCode === 409) {
                    expect(err.body?.errorCode).toBe('VERSION_CONFLICT');
                }
            }

            // A losing update racing the delete sees the same thing a losing duplicate delete
            // does: the row is gone.
            for (const r of updateResults) {
                if (r.status === 'rejected') {
                    expect((r.reason as { statusCode?: number }).statusCode).toBe(404);
                }
            }

            // End state is well-defined either way: deleted, or alive with one of the raced
            // updates (or the original) applied — never a hang, never a 500.
            let survived = false;
            try {
                await client.identity.getUser({ id: userId });
                survived = true;
            } catch (e) {
                expect((e as { statusCode?: number }).statusCode).toBe(404);
            }
            if (survived) {
                await tryCleanup('surviving user', () => client.identity.deleteUser({ id: userId }));
            }
        });
    });
});

/**
 * A user's version history is retained after the user itself is deleted — the audit trail is
 * never dropped just because the row it describes is gone. Who can still read it depends on the
 * credential shape: an account-level API key can, because it isn't confined to any one app
 * context; a context-confined credential (a scoped API key or a scoped token) gets a 404,
 * identical to the response for an id that never existed, because the access profile that would
 * have proven it could reach this user is itself deleted along with the user.
 */
describe('GET /v1/users/{id}/versions after deletion', () => {
    test('an account-level API key can still read it; a context-confined credential cannot', async () => {
        const externalId = `smoke-deleted-user-history-${uniqueTag()}`;
        const user = await client.identity.createUser({ body: { externalId, type: 'HUMAN' } });
        const userId = user.id!;

        // One update beyond the initial create, so there is more than a single CREATE entry to
        // read back.
        await client.identity.updateUser({ id: userId, body: { externalId, status: 'SUSPENDED' } });

        // Version rows are written asynchronously — poll the still-live user until the UPDATE
        // entry lands, so the delete below can't race the write and leave history incomplete.
        let deadline = Date.now() + 30_000;
        let versions: Array<{ changeType?: string }> = [];
        while (Date.now() < deadline) {
            const page = await client.identity.getUserVersions({ id: userId }) as { data?: Array<{ changeType?: string }> };
            versions = page.data ?? [];
            if (versions.some((v) => v.changeType === 'UPDATE')) break;
            await sleep(2_000);
        }
        expect(versions.some((v) => v.changeType === 'UPDATE')).toBe(true);

        await client.identity.deleteUser({ id: userId });

        // (a) An account-level API key reads the deleted user's version history unchanged.
        const afterDelete = await client.identity.getUserVersions({ id: userId }) as { data?: unknown[] };
        expect(afterDelete.data ?? []).not.toHaveLength(0);

        // (b) A context-confined credential gets a uniform 404 — indistinguishable from the id
        // never having existed, even though the same history is sitting right there for the
        // account-level key above.
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['users:r'] },
        })) as MintedToken;
        const scoped = getScopedClient(minted.token);
        await expect(scoped.identity.getUserVersions({ id: userId })).rejects.toMatchObject({ statusCode: 404 });
    });
});
