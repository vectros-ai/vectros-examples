/**
 * usage.spec.ts — Usage reporting endpoint structure, counts after real
 * operations, scope enforcement, live + test tenant breakdown, inference section.
 *
 * Assertions use >= (not ===) for accumulating counts because the test tenant
 * builds usage across runs within the same calendar month and other specs run
 * concurrently. Delta assertions (e.g. "+1 after a call") snapshot before/after
 * and compare to baseline rather than absolute counts.
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup, collectStream } from '../src/helpers';

// Local response shape — SDK exposes UsageReportResponse but its types are
// loose. Narrow here to what the assertions actually touch.
interface UsageReport {
    period: string;
    credits: { used: number; usedMilli: number; limit?: number };
    search: {
        queries: {
            text: { count: number };
            semantic: { count: number };
            hybrid: { count: number };
        };
    };
    documents?: {
        ingest?: {
            text?: { count: number };
            file?: { count: number };
        };
    };
    records?: {
        writes?: { count: number; indexCount?: number };
    };
    inference?: {
        balanceCents: number;
        endpoints: {
            chat?: { calls: number };
            rag?: { calls: number };
            ask?: { calls: number };
        };
    };
    tenants: {
        live: {
            id: string;
            credits: { used: number; usedMilli: number };
            search: { queries: { hybrid: { count: number } } };
            inference?: { balanceCents?: number; endpoints?: Record<string, { calls: number }> };
        };
        test: {
            id: string;
            credits: { used: number; usedMilli: number };
            search: { queries: { hybrid: { count: number } } };
            inference?: { balanceCents?: number; endpoints?: Record<string, { calls: number }> };
        };
    };
}

interface MintedToken {
    token: string;
    expiresAt: number;
}

describe('usage', () => {
    let schemaId: string;
    let recordType: string;
    let userId: string;

    beforeAll(async () => {
        recordType = 'smoke_usage_' + uniqueTag();
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Usage Test Schema',
            indexMode: 'HYBRID',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }],
            lookupFields: [{ fieldName: 'note', unique: false }],
        } });
        schemaId = schema.id!;
        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userId = user.id!;
    });

    afterAll(async () => {
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
        await tryCleanup('delete user', () => client.identity.deleteUser({ id: userId }));
    });

    // ANCHOR — the full response shape. If this fails, the contract changed.
    test('response structure is complete', async () => {
        const usage = (await client.auth.getUsage()) as unknown as UsageReport;
        expect(usage.period).toMatch(/^\d{4}-\d{2}$/);
        expect(usage.credits.used).toBeGreaterThanOrEqual(0);
        expect(usage.search.queries.text.count).toBeGreaterThanOrEqual(0);
        expect(usage.search.queries.semantic.count).toBeGreaterThanOrEqual(0);
        expect(usage.search.queries.hybrid.count).toBeGreaterThanOrEqual(0);
        expect(usage.tenants.live.id).toBeTruthy();
        expect(usage.tenants.test.id).toBeTruthy();
    });

    test('search queries increment hybrid count by >= 3 after 3 searches', async () => {
        const before = (await client.auth.getUsage()) as unknown as UsageReport;
        const baseline = before.search.queries.hybrid.count;
        // Three throwaway searches. Counts are tracked at the account level on
        // every search regardless of result count.
        for (let i = 0; i < 3; i++) {
            await client.search.content({ query: 'usage-counter-probe-' + i, mode: 'HYBRID', limit: 1 });
        }
        const after = (await client.auth.getUsage()) as unknown as UsageReport;
        expect(after.search.queries.hybrid.count).toBeGreaterThanOrEqual(baseline + 3);
    });

    test('document ingest increments text count by >= 1', async () => {
        const before = (await client.auth.getUsage()) as unknown as UsageReport;
        const baseline = before.documents?.ingest?.text?.count ?? 0;
        const doc = await client.documents.ingestDocument({ body: {
            title: 'Usage Probe ' + uniqueTag(),
            text: 'Short body. Usage counter probe for documentingest_text.',
            indexMode: 'TEXT',
        } });
        try {
            // Counter ticks at ingest dispatch (before INDEXED completes) — no need
            // to wait for indexing here. If this becomes flaky, poll until INDEXED.
            const after = (await client.auth.getUsage()) as unknown as UsageReport;
            const newCount = after.documents?.ingest?.text?.count ?? 0;
            expect(newCount).toBeGreaterThanOrEqual(baseline + 1);
        } finally {
            await tryCleanup('delete probe doc', () => client.documents.deleteDocument({ id: doc.id! }));
        }
    });

    test('record write increments writes.count and writes.indexCount', async () => {
        const before = (await client.auth.getUsage()) as unknown as UsageReport;
        const baselineCount  = before.records?.writes?.count ?? 0;
        const baselineLookup = before.records?.writes?.indexCount ?? 0;
        // Record write: 1 base write + 1 index (the `note` lookup field; no ownership ids set).
        // writes.indexCount carries the per-write logical INDEX credit count (ownership +
        // externalId + schema lookups, weighted equality=1/range=3) — here the single equality `note`
        // field is 1 credit, so the `>= +1` delta holds.
        // typeName must match the schema's typeName (set in beforeAll with a
        // unique tag) — using a literal here previously caused a 400 "typeName
        // does not match the referenced schema".
        const rec = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId,
            payload: { note: 'usage-probe-' + uniqueTag() },
        } });
        try {
            const after = (await client.auth.getUsage()) as unknown as UsageReport;
            expect((after.records?.writes?.count ?? 0)).toBeGreaterThanOrEqual(baselineCount + 1);
            expect((after.records?.writes?.indexCount ?? 0)).toBeGreaterThanOrEqual(baselineLookup + 1);
        } finally {
            await tryCleanup('delete probe record', () => client.records.deleteRecord({ id: rec.id! }));
        }
    });

    test('explicit year/month returns same period as default', async () => {
        const def = (await client.auth.getUsage()) as unknown as UsageReport;
        const [yStr, mStr] = def.period.split('-');
        const explicit = (await client.auth.getUsage({
            year: parseInt(yStr, 10),
            month: parseInt(mStr, 10),
        })) as unknown as UsageReport;
        expect(explicit.period).toBe(def.period);
        // Usage is monotonically non-decreasing within a period. Async billing
        // settlement from prior tests in this run (the chat-billing test runs
        // two tests earlier) can land between these two back-to-back calls, so
        // strict equality was racy and caused intermittent failures (delta of
        // ~10 millicents = one chat-call settlement). Assert explicit ≥ default
        // — catches real bugs (wrong period, wildly different value) while
        // tolerating settlement that arrives mid-test.
        expect(explicit.credits.usedMilli).toBeGreaterThanOrEqual(def.credits.usedMilli);
        // Bound the drift so a real divergence (e.g. explicit returns a
        // different month's data) still trips the test. 1000 millicents = 1 cent
        // — comfortably above any plausible in-flight-settlement burst, well
        // below any cross-period divergence.
        expect(explicit.credits.usedMilli - def.credits.usedMilli).toBeLessThan(1000);
    });

    test('scoped token with billing:r can call getUsage', async () => {
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['billing:r'] },
        })) as MintedToken;
        const scoped = getScopedClient(minted.token);
        // billing:r is the documented scope for /v1/usage — call should succeed.
        const usage = (await scoped.auth.getUsage()) as unknown as UsageReport;
        expect(usage.period).toMatch(/^\d{4}-\d{2}$/);
    });

    test('scoped token without billing:r is rejected (403)', async () => {
        // Mint a token with an unrelated scope — records:r doesn't grant
        // billing access. Must reject with a uniform 403.
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['records:r'] },
        })) as MintedToken;
        const scoped = getScopedClient(minted.token);
        await expect(scoped.auth.getUsage()).rejects.toMatchObject({ statusCode: 403 });
    });

    // -------------------------------------------------------------------
    // 0.40.0 — GET /v1/usage context-confined narrowing: a token confined
    // to one app context sees a `contexts` breakdown restricted to that
    // context, and naming a DIFFERENT context via ?contextId= is refused.
    // -------------------------------------------------------------------
    describe('context-confined narrowing', () => {
        test('a context-confined token\'s contexts[] breakdown is restricted to its own context', async () => {
            const ctxA = ('usg' + uniqueTag()).slice(0, 31);
            await client.auth.createAppContext({ body: { contextId: ctxA, name: 'usage narrowing spec' } });
            let schemaId: string | undefined;
            let recId: string | undefined;
            try {
                const minted = (await client.auth.mintToken({
                    contextId: ctxA, scope: { allowedActions: ['billing:r', 'records:c', 'schemas:c'] },
                })) as MintedToken;
                const scoped = getScopedClient(minted.token);

                // Generate real billable activity IN ctxA — a brand-new, otherwise-idle
                // context has nothing in its `usage.contexts` breakdown, which would make
                // the narrowing assertion below pass VACUOUSLY (the loop just never runs).
                // Schemas are context-scoped: a root createSchema with no context binding
                // lands in the tenant-wide default context, unreachable from a
                // ctxA-confined token — so the schema must be created BY the ctxA-confined
                // token itself (the same "ownerless bootstrap" pattern other specs in this
                // suite use).
                const recordType = `smoke_usage_narrow_${uniqueTag()}`;
                const schema = await scoped.schemas.createSchema({ body: {
                    typeName: recordType, displayName: 'Usage Narrowing Probe', indexMode: 'NONE',
                    allowedSurfaces: ['record'],
                    fields: [{ fieldId: 'note', fieldType: 'string', required: false }],
                } });
                schemaId = schema.id!;
                const rec = await scoped.records.createRecord({ body: {
                    typeName: recordType, schemaId, payload: { note: 'usage narrowing probe' },
                } });
                recId = rec.id!;

                const usage = (await scoped.auth.getUsage()) as unknown as UsageReport & { contexts?: { contextId?: string }[] };
                const seenContexts = (usage.contexts ?? []).map((c) => c.contextId);
                // Non-empty first — otherwise the per-entry loop below would silently
                // skip and this test would pass no matter what the breakdown contains.
                expect(seenContexts.length).toBeGreaterThan(0);
                // Every entry in the breakdown must be this token's OWN context —
                // no sibling context's row leaks through.
                for (const c of seenContexts) expect(c).toBe(ctxA);
            } finally {
                if (recId) await tryCleanup('probe record', () => client.records.deleteRecord({ id: recId! }));
                if (schemaId) await tryCleanup('probe schema', () => client.schemas.deleteSchema({ id: schemaId! }));
                await tryCleanup('context', () => client.auth.deleteAppContext({ contextId: ctxA, confirm: ctxA }));
            }
        });

        test('a context-confined token naming a DIFFERENT context via ?contextId= is refused', async () => {
            const ctxA = ('usgb' + uniqueTag()).slice(0, 31);
            const ctxB = ('usgc' + uniqueTag()).slice(0, 31);
            await client.auth.createAppContext({ body: { contextId: ctxA, name: 'usage narrowing spec A' } });
            await client.auth.createAppContext({ body: { contextId: ctxB, name: 'usage narrowing spec B' } });
            try {
                const minted = (await client.auth.mintToken({
                    contextId: ctxA, scope: { allowedActions: ['billing:r'] },
                })) as MintedToken;
                const scoped = getScopedClient(minted.token);
                // Measured live: naming a context outside the token's own reach is an
                // authorization refusal (403), not a structural validation error.
                await expect(scoped.auth.getUsage({ contextId: ctxB })).rejects.toMatchObject({ statusCode: 403 });
            } finally {
                await tryCleanup('context A', () => client.auth.deleteAppContext({ contextId: ctxA, confirm: ctxA }));
                await tryCleanup('context B', () => client.auth.deleteAppContext({ contextId: ctxB, confirm: ctxB }));
            }
        });
    });

    describe('inference section', () => {
        test('inference.balanceCents is non-negative', async () => {
            const usage = (await client.auth.getUsage()) as unknown as UsageReport;
            // balanceCents is your pre-paid inference ledger — can be 0
            // but never negative (deduct path floors at 0 + queues recharge).
            expect(usage.inference?.balanceCents ?? 0).toBeGreaterThanOrEqual(0);
        });

        test('inference.endpoints has chat / rag / ask keys', async () => {
            const usage = (await client.auth.getUsage()) as unknown as UsageReport;
            // All three endpoints should be present in the response shape even
            // if their `calls` count is 0 — defaulting is per-endpoint, not
            // omit-when-zero.
            expect(usage.inference?.endpoints).toBeDefined();
            expect(usage.inference?.endpoints).toHaveProperty('chat');
            expect(usage.inference?.endpoints).toHaveProperty('rag');
            expect(usage.inference?.endpoints).toHaveProperty('ask');
        });

        test('inference.endpoints.chat.calls increments after a /v1/chat call', async () => {
            const before = (await client.auth.getUsage()) as unknown as UsageReport;
            const baseline = before.inference?.endpoints?.chat?.calls ?? 0;
            // Single trivial chat call. Counter ticks in finalizeResponse() after
            // the stream completes — drain the stream to ensure that runs.
            const stream = (await client.inference.chatInference({
                messages: [{ role: 'user', content: 'Reply with exactly one word: ok' }],
            })) as unknown as AsyncIterable<unknown>;
            await collectStream(stream);
            const after = (await client.auth.getUsage()) as unknown as UsageReport;
            const newCount = after.inference?.endpoints?.chat?.calls ?? 0;
            expect(newCount).toBeGreaterThanOrEqual(baseline + 1);
        });

        test('tenants.live.inference is present with same shape', async () => {
            const usage = (await client.auth.getUsage()) as unknown as UsageReport;
            // Per-tenant inference observability — same endpoint keys as
            // the account-level section. Token counts are tracked per tenant.
            expect(usage.tenants.live.inference).toBeDefined();
            expect(usage.tenants.live.inference?.endpoints).toBeDefined();
            expect(usage.tenants.live.inference?.endpoints).toHaveProperty('chat');
            expect(usage.tenants.live.inference?.endpoints).toHaveProperty('rag');
            expect(usage.tenants.live.inference?.endpoints).toHaveProperty('ask');
        });
    });
});
