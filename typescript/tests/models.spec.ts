/**
 * models.spec.ts — GET /v1/models — inference model catalog + plan gating.
 *
 * Verifies the catalog endpoint returns the expected set of models, that
 * pricing and plan-availability invariants hold, and that the default model
 * is accessible on the free plan (so you can run a `/v1/chat` call without
 * configuring a plan first).
 */
import { client } from '../src/client';

describe('inference models', () => {
    // ANCHOR — model catalog is present and structurally correct
    test('GET /v1/models returns catalog with required fields per model', async () => {
        const catalog = await client.inference.listInferenceModels();
        expect(catalog.models).toBeDefined();
        expect(Array.isArray(catalog.models)).toBe(true);
        expect(catalog.models.length).toBeGreaterThan(0);
        expect(catalog.defaultModel).toBeTruthy();

        // Plan tier allowlist — the set of plan tiers a model's availableOn
        // may reference. Keep this in sync with the plans your account offers;
        // any model whose availableOn includes a tier not listed here fails
        // this test even when the catalog is correct.
        const validPlans = new Set(['free', 'starter', 'pro', 'scale', 'enterprise']);
        for (const model of catalog.models) {
            expect(model.id).toBeTruthy();
            expect(model.name).toBeTruthy();
            expect(model.provider).toBeTruthy();
            expect(model.contextWindow).toBeGreaterThan(0);
            expect(model.inputCreditsPer1kTokens).toBeGreaterThan(0);
            expect(model.outputCreditsPer1kTokens).toBeGreaterThan(0);
            // Output rate is a per-model multiple of the input rate. Anthropic models are priced
            // 5:1; other providers carry their own output:input ratio, which differs per model, so
            // for those only the floor is pinned: an output token is never cheaper than an input
            // token. The exact ratios are the catalog's own data; pinning them here would go stale
            // with every price change, which is how this assertion went stale before.
            const ratio = model.outputCreditsPer1kTokens / model.inputCreditsPer1kTokens;
            if (model.provider === 'Anthropic') {
                expect(ratio).toBeCloseTo(5, 5);
            } else {
                expect(ratio).toBeGreaterThanOrEqual(1);
            }
            // availableOn enumerates which plan tiers can call the model
            expect(Array.isArray(model.availableOn)).toBe(true);
            expect(model.availableOn.length).toBeGreaterThan(0);
            for (const plan of model.availableOn) {
                expect(validPlans.has(plan)).toBe(true);
            }
        }
    });

    test('each model carries a regionPricing block consistent with its base rates', async () => {
        // The top-level inputCreditsPer1kTokens / outputCreditsPer1kTokens are the
        // BASE (global) rates; the US-served rate is base × the region premium.
        // The regionPricing block exposes both regions + the multiplier so you
        // can show region-aware pricing. This pins that block's shape and its
        // internal consistency.
        const catalog = await client.inference.listInferenceModels();
        for (const model of catalog.models) {
            const rp = model.regionPricing;
            expect(rp).toBeDefined();
            expect(rp.base).toBeDefined();
            expect(rp.us).toBeDefined();
            expect(typeof rp.globalAvailable).toBe('boolean');

            // The premium multiplier is >= 1.0 (US is never cheaper than base).
            expect(rp.regionPremiumFactor).toBeGreaterThanOrEqual(1.0);

            // base rates mirror the top-level (base == global.*) rates.
            expect(rp.base.input).toBeCloseTo(model.inputCreditsPer1kTokens, 5);
            expect(rp.base.output).toBeCloseTo(model.outputCreditsPer1kTokens, 5);

            // us == base × premium, on both input and output.
            expect(rp.us.input).toBeCloseTo(rp.base.input * rp.regionPremiumFactor, 4);
            expect(rp.us.output).toBeCloseTo(rp.base.output * rp.regionPremiumFactor, 4);
        }
    });

    test('default model is available on the free plan', async () => {
        // The default model is what gets used when callers omit `model` from
        // the request. Free-plan customers expect that path to work — gating
        // the default behind a paid tier would break new-developer onboarding.
        const catalog = await client.inference.listInferenceModels();
        const defaultModel = catalog.models.find(m => m.id === catalog.defaultModel);
        expect(defaultModel).toBeDefined();
        expect(defaultModel!.availableOn).toContain('free');
    });

    test('at least one model is gated to paid plans only (no free)', async () => {
        // We deliberately gate higher-tier models (Sonnet, Opus) to paid plans
        // to protect against margin leak. This test catches an accidental
        // "all models on all plans" regression.
        const catalog = await client.inference.listInferenceModels();
        const paidOnlyModels = catalog.models.filter(m => !m.availableOn.includes('free'));
        expect(paidOnlyModels.length).toBeGreaterThan(0);
    });

    test('catalog includes the current aliases and none of the retired ones', async () => {
        const catalog = await client.inference.listInferenceModels();
        const ids = catalog.models.map(m => m.id);
        // The current generation of aliases, including the non-Anthropic tiers.
        for (const expected of [
            'claude-haiku-4-5',
            'claude-haiku-5-5',
            'claude-sonnet-5',
            'claude-sonnet-5-5',
            'claude-opus-5-5',
            'amazon-nova-lite',
            'amazon-nova-2-lite',
            'meta-llama-4-scout',
            'meta-llama-4-maverick',
        ]) {
            expect(ids).toContain(expected);
        }
        // Retired aliases must no longer appear.
        expect(ids).not.toContain('claude-sonnet-4-5');
        expect(ids).not.toContain('claude-opus-4-7');
        expect(ids).not.toContain('claude-opus-4-8');
    });

    test('claude-haiku-5-5 carries a longContext rate card (5x over 100,000 prompt tokens) and no other model does', async () => {
        // Haiku 5.5 is priced by prompt length: a request whose prompt is longer than promptTokensOver is charged EVERY line at
        // the longContext rates. Standard 0.01/0.05 credits per 1K, longContext x5 = 0.05/0.25 (US x the region premium).
        const catalog = await client.inference.listInferenceModels();
        const byId = new Map(catalog.models.map((m): [string, any] => [m.id, m]));
        const h55 = byId.get('claude-haiku-5-5');
        expect(h55).toBeDefined();
        expect(h55.longContext).toBeDefined();
        expect(h55.longContext.promptTokensOver).toBe(100000);
        expect(h55.longContext.multiplier).toBeCloseTo(5.0, 6);
        expect(h55.longContext.base.input).toBeCloseTo(h55.inputCreditsPer1kTokens * 5, 6);
        expect(h55.longContext.base.output).toBeCloseTo(h55.outputCreditsPer1kTokens * 5, 6);
        expect(h55.longContext.us.input).toBeCloseTo(h55.longContext.base.input * h55.regionPricing.regionPremiumFactor, 6);
        for (const [id, model] of byId) {
            if (id !== 'claude-haiku-5-5') expect(model.longContext).toBeUndefined();
        }
    });

    test('the Claude models report their context windows and per-token rates', async () => {
        // Context windows are 1M tokens for the four newer Claude models (Haiku 4.5 keeps 200K), and the
        // Claude rates are credits per 1K tokens (1 credit = $0.01): Haiku 4.5 $1/$5, Sonnet 5 and 5.5 $2/$10, Opus 5.5
        // $4/$20 per million input/output tokens are the provider's list prices. Haiku 5.5 is $0.10/$0.50 per million for a
        // prompt of up to 100,000 tokens (the provider's list price) and 5x that above it: see the longContext
        // check below. The public pricing page should list the same figures; compare it with these rates when either changes.
        const catalog = await client.inference.listInferenceModels();
        const byId = new Map(catalog.models.map((m): [string, typeof m] => [m.id, m]));
        const expected: Array<[string, number, number, number]> = [
            ['claude-haiku-4-5', 200000, 0.1, 0.5],
            ['claude-haiku-5-5', 1000000, 0.01, 0.05],
            ['claude-sonnet-5', 1000000, 0.2, 1.0],
            ['claude-sonnet-5-5', 1000000, 0.2, 1.0],
            ['claude-opus-5-5', 1000000, 0.4, 2.0],
        ];
        for (const [id, window, input, output] of expected) {
            const model = byId.get(id);
            expect(model).toBeDefined();
            expect(model!.contextWindow).toBe(window);
            expect(model!.inputCreditsPer1kTokens).toBeCloseTo(input, 5);
            expect(model!.outputCreditsPer1kTokens).toBeCloseTo(output, 5);
        }
    });
});
