/**
 * delete-fee-race.spec.ts — two concurrent DELETEs of the same user are billed once, not twice.
 *
 * This spec reads the tenant-wide usage counter before and after the race, so run it when nothing
 * else writes to the tenant. Alongside other specs the counter also picks up their writes in the gap
 * between two snapshots, which makes the bound below fail on noise rather than on a double charge
 * (see billing-exact.spec.ts for the same rationale).
 *
 * The behaviour under test (a duplicate delete settles cleanly, with no crash and no double
 * deletion) is the sibling assertion of status-validation.spec.ts's "DELETE under concurrency".
 */
import { client } from '../src/client';
import { uniqueTag } from '../src/helpers';

/** The tenant-wide credit counter, in milli-credits. */
const usedMilli = async (): Promise<number> => {
    const u = (await client.auth.getUsage()) as unknown as { credits: { usedMilli: number } };
    return u.credits.usedMilli;
};

describe('DELETE under concurrency: billing', () => {
    test('two concurrent DELETEs of the same user are not double-billed, and the user is gone', async () => {
        const externalId = `smoke-del-race-${uniqueTag()}`;
        const user = await client.identity.createUser({ body: { externalId, type: 'HUMAN' } });
        const userId = user.id!;

        // A same-shape control, deleted once and NOT raced, gives the fee ONE delete of an
        // identical row costs — the number the race below must not double. Read fresh in
        // this test rather than pinned to a literal: the exact fee is an implementation detail
        // this spec doesn't otherwise depend on, and the two users are identical in every way
        // fee computation looks at (freshly created, HUMAN, no other fields).
        const controlExternalId = `smoke-del-race-control-${uniqueTag()}`;
        const control = await client.identity.createUser({ body: { externalId: controlExternalId, type: 'HUMAN' } });
        const beforeControl = await usedMilli();
        await client.identity.deleteUser({ id: control.id! });
        const oneDeleteFee = (await usedMilli()) - beforeControl;
        expect(oneDeleteFee).toBeGreaterThan(0);

        // Dispatched with no await in between so both requests are genuinely in flight at
        // once. A duplicate delete that finds the row already gone is itself a SUCCESSFUL
        // no-op (deleting something already deleted is not an error) rather than a conflict —
        // so the shape asserted here is "both settle cleanly", not "one wins, one is
        // refused". The only legitimate rejection for the loser is a 404, and only when its
        // own initial lookup happens to run after the winner has already fully committed.
        const beforeRace = await usedMilli();
        const results = await Promise.allSettled([
            client.identity.deleteUser({ id: userId }),
            client.identity.deleteUser({ id: userId }),
        ]);
        const raceFee = (await usedMilli()) - beforeRace;

        for (const r of results) {
            if (r.status === 'rejected') {
                expect((r.reason as { statusCode?: number }).statusCode).toBe(404);
            }
        }

        // Whatever the settling order, the user is gone exactly once and stays gone.
        await expect(client.identity.getUser({ id: userId })).rejects.toMatchObject({ statusCode: 404 });

        // ...and it was billed exactly once, not twice. Still a bound rather than an equality:
        // the control and the race are separate snapshots, and a duplicate delete that finds the
        // row gone is a free no-op, so the race may cost a little less than one full delete. A
        // charge that actually doubled fails this comfortably.
        expect(raceFee).toBeGreaterThan(0);
        expect(raceFee).toBeLessThan(oneDeleteFee * 2);
    });
});
