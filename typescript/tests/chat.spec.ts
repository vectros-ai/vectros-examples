/**
 * chat.spec.ts — POST /v1/chat streaming inference.
 *
 * Verifies the SSE event sequence (content_delta+ then done), the
 * split-billing fields on the done payload, and basic conversation handling.
 *
 * The SDK exposes streaming endpoints as async iterators. `collectStream`
 * (in src/helpers.ts) drains them into an array for synchronous assertion.
 */
import { client, getScopedClient } from '../src/client';
import { collectStream } from '../src/helpers';

interface MintedToken { token: string; expiresAt: number; }

/** Concatenate all content_delta text into the assistant's final reply. */
function joinDeltas(events: any[]): string {
    return events
        .filter((e) => e.event === 'content_delta')
        .map((e) => e.delta ?? e.text ?? e.content ?? '')
        .join('');
}

describe('inference: /v1/chat', () => {
    // ANCHOR — streaming chat returns deltas then a done event with billing fields
    test('chat stream produces content_delta events then a done event', async () => {
        const stream = await client.inference.chatInference({
            messages: [
                { role: 'user', content: 'Say "hello smoke test" exactly, no more.' },
            ],
            maxTokens: 32,
        });
        const events = await collectStream<any>(stream);

        // At least one content_delta, exactly one done, no error events
        const deltas = events.filter((e) => e.event === 'content_delta');
        const dones = events.filter((e) => e.event === 'done');
        const errors = events.filter((e) => e.event === 'error');

        expect(deltas.length).toBeGreaterThan(0);
        expect(dones.length).toBe(1);
        expect(errors.length).toBe(0);

        // Done payload — split-billing fields
        const done = dones[0];
        expect(done.inputTokens).toBeGreaterThan(0);
        expect(done.outputTokens).toBeGreaterThan(0);
        expect(done.model).toBeTruthy();
        expect(done.platformCreditsCharged).toBeGreaterThan(0);
        expect(done.inferenceBalanceCentsCharged).toBeGreaterThanOrEqual(0);
    });

    test('system message is honored (assistant follows the instruction)', async () => {
        // System instruction tells the assistant to ALWAYS open with a
        // specific marker. The reply should contain it.
        const marker = 'SMOKE_SYS_PROBE';
        const stream = await client.inference.chatInference({
            messages: [
                { role: 'system', content: `Always begin your response with the literal string "${marker}".` },
                { role: 'user',   content: 'Briefly state today is a good day.' },
            ],
            maxTokens: 60,
        });
        const events = await collectStream<any>(stream);
        expect(events.filter((e) => e.event === 'done')).toHaveLength(1);
        const reply = joinDeltas(events);
        // Models can be lazy with EXACT prefix; assert presence anywhere.
        expect(reply).toContain(marker);
    });

    test('multi-turn conversation — assistant responds to second user turn', async () => {
        // Send a prior assistant turn + a follow-up user question that
        // depends on the prior context. The assistant must answer the
        // follow-up coherently (we only assert a non-empty answer + done event).
        const stream = await client.inference.chatInference({
            messages: [
                { role: 'user',      content: 'My favorite color is teal.' },
                { role: 'assistant', content: 'Nice choice. Teal is a calm, balanced color.' },
                { role: 'user',      content: 'What did I just say my favorite color was?' },
            ],
            maxTokens: 32,
        });
        const events = await collectStream<any>(stream);
        const reply = joinDeltas(events).toLowerCase();
        expect(events.filter((e) => e.event === 'done')).toHaveLength(1);
        // Reasonable models will name the color; assert the substring.
        expect(reply).toContain('teal');
    });

    test('explicit model parameter routes to that model (verify done.model)', async () => {
        // Pick the default explicitly — known-available on the free plan.
        const model = 'claude-haiku-4-5';
        const stream = await client.inference.chatInference({
            messages: [{ role: 'user', content: 'Reply with one word: ok' }],
            model,
            maxTokens: 8,
        });
        const events = await collectStream<any>(stream);
        const done = events.filter((e) => e.event === 'done');
        expect(done).toHaveLength(1);
        // done.model is the resolved underlying model — should reflect the alias
        // we requested (may be expanded to a fully-qualified id with version).
        expect(done[0].model).toContain('haiku');
    });

    test('scoped token without inference:r returns 403 before stream opens', async () => {
        // Mint a records:r-only token. Inference must be rejected with 403.
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['records:r'] },
        })) as MintedToken;
        const scoped = getScopedClient(minted.token);
        await expect(scoped.inference.chatInference({
            messages: [{ role: 'user', content: 'hi' }],
            maxTokens: 8,
        })).rejects.toMatchObject({ statusCode: 403 });
    });
});
