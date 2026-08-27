/**
 * app-contexts.spec.ts — /v1/app-contexts CRUD lifecycle.
 *
 * App contexts are the top-level container for access profiles + templates.
 * Verified invariants:
 *
 *   - context CRUD (create / get / update / delete / list)
 *   - idempotent POST returns existing context on duplicate contextId
 *   - delete is a confirm-gated async cascade: 400 without a matching
 *     `confirm` token; with it the context enters purging and the drain
 *     actually ERASES its data-plane content (the destroy-path test seeds a
 *     schema/record/folder/document AND a role/access-profile — the four
 *     context-scoped DATA models plus the two ACCESS models `#1029`'s
 *     registry-loop fix pinned coverage for — and asserts each is gone, not
 *     just that the status flipped, THEN polls until the context row itself
 *     404s, proving the full async drain converges, not just its first tick)
 *   - 400 on malformed contextId (must match /^[a-z][a-z0-9-]{2,30}$/)
 *   - uniform 404 on wrong-tenant probe
 *
 * Templates + profiles get their own spec (access-profiles.spec.ts) so this
 * stays focused on the context lifecycle.
 *
 * SDK note: app-context endpoints land under `client.auth.*` namespace.
 */
import { client, getScopedClient } from '../src/client';
import type { VectrosClient } from '@vectros-ai/sdk';
import { uniqueTag, tryCleanup, sleep, SKIP_SLOW } from '../src/helpers';

interface MintedToken { token: string; expiresAt: number; }

/**
 * Budget for the context-row-itself convergence poll (see `pollUntilGone`'s
 * use in the destroy-path test below) — several sequential >=60s self-tick
 * phases, measured live at ~3 minutes end-to-end. The Jest per-test timeout
 * on that test is DERIVED from this constant (+ margin for everything before
 * it), rather than a second hand-synced number, so the two can't drift.
 */
const CONTEXT_GONE_TIMEOUT_MS = 300_000;

/** Base API URL with any trailing slash trimmed (matches src/client env). */
function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

/**
 * Raw-fetch the DELETE so the smoke can assert the EXACT status code (202
 * accepted / 400 confirm-gate) — the generated client returns the parsed body
 * and hides the HTTP status. Uses the root key (context deletion is
 * root-authority-only); `confirm` is omitted for the confirm-gate negative.
 */
async function rawDeleteAppContext(key: string, contextId: string, confirm?: string): Promise<number> {
    const qs = confirm === undefined ? '' : `?confirm=${encodeURIComponent(confirm)}`;
    const resp = await fetch(`${baseUrl()}/v1/app-contexts/${encodeURIComponent(contextId)}${qs}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key}` },
    });
    return resp.status;
}

/**
 * Poll getAppContext until its status leaves `active` (i.e. reaches `purging`
 * or `deleted`) — the observable proof the delete was accepted and the context
 * is draining. The flip to `purging` happens as the delete is accepted, so this
 * resolves quickly; the context row is only removed once its contents finish
 * draining in the background, which is out of scope for a smoke.
 */
async function pollUntilLeftActive(
    tenantClient: VectrosClient,
    contextId: string,
    timeoutMs = 30_000,
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = 'active';
    while (Date.now() < deadline) {
        last = (await tenantClient.auth.getAppContext({ contextId })).status ?? 'active';
        if (last !== 'active') return last;
        await sleep(1_000);
    }
    throw new Error(`context ${contextId} still 'active' ${timeoutMs}ms after an accepted (202) teardown`);
}

/**
 * Poll a by-id read until it 404s — the proof the delete actually REMOVED that
 * row, not merely flipped the context to `purging`. The drain runs in the
 * background once the delete is accepted and completes within a few seconds.
 * getRecord/getFolder/getDocument/getSchema return a row only if it still
 * exists — they are not suppressed while the context is purging (the context
 * itself keeps reading back as `purging`) — so a 404 here means the row is
 * gone, not hidden.
 *
 * Also used for the app-context ROW ITSELF (pass `() =>
 * tenantClient.auth.getAppContext({contextId})`, `CONTEXT_GONE_TIMEOUT_MS`) —
 * the full teardown convergence, one level past a per-row check. #1029 (context-
 * teardown registry loop, mirrors #1014's tenant-wide fix) hardened exactly
 * the gate that proves: `ContextTeardownSupport.contextContentEmpty` must
 * read EVERY context-scoped model — the four DATA models AND the two ACCESS
 * models (RoleDB/AccessProfileDB) — as truly empty before a self-tick can
 * flip the row to `deleted` and remove it; a model silently unprobed would
 * leave the context stuck in `purging` forever (the "loop" in the issue
 * title). That self-tick runs on a >=60s interval
 * (`AppContextDB.CONTEXT_TEARDOWN_INTERVAL_MS`), and each tick advances only
 * ONE phase (audit-history drain, then usage-ledger drain, then
 * `contextContentEmpty`) before rescheduling — convergence is several
 * sequential >=60s ticks, not one. Measured live: ~3 minutes end-to-end from
 * an accepted delete to a 404; a 150s budget genuinely timed out on a real,
 * eventually-successful run, hence the wide default margin.
 *
 * Tolerates up to `maxTransientErrors` consecutive 429/502/503/504s before
 * giving up — a genuinely transient infra blip over a poll window that can
 * run several minutes against a real, shared staging environment shouldn't
 * fail the test outright. Any OTHER status (400/403/500/…) still fails fast,
 * on the first occurrence — those are never "try again in a moment" errors.
 */
async function pollUntilGone(
    read: () => Promise<unknown>,
    label: string,
    timeoutMs = 60_000,
    intervalMs = 2_000,
    maxTransientErrors = 5,
): Promise<void> {
    const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
    const deadline = Date.now() + timeoutMs;
    let transientErrors = 0;
    while (Date.now() < deadline) {
        try {
            await read();
        } catch (err) {
            const status = (err as { statusCode?: number })?.statusCode;
            if (status === 404) return;
            if (status !== undefined && TRANSIENT_STATUSES.has(status) && ++transientErrors <= maxTransientErrors) {
                await sleep(intervalMs);
                continue;
            }
            throw err;
        }
        await sleep(intervalMs);
    }
    throw new Error(`${label} still present ${timeoutMs}ms after teardown — the drain cascade did not remove it`);
}

/** A throwaway context + a confined `ssk_*` client bound to it. */
interface ConfinedContext {
    contextId: string;
    userId: string;
    keyId: string;
    /** Client whose every call is confined to `contextId` — used to SEED data. */
    api: VectrosClient;
    /**
     * An identity-less client pinned to `contextId` — used ONLY to create the
     * first (ownerless) schema of a type in this context. A schema's very
     * first create under a `typeName` must have no owner; a context-confined
     * `ssk_*` is always bound to a user, so it can never make that first
     * create itself. Root mints this from a `contextId` on the token request
     * with no `identity` — the token is confined to the context but stamps no
     * owner. See `../src/cross-context.ts` for the same pattern.
     */
    ownerlessApi: VectrosClient;
}

/**
 * Provision a throwaway app context plus a confined scoped-key client bound to
 * it. Records, documents, folders, and schemas are context-scoped, and a root
 * key is cross-context so it cannot target one context for WRITES — the seed
 * must go through a scoped key bound to an access profile inside the context
 * (the same confinement the cross-context example uses). The root `client` is
 * kept for the post-delete verification: deleting the context revokes the
 * scoped key, so only a root credential survives to prove the rows are gone (it
 * can read any context's rows by id).
 */
async function provisionConfinedContext(tenantId: string): Promise<ConfinedContext> {
    const contextId = uniqueTag().slice(0, 31);
    let userId = '';
    let keyId = '';
    try {
        await client.auth.createAppContext({ body: { contextId, name: 'destroy-smoke' } });

        const bootstrap = (await client.auth.mintToken({
            contextId,
            scope: { allowedActions: ['schemas:c', 'schemas:r'] },
        })) as MintedToken;
        const ownerlessApi = getScopedClient(bootstrap.token);

        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userId = user.id!;
        await client.auth.createAccessProfile({
            contextId,
            body: {
                principalId: `usr_${userId}`,
                scopes: [{ allowed_actions: [
                    'records:c', 'records:r', 'documents:c', 'documents:r',
                    'folders:c', 'folders:r', 'schemas:c', 'schemas:r',
                ] }],
                status: 'active',
            },
        });
        const minted = await client.auth.createScopedKey({
            keyName: `destroy-smoke-${uniqueTag()}`, tenantId, contextId, userId,
        });
        if (!minted.rawKey) {
            throw new Error('createScopedKey returned no rawKey — cannot build a confined client to seed data');
        }
        keyId = minted.keyId!;
        return { contextId, userId, keyId, api: getScopedClient(minted.rawKey), ownerlessApi };
    } catch (err) {
        // Tear down whatever this partial provisioning created so a mid-way
        // failure (e.g. a cap or transient error) doesn't leak a context / user
        // / key against the tenant on every re-run.
        if (keyId) await tryCleanup('revoke key', () => client.auth.revokeScopedKey({ keyId }));
        await tryCleanup('delete context', () => client.auth.deleteAppContext({ contextId, confirm: contextId }));
        if (userId) await tryCleanup('delete user', () => client.identity.deleteUser({ id: userId }));
        throw err;
    }
}

describe('app-contexts', () => {

    test('context CRUD: create → get → update → list → delete', async () => {
        // contextId must match /^[a-z][a-z0-9-]{2,30}$/ — uniqueTag() is
        // 'smoke-<ts>-<rnd>' which already matches; cap at 31 chars.
        const contextId = uniqueTag().slice(0, 31);

        const created = await client.auth.createAppContext({ body: {
            contextId,
            name: 'Smoke App Context',
            description: 'created by app-contexts.spec',
        } });
        expect(created.contextId).toBe(contextId);
        expect(created.name).toBe('Smoke App Context');
        // Composite key shape: tenantId#contextId
        expect(created.id).toMatch(new RegExp(`#${contextId}$`));

        try {
            const loaded = await client.auth.getAppContext({ contextId });
            expect(loaded.contextId).toBe(contextId);
            expect(loaded.name).toBe('Smoke App Context');

            // PATCH semantics — null/omitted fields preserve existing values.
            // body.contextId is immutable (path supplies it); the handler ignores
            // any body.contextId, but the request schema still requires it.
            const updated = await client.auth.updateAppContext({
                contextId,
                body: {
                    contextId,
                    name: 'Smoke App Context (updated)',
                    description: 'updated',
                },
            });
            expect(updated.name).toBe('Smoke App Context (updated)');
            expect(updated.description).toBe('updated');

            // {data, nextCursor} envelope, oldest-first — drain every page via nextCursor rather than
            // trusting the single default page. The account's app-context list grows without bound
            // over the account's lifetime, so a freshly-created context (always last, oldest-first)
            // eventually sorts past page one; asserting against just the first page is correct only
            // while the account stays small.
            const ids: (string | undefined)[] = [];
            let cursor: string | undefined;
            do {
                const page = await client.auth.listAppContexts(cursor ? { startFrom: cursor, limit: 100 } : { limit: 100 });
                ids.push(...(page.data as unknown as { contextId?: string }[]).map((c) => c.contextId));
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            expect(ids).toContain(contextId);
        } finally {
            // Deletion is a confirm-gated irreversible cascade.
            await tryCleanup('delete app context', () =>
                client.auth.deleteAppContext({ contextId, confirm: contextId }));
        }
    });

    test('idempotent POST returns existing context (no duplicate)', async () => {
        const contextId = uniqueTag().slice(0, 31);
        const first = await client.auth.createAppContext({ body: {
            contextId, name: 'Idempotency Test',
        } });
        try {
            const second = await client.auth.createAppContext({ body: {
                contextId, name: 'Different Name (ignored on idempotent return)',
            } });
            expect(second.id).toBe(first.id);
            // Idempotent return → returns the EXISTING record, doesn't update.
            // The 'Different Name' from the second call is dropped on the floor.
            expect(second.name).toBe('Idempotency Test');
        } finally {
            await tryCleanup('delete', () =>
                client.auth.deleteAppContext({ contextId, confirm: contextId }));
        }
    });

    test('malformed contextId rejected with 400 + friendly message', async () => {
        // The contextId format /^[a-z][a-z0-9-]{2,30}$/ is enforced. A leading
        // digit violates the "starts with lowercase letter" rule.
        await expect(client.auth.createAppContext({ body: {
            contextId: '9bad-start', name: 'invalid',
        } })).rejects.toMatchObject({ statusCode: 400 });
    });

    test('GET nonexistent context returns 404', async () => {
        // Well-formed but never-created contextId → 404, not 500.
        const missing = uniqueTag().slice(0, 31);
        await expect(client.auth.getAppContext({ contextId: missing }))
            .rejects.toMatchObject({ statusCode: 404 });
    });

    // End-to-end check that deleting an app context actually ERASES its
    // contents — not just that the status flips.
    //
    // A delete drains the ENTIRE context — records, documents, folders, schemas,
    // roles, access profiles — via a confirm-gated background cascade (`confirm`
    // must echo the contextId; without it the API returns 400 and nothing is
    // removed). To prove the destructive effect end-to-end we seed real content
    // spanning BOTH halves of what `#1029`'s content-drained gate walks —
    // schema/record/folder/document (the four context-scoped DATA models) AND a
    // role (an ACCESS model; the OTHER ACCESS model, the seeding access profile,
    // already exists as part of `provisionConfinedContext`'s own setup) — delete
    // the context, and assert each specific row is GONE (404), then poll until
    // the context row itself is gone too — not merely that it reports `purging`.
    //
    // Needs VECTROS_LIVE_TENANT_ID for the scoped-key mint that seeds context-
    // scoped data (a root key can't target a context for writes); skips when it
    // isn't set. Throwaway context + synthetic data only.
    //
    // SLOW TEST — per-test Jest timeout override (3rd arg), well above the
    // suite's 180s default (jest.config.js). No fast/slow tagging exists in
    // this harness, and one isn't worth adding for a single test: Jest's own
    // per-test override is the built-in, idiomatic mechanism here. Measured
    // live: ~3 minutes from an accepted delete to the context row's 404
    // (CONTEXT_GONE_TIMEOUT_MS's own budget + margin for everything before
    // it — the seed writes, the confirm-gate negatives, the per-row polls).
    const liveTenantId = process.env.VECTROS_LIVE_TENANT_ID;
    (liveTenantId && !SKIP_SLOW ? test : test.skip)(
        'DELETE destroy-path: 202 + confirm gate + the cascade drains seeded data-plane AND access-plane content, ' +
        'and the context row itself eventually 404s (SLOW — full teardown convergence, ~3min)',
        async () => {
        const rootKey = process.env.VECTROS_API_KEY!;
        const ctx = await provisionConfinedContext(liveTenantId!);
        const { contextId, api, ownerlessApi } = ctx;
        let tornDown = false;
        let roleId = '';
        try {
            // ── Seed the context-scoped data-plane content teardown must erase.
            // The schema is the lineage BASE for its typeName, so it must be
            // created ownerless — via the identity-less context-pinned token,
            // not the user-bound confined client (which can never make an
            // ownerless create).
            const typeName = ('t' + uniqueTag()).replace(/-/g, '').slice(0, 20);
            const schema = await ownerlessApi.schemas.createSchema({ body: {
                typeName, displayName: 'destroy-smoke', indexMode: 'TEXT',
                allowedSurfaces: ['record', 'document'],
                fields: [{ fieldId: 'name', fieldType: 'string', required: false, searchable: true }],
            } });
            const record = await api.records.createRecord({ body: {
                typeName, schemaId: schema.id!, payload: { name: 'destroy-smoke record' },
            } });
            const folder = await api.folders.createFolder({ body: { name: `destroy-smoke folder ${uniqueTag()}` } });
            const document = await api.documents.ingestDocument({ body: {
                title: 'destroy-smoke doc', schemaId: schema.id!,
                text: 'destroy-smoke document body', indexMode: 'TEXT', payload: { name: 'destroy-smoke doc' },
            } });

            // ── Seed the ACCESS-plane content — the OTHER half `#1029` pinned
            // coverage for. A root credential authors roles/profiles directly
            // (context administration is root-authority, not delegated to the
            // confined seeding key).
            roleId = ('drole' + uniqueTag()).slice(0, 31);
            await client.auth.createRole({
                contextId,
                body: { roleId, name: 'destroy-smoke role', scopes: [{ allowed_actions: ['records:r'] }] },
            });
            // The seeding access profile from provisionConfinedContext is ALSO
            // real context content — verify it drains too, rather than adding a
            // second one.
            const seedingPrincipalId = `usr_${ctx.userId}`;

            // The root key reads any context's rows by id — the surviving
            // verifier (teardown revokes the seeding scoped key). Confirm each
            // seeded row is real + readable BEFORE the teardown.
            const reads = {
                schema: () => client.schemas.getSchema({ id: schema.id! }),
                record: () => client.records.getRecord({ id: record.id! }),
                folder: () => client.folders.getFolder({ id: folder.id! }),
                document: () => client.documents.getDocument({ id: document.id! }),
                role: () => client.auth.getRole({ contextId, roleId }),
                accessProfile: () => client.auth.getAccessProfile({ contextId, principalId: seedingPrincipalId }),
            };
            for (const read of Object.values(reads)) await read();

            // ── Negative: a missing OR non-matching confirm token → 400, and
            // NOTHING is torn down (the confirm must echo the contextId exactly).
            expect(await rawDeleteAppContext(rootKey, contextId)).toBe(400);
            expect(await rawDeleteAppContext(rootKey, contextId, 'not-the-context-id')).toBe(400);
            expect((await client.auth.getAppContext({ contextId })).status).toBe('active');
            await reads.record(); // still readable — the rejected deletes were no-ops

            // ── Positive: matching confirm token → teardown accepted with 202.
            expect(await rawDeleteAppContext(rootKey, contextId, contextId)).toBe(202);
            tornDown = true;

            // The context leaves `active` (purging now) …
            const terminal = await pollUntilLeftActive(client, contextId);
            expect(['purging', 'deleted']).toContain(terminal);

            // … and — the crux — the delete ACTUALLY REMOVES the seeded content:
            // every row 404s within seconds. This, not the status flip, is the
            // proof the delete erased real data. Both DATA-model rows (already
            // covered) AND the ACCESS-model rows (#1029's other half) must drain —
            // an undrained role or access profile is exactly the shape the
            // registry-loop bug would have let slip through unnoticed.
            //
            // Run the six independent polls CONCURRENTLY (each row drains on its
            // own schedule, with no ordering dependency on the others) — the
            // overall wait is the SLOWEST row, not the sum of all six. This also
            // keeps real headroom under the outer Jest timeout below.
            await Promise.all([
                pollUntilGone(reads.record, `record ${record.id}`),
                pollUntilGone(reads.folder, `folder ${folder.id}`),
                pollUntilGone(reads.document, `document ${document.id}`),
                pollUntilGone(reads.schema, `schema ${schema.id}`),
                pollUntilGone(reads.role, `role ${roleId}`),
                pollUntilGone(reads.accessProfile, `access profile ${seedingPrincipalId}`),
            ]);

            // … and finally, the full convergence: once every registered model
            // reads empty, the background self-tick flips the context to
            // `deleted` and removes the row itself. This is the end-to-end proof
            // `contextContentEmpty`'s registry-driven loop (#1029) actually
            // reaches a terminal state, not just that it correctly holds the gate
            // open while content remains. Genuinely sequential after the above —
            // the context row can't be removed until every model above already
            // reads empty.
            await pollUntilGone(
                () => client.auth.getAppContext({ contextId }),
                `context ${contextId}`,
                CONTEXT_GONE_TIMEOUT_MS,
                5_000,
            );
        } catch (err) {
            // If we never reached a successful teardown, the throwaway context +
            // its seeding key are still live — revoke + cascade-delete them.
            if (!tornDown) {
                await tryCleanup('revoke key', () => client.auth.revokeScopedKey({ keyId: ctx.keyId }));
                await tryCleanup('delete context', () =>
                    client.auth.deleteAppContext({ contextId, confirm: contextId }));
            }
            await tryCleanup('delete user', () => client.identity.deleteUser({ id: ctx.userId }));
            throw err;
        }
        // Success: the cascade already revoked the key + drained the context;
        // only the tenant-level user (not context-scoped) remains to clean up.
        await tryCleanup('delete user', () => client.identity.deleteUser({ id: ctx.userId }));
    // 3rd-arg Jest per-test timeout — see the SLOW TEST note above. Derived from
    // CONTEXT_GONE_TIMEOUT_MS (the poll's own budget) + 60s margin for everything
    // else in the test (seed writes, confirm-gate negatives, the six now-
    // parallel per-row polls) — a computed relationship, not a second
    // hand-synced magic number that could silently drift from the poll's own.
    }, CONTEXT_GONE_TIMEOUT_MS + 60_000);
});
