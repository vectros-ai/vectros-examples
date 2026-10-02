/**
 * residency.spec.ts: inference region confinement.
 *
 * Inference is served from a US region by default. A request may opt into
 * lower-cost global (non-US) processing via `allowGlobalRegion: true`, but only
 * if the tenant holds a signed global-processing waiver that enables per-request
 * override. An un-entitled tenant that asks for global serving is refused with a
 * 403, never silently moved to a cheaper region the caller didn't expect and
 * never silently charged a different rate.
 *
 * The test tenant has no global waiver, so the opt-in must be refused, and the
 * same call without the flag must still succeed. This covers where the model runs
 * for a request. It says nothing about where stored data lives.
 *
 * The companion `/v1/models` region-pricing assertions live in models.spec.ts.
 */
import { client } from '../src/client';
import { collectStream } from '../src/helpers';

describe('inference region confinement', () => {
    test('un-entitled tenant requesting global region is rejected with 403', async () => {
        // chatInference is a streaming endpoint; the region check runs BEFORE
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
        // Pin the rejection to the region check specifically (not an unrelated
        // 403 such as a missing scope) by checking the message names the cause.
        const body = (rejected as { body?: { message?: string } }).body;
        expect(body?.message ?? '').toMatch(/region|global|residenc|permit/i);
    });

    test('default (US) inference is served normally: only the global opt-in is refused', async () => {
        // Control: the SAME call WITHOUT the global opt-in succeeds. Proves the
        // 403 above is specifically the region check, not a broken inference
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
