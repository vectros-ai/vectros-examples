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
            // Output rate is 5x input rate (Anthropic pass-through pricing).
            expect(model.outputCreditsPer1kTokens)
                .toBeCloseTo(model.inputCreditsPer1kTokens * 5, 5);
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

    test('catalog includes claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-8 aliases', async () => {
        const catalog = await client.inference.listInferenceModels();
        const ids = catalog.models.map(m => m.id);
        // The current generation of aliases. Older aliases (Sonnet 4.5,
        // Opus 4.7) have been retired and must no longer appear.
        for (const expected of [
            'claude-haiku-4-5',
            'claude-sonnet-4-6',
            'claude-opus-4-8',
        ]) {
            expect(ids).toContain(expected);
        }
        // The retired aliases must no longer appear.
        expect(ids).not.toContain('claude-sonnet-4-5');
        expect(ids).not.toContain('claude-opus-4-7');
    });
});
