/**
 * provider-alias.spec.ts: a request that names a provider alias the tenant has not configured.
 *
 * Inference requests may carry a `providerAlias` to route through a provider configuration the
 * tenant registered itself. An alias that does not resolve to an active configuration for this
 * tenant is refused with a 403 that names the alias, never silently served by the platform's own
 * models: a caller who asked for their own provider must not be billed for, or answered by,
 * something else.
 *
 * The refusal is what this file can prove from a smoke client. The success path needs a provider
 * credential and a signed waiver, neither of which a shared test tenant holds, so it is covered
 * at the unit level instead. All three inference routes accept the field, and each is checked.
 *
 * The control call (same request, no alias) is what keeps the refusal honest: without it a 403
 * could be any unrelated failure of the route.
 */
import { client } from '../src/client';
import { collectStream, uniqueTag, withRateLimitRetry } from '../src/helpers';

type Rejection = { statusCode?: number; body?: { message?: string } };

// These routes stream, and the alias is checked before the stream opens, so the refusal can surface
// as a thrown request or as an error on the first iteration. Handle both.
async function rejectionOf(open: () => Promise<unknown>): Promise<Rejection | null> {
    try {
        const stream = (await withRateLimitRetry(open)) as AsyncIterable<unknown>;
        await collectStream(stream);
        return null;
    } catch (err) {
        return err as Rejection;
    }
}

function expectAliasRefused(rejected: Rejection | null, alias: string): void {
    expect(rejected).not.toBeNull();
    expect(rejected!.statusCode).toBe(403);
    // Pin the refusal to the alias check (not a missing scope or a residency refusal).
    expect(rejected!.body?.message ?? '').toMatch(/provider alias/i);
    expect(rejected!.body?.message ?? '').toContain(alias);
}

describe('provider alias', () => {
    const alias = `smoke-no-such-alias-${uniqueTag()}`;

    test('chat: an alias the tenant has not configured is refused with 403', async () => {
        const rejected = await rejectionOf(() => client.inference.chatInference({
            messages: [{ role: 'user', content: 'Reply with one word: ok' }],
            maxTokens: 8,
            providerAlias: alias,
        }));
        expectAliasRefused(rejected, alias);
    });

    test('rag: an alias the tenant has not configured is refused with 403', async () => {
        const rejected = await rejectionOf(() => client.inference.ragInference({
            query: 'provider alias smoke probe',
            maxTokens: 8,
            providerAlias: alias,
        }));
        expectAliasRefused(rejected, alias);
    });

    test('document ask: an alias the tenant has not configured is refused with 403, before the document is looked up', async () => {
        // The alias is resolved before the document is read, so an id that does not exist must still
        // produce the alias refusal rather than a 404.
        const rejected = await rejectionOf(() => client.inference.documentAsk({
            id: '11111111-1111-1111-1111-111111111111',
            prompt: 'Reply with one word: ok',
            maxTokens: 8,
            providerAlias: alias,
        }));
        expectAliasRefused(rejected, alias);
    });

    test('control: the same chat call without an alias is served normally', async () => {
        const stream = (await client.inference.chatInference({
            messages: [{ role: 'user', content: 'Reply with exactly one word: ok' }],
            maxTokens: 8,
        })) as unknown as AsyncIterable<{ event?: string }>;
        const events = await collectStream(stream);
        expect(events.find((e) => e.event === 'done')).toBeDefined();
    });
});
