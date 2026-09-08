/**
 * scope-qualifier-axes.spec.ts — the `[:<qualifier>]` segment of a scope entry, through the real
 * mint path.
 *
 * A scope entry is `<resource>:<ops>[:<qualifier>]`. The qualifier is not one mechanism: different
 * resources correlate one for different op letters, and each is enforced somewhere different. A
 * qualifier that the enforcement path never asks about is SILENTLY INERT — it authors cleanly, reads
 * as a narrowing, and grants everything — so an entry whose qualifier would be ignored is refused at
 * authoring rather than accepted and quietly disregarded.
 *
 *   records / entities     a qualifier on EVERY op          (a record type, a namespace)
 *   documents / users      a qualifier on `s` ONLY          (the sensitive-reveal permit)
 *   profiles               a qualifier on `c`/`u`/`d` ONLY  (a principal, or the `self` sentinel)
 *   scripts                a qualifier on `x` ONLY          (a script name)
 *
 * These are asserted against the deployed mint rather than against the grammar in isolation, because
 * the property worth having is that a credential the platform actually HANDS OUT cannot carry an
 * inert qualifier.
 */
import { client } from '../src/client';

async function mint(action: string): Promise<{ ok: true; actions: string[] } | { ok: false; status: number; message: string }> {
    try {
        const minted: any = await client.auth.mintToken({ scope: { allowedActions: [action] } });
        return { ok: true, actions: minted.resolvedScope?.allowedActions ?? [] };
    } catch (e: any) {
        return { ok: false, status: e?.statusCode ?? 0, message: String(e?.body?.message ?? e?.message ?? '') };
    }
}

async function expectMintable(action: string): Promise<void> {
    const r = await mint(action);
    if (!r.ok) throw new Error(`expected '${action}' to be mintable, got ${r.status}: ${r.message}`);
    // `resolvedScope` echoes the entry verbatim, so the qualifier survived the round trip rather
    // than being quietly dropped on the way through.
    expect(r.actions).toContain(action);
}

async function expectRefused(action: string): Promise<void> {
    const r = await mint(action);
    if (r.ok) throw new Error(`expected '${action}' to be refused, but it minted: ${JSON.stringify(r.actions)}`);
    expect(r.status).toBe(400);
    // The message has to name the op letters, because the fix is to split the entry rather than to
    // drop the qualifier everywhere.
    expect(r.message).toMatch(/does not support a qualifier/i);
}

describe('scope qualifier axes', () => {
    describe('script-execute axis — scripts, `x` only', () => {
        test('bare scripts:x mints — every script in the context', async () => {
            await expectMintable('scripts:x');
        });

        test('scripts:x:<name> mints — that script, every version', async () => {
            // The qualifier is a NAME, never `name@vN`: a grant covers every version, so pushing a
            // new version does not silently invalidate a grant authored against the old one.
            await expectMintable('scripts:x:smoke-qualifier-probe');
        });

        test('scripts:c:<name> is refused — a qualifier on a push would be inert', async () => {
            await expectRefused('scripts:c:smoke-qualifier-probe');
        });

        test('scripts:cx:<name> is refused as MIXED', async () => {
            // Not because every letter is inert — `x` is not — but because at least one is, and one
            // shared qualifier segment cannot describe two different scopes.
            await expectRefused('scripts:cx:smoke-qualifier-probe');
        });

        test('unqualified scripts CRUD is unaffected', async () => {
            await expectMintable('scripts:cr');
        });
    });

    describe('the other three axes still hold', () => {
        // Included here rather than left implicit: `scripts:x` is a NEW axis, and the way a new axis
        // goes wrong is by widening the rule for everyone.
        test('sensitive-reveal: documents:s:<type> mints, documents:r:<type> does not', async () => {
            await expectMintable('documents:s:invoice');
            await expectRefused('documents:r:invoice');
        });

        test('principal: profiles:u:self mints, profiles:r:self does not', async () => {
            await expectMintable('profiles:u:self');
            await expectRefused('profiles:r:self');
        });

        test('CRUD: records and entities take a qualifier on EVERY op', async () => {
            // "every op" is the claim, so every letter is exercised — and `entities` is the second
            // member of that axis, which no cell reached before.
            for (const op of ['c', 'r', 'u', 'd']) {
                await expectMintable(`records:${op}:smoke_probe_type`);
                await expectMintable(`entities:${op}:smoke_probe_ns`);
            }
            // Both are on the sensitive-reveal set TOO, so `s` takes one as well — the case a
            // row-wise reading of the axis table gets wrong.
            await expectMintable('records:s:smoke_probe_type');
        });

        test('sensitive-reveal: users behaves like documents, not like records', async () => {
            // `users` is the axis member with no CRUD-side qualifier at all, so it is the one that
            // shows the axes are genuinely separate rather than one union.
            await expectMintable('users:s:smoke_probe_type');
            await expectRefused('users:r:smoke_probe_type');
        });
    });
});
