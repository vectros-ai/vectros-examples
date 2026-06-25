/**
 * residency.spec.ts — data-residency confinement on the inference path.
 *
 * Inference is served in the US region by default. A request may opt into
 * lower-cost global (non-US) processing via `allowGlobalRegion: true`, but ONLY
 * if the tenant holds a signed global-processing waiver that enables per-request
 * override. The contract under test is FAIL-CLOSED: an un-entitled tenant that
 * asks for global serving is REJECTED with 403 — never a silent downgrade to a
 * cheaper region the caller didn't expect, and never a silent upcharge.
 *
 * The test tenant is a standard US-residency tenant (no global waiver), so the
 * opt-in must be refused. This is the proof of the residency boundary that
 * keeps sensitive data from leaving the contracted region.
 *
 * The companion `/v1/models` region-pricing assertions live in models.spec.ts.
 */
import { client } from '../src/client';
import { collectStream } from '../src/helpers';

describe('data residency confinement', () => {
    test('un-entitled tenant requesting global region is rejected 403 (fail-closed)', async () => {
        // chatInference is a streaming endpoint; the residency gate runs BEFORE
        // the stream opens, so the rejection can surface either as a thrown
        // request or as an error on first iteration. Handle both so the test is
        // robust to how the SDK threads the pre-stream 403.
        let rejected: { statusCode?: number } | null = null;
        try {
            const stream = (await client.inference.chatInference({
                messages: [{ role: 'user', content: 'Reply with one word: ok' }],
                maxTokens: 8,
                allowGlobalRegion: true,
            })) as unknown as AsyncIterable<unknown>;
            await collectStream(stream);
        } catch (err) {
            rejected = err as { statusCode?: number };
        }
        expect(rejected).not.toBeNull();
        expect(rejected!.statusCode).toBe(403);
        // Pin the rejection to the residency gate specifically (not an unrelated
        // 403 such as a missing scope) by checking the message names the cause.
        const body = (rejected as { body?: { message?: string } }).body;
        expect(body?.message ?? '').toMatch(/region|global|residenc|permit/i);
    });

    test('default (US) inference is served normally — the boundary blocks only the opt-out', async () => {
        // Control: the SAME call WITHOUT the global opt-in succeeds. Proves the
        // 403 above is specifically the residency gate, not a broken inference
        // path or an under-funded wallet.
        const stream = (await client.inference.chatInference({
            messages: [{ role: 'user', content: 'Reply with exactly one word: ok' }],
            maxTokens: 8,
        })) as unknown as AsyncIterable<{ event?: string; inferenceBalanceCentsCharged?: number }>;
        const events = await collectStream(stream);
        const done = events.find((e) => e.event === 'done');
        expect(done).toBeDefined();
        // US serving applies the region premium; the charge is a non-negative
        // number (exact COGS is asserted at the unit/integration layer).
        expect(done!.inferenceBalanceCentsCharged).toBeGreaterThanOrEqual(0);
    });
});
