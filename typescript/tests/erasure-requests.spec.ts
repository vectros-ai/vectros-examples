/**
 * erasure-requests.spec.ts — POST/GET /v1/erasure-requests.
 *
 * Zero smoke coverage existed for this surface despite substantial backend
 * unit-test coverage — nothing exercised the actual public HTTP contract
 * end-to-end the way the rest of this suite does for every other surface.
 * This proves the black-box contract: submit,
 * poll to completion, and verify the certificate's own claims against the
 * ACTUAL post-erasure state (a row it says was deleted really 404s; a row
 * it says was shared/retained really still reads) — not just that the API
 * returned 200.
 *
 * SAFETY: the subject is a brand-new, uniquely-tagged user created by this
 * test and used by nothing else — erasure only ever removes rows that
 * subject SOLELY owns, and `contextScope` is pinned to a throwaway context
 * this test also creates, rather than left to "discover every context the
 * subject has data in" (harmless here since the subject has data in exactly
 * one context, but pinning it is the deliberate, documented-safe habit).
 * Requires a ROOT api key (createErasureRequest 403s any scoped credential).
 *
 * HISTORY: an earlier version of this cascade had a genuine backend bug — a
 * caller-supplied context scope was silently ignored in favor of a full-
 * tenant discovery pass, which could union in unrelated contexts and, on at
 * least one live repro, kept the job ticking indefinitely without ever
 * reaching a terminal status. That was a real regression and was fixed at
 * its resolution step. This comment is about a DIFFERENT, later finding —
 * don't read "convergence is slow, not broken" as retroactively excusing
 * that earlier bug; it was a bug, and got fixed as one.
 *
 * CONVERGENCE IS SLOW, NOT BROKEN (this finding). This is a real async,
 * self-rescheduling backend job (the engine reschedules its own next tick,
 * same shape as the app-context teardown job in app-contexts.spec.ts), and
 * it genuinely takes several minutes to reach a terminal status even for
 * this test's minimal two-record shape. First traced live against staging
 * via direct reads of the job's own checkpoint row: every step (resolution,
 * the dangling-reference scan, one sweep per participating model, the
 * identity sweep, finalize) completed correctly and in order, with the right
 * end state (the solely-owned record actually gone, the co-owned one
 * correctly retained and reported as shared) — that run took ~568s (~9.5min)
 * of real wall-clock to get there. Reproduced on two further live runs of
 * this exact test (its own client-side poll, not a repeated checkpoint
 * trace), converging at ~576s and ~553s respectively — a tight, consistent
 * ~553-576s range across all three. The backend's own
 * scheduling target for a single tick is much shorter than that; the
 * measured gap is the shared dispatcher's own polling cadence, a fixed,
 * infrastructure-wide interval well above that target, which a single job's
 * own reschedule delay can't shorten. `ERASURE_DONE_TIMEOUT_MS` below is set
 * well above the measured range (not derived from the dispatcher's own
 * worst-case interval math, which leaves little to no margin over the
 * measured figures) — see its own comment. Internally, the Vectros team's own
 * copy of this suite runs this test concurrently with the rest, so its long
 * wall-clock time doesn't serialize after everything else — a forked copy of
 * this suite runs it in plain sequence like any other spec, and simply takes
 * longer end-to-end as a result; `SMOKE_SKIP_SLOW=true` (see `SKIP_SLOW`
 * below) skips it for a faster local iteration loop.
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup, sleep, SKIP_SLOW } from '../src/helpers';

interface MintedToken { token: string; expiresAt: number; }
interface ErasureResponse {
    requestId?: string;
    status?: 'accepted' | 'processing' | 'completed' | 'failed';
    failureReason?: string;
    certificate?: {
        contextsSwept?: string[];
        danglingReferences?: number;
        sharedRowsSkipped?: number;
    };
}

/** Budget for the erasure job to reach a terminal status. Three live staging
 *  runs of this exact shape (one solely-owned + one co-owned record, one
 *  context) converged correctly in a tight ~553-576s (~9.3-9.6min) range —
 *  see the file header. Deliberately NOT derived from the dispatcher's own
 *  stated worst-case cadence (nine steps at up to ~90s each, plus up to one
 *  more poll interval of initial dispatch latency, leaves ~900s with
 *  essentially no margin over that arithmetic) — sized instead as a healthy
 *  multiple of the actual measured range, so a run landing anywhere near the
 *  slow end of a real tick's variance still has real headroom rather than
 *  cutting it exactly at a computed edge. */
const ERASURE_DONE_TIMEOUT_MS = 1_200_000;

async function pollErasureUntilDone(requestId: string): Promise<ErasureResponse> {
    const deadline = Date.now() + ERASURE_DONE_TIMEOUT_MS;
    let last: ErasureResponse = {};
    while (Date.now() < deadline) {
        last = (await client.compliance.getErasureRequest({ id: requestId })) as ErasureResponse;
        if (last.status === 'completed' || last.status === 'failed') return last;
        await sleep(10_000);
    }
    throw new Error(`erasure request ${requestId} did not reach a terminal status within ${ERASURE_DONE_TIMEOUT_MS}ms (last: ${JSON.stringify(last)})`);
}

describe('erasure requests', () => {
    // SLOW — real convergence takes ~9.5min against staging; see the file
    // header. Gated per-test (not per-describe) so SKIP_SLOW doesn't also
    // drop the fast 403-refusal test below — mirrors app-contexts.spec.ts's
    // own per-test SLOW gate.
    (SKIP_SLOW ? test.skip : test)('submits, converges to completed, and the certificate\'s claims match the actual post-erasure state', async () => {
        const ctxId = ('erase' + uniqueTag()).slice(0, 31);
        await client.auth.createAppContext({ body: { contextId: ctxId, name: 'erasure-requests spec' } });

        const subject = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        const org = await client.identity.createEntity({ namespace: 'org', body: {
            externalId: 'erasure-org-' + uniqueTag(), name: 'Erasure Spec Org',
        } });

        await client.auth.createAccessProfile({
            contextId: ctxId,
            body: {
                principalId: `usr_${subject.id}`,
                // TWO clauses, not one clause naming both dimensions: a
                // clause's data_scope keys must ALL match the resulting
                // ownership (measured live — a single clause naming both
                // userId and scope:org refused a create whose ownership was
                // userId-only, i.e. it demanded EVERY named dimension be
                // present, not just narrowed one that happened to apply).
                // Clause A covers the solely-owned record (userId only);
                // clause B covers the co-owned one (userId + scope:org,
                // matching that record's actual resulting ownership exactly).
                scopes: [
                    {
                        allowed_actions: ['records:c', 'records:r', 'schemas:r'],
                        data_scope: { userId: [subject.id!] } as unknown as Record<string, Record<string, unknown>>,
                    },
                    {
                        allowed_actions: ['records:c'],
                        data_scope: { userId: [subject.id!], 'scope:org': [org.id!] } as unknown as Record<string, Record<string, unknown>>,
                    },
                ],
            },
        });
        const minted = await client.auth.createScopedKey({
            keyName: 'erasure-subject-' + uniqueTag(),
            tenantId: process.env.VECTROS_LIVE_TENANT_ID!, contextId: ctxId, userId: subject.id!,
        });
        const subjectApi = getScopedClient(minted.rawKey!);

        // Schemas are context-scoped — a root create with no context binding
        // lands elsewhere (RESERVED_DEFAULT), unreachable from a credential
        // confined to ctxId. An identity-less token confined to ctxId (no
        // owner stamped) is the same "ownerless bootstrap" pattern
        // app-contexts.spec.ts uses to seed its own first-of-type schema.
        const bootstrap = (await client.auth.mintToken({
            contextId: ctxId, scope: { allowedActions: ['schemas:c', 'schemas:r'] },
        })) as MintedToken;
        const ownerlessApi = getScopedClient(bootstrap.token);

        const recordType = `smoke_erasure_${uniqueTag()}`;
        const schema = await ownerlessApi.schemas.createSchema({ body: {
            typeName: recordType, displayName: 'Erasure Probe', indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'note', fieldType: 'string', required: false }],
        } });

        // Solely-owned: stamped with the subject's own userId only (no scopes) —
        // this row must be GONE after erasure.
        const solelyOwned = await subjectApi.records.createRecord({ body: {
            typeName: recordType, schemaId: schema.id!, payload: { note: 'solely owned' },
        } });
        // Co-owned: ALSO scoped to the org — a second live ownership dimension
        // beyond the subject, so this row must SURVIVE erasure (reported as
        // shared, never deleted).
        const coOwned = await subjectApi.records.createRecord({ body: {
            typeName: recordType, schemaId: schema.id!, payload: { note: 'co-owned with org' },
            scopes: [`org:${org.id}`],
        } });

        let requestId: string | undefined;
        try {
            const submitted = (await client.compliance.createErasureRequest({
                subjectType: 'user', subjectId: subject.id!, contextScope: [ctxId],
            })) as ErasureResponse;
            requestId = submitted.requestId;
            expect(requestId).toBeTruthy();
            expect(['accepted', 'processing']).toContain(submitted.status);

            const done = await pollErasureUntilDone(requestId!);
            expect(done.status).toBe('completed');
            expect(done.certificate?.contextsSwept ?? []).toContain(ctxId);
            // The certificate's own claim: at least one shared row was skipped
            // (our co-owned record) and reported, not silently ignored.
            expect(done.certificate?.sharedRowsSkipped ?? 0).toBeGreaterThanOrEqual(1);

            // Verify the certificate's claims against ACTUAL state, not just its
            // own say-so: the solely-owned record is really gone...
            await expect(client.records.getRecord({ id: solelyOwned.id! }))
                .rejects.toMatchObject({ statusCode: 404 });
            // ...and the co-owned one really still reads (shared rows are
            // reported, never deleted).
            const stillThere = await client.records.getRecord({ id: coOwned.id! });
            expect(stillThere.id).toBe(coOwned.id);

            // The subject's own identity row is gone too (erasure removes the
            // subject's identity + lookup rows, not just their data).
            await expect(client.identity.getUser({ id: subject.id! })).rejects.toMatchObject({ statusCode: 404 });
        } finally {
            // Best-effort only, and unconditional even for the subject/solely-owned
            // record: on the HAPPY path a completed erasure has already removed both
            // (their delete calls below just 404 harmlessly, swallowed by
            // tryCleanup) — but `pollErasureUntilDone` can also return a terminal
            // `status: 'failed'` (not a thrown exception) and reach the
            // `expect(done.status).toBe('completed')` line above, which throws
            // WITHOUT the erasure having removed anything. Cleaning up
            // unconditionally here (rather than assuming "completed ⇒ already gone")
            // avoids leaking the subject/record on that path.
            await tryCleanup('solely-owned record', () => client.records.deleteRecord({ id: solelyOwned.id! }));
            await tryCleanup('co-owned record', () => client.records.deleteRecord({ id: coOwned.id! }));
            await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schema.id! }));
            await tryCleanup('subject user', () => client.identity.deleteUser({ id: subject.id! }));
            await tryCleanup('org entity', () => client.identity.deleteEntity({ namespace: 'org', id: org.id! }));
            await tryCleanup('context', () => client.auth.deleteAppContext({ contextId: ctxId, confirm: ctxId }));
        }
    }, ERASURE_DONE_TIMEOUT_MS + 60_000);

    test('a scoped credential is refused (403) — erasure requires a root API key', async () => {
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['records:r'] },
        })) as MintedToken;
        const scoped = getScopedClient(minted.token);
        await expect(scoped.compliance.createErasureRequest({
            subjectType: 'user', subjectId: '00000000-0000-0000-0000-000000000000',
        })).rejects.toMatchObject({ statusCode: 403 });
    });
});

// -----------------------------------------------------------------------
// Metering — NOT covered here. The tenant+context burst limiter is the one
// mechanism a black-box smoke test could deterministically trigger
// (per-principal burst/quota and aggregate-banded billing are internal-only
// account flags with no partner-facing write path at all). But deliberately
// tripping it means sending enough requests within its 60s window to exceed
// this SHARED staging tenant's plan limit (a low default, but this tenant's
// actual plan/override isn't discoverable from smoke code, so the volume
// needed to trigger it safely can't be sized) — every OTHER spec in this
// suite already needs its own rate-limit-aware retry helper specifically
// because concurrent runs incidentally trip this same limiter; a test that
// deliberately maximizes that contention would make itself the noisiest
// neighbor on a resource every other spec already treats as scarce and
// shared. Disposed rather than force it — the erasure-request engine's
// convergence, covered above, was the larger and higher-value gap to close.
