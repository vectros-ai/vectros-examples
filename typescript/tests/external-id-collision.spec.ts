/**
 * external-id-collision.spec.ts — an `externalId` can no longer be moved onto a slot another
 * resource already holds.
 *
 * An `externalId` is unique per type for a document and per namespace for an entity, and both
 * CREATE paths always enforced that. Neither UPDATE path re-checked it, so the identifier could be
 * moved onto an occupied slot and two resources would end up sharing one — after which every lookup
 * keyed on it resolved to an arbitrary one of the two, including `POST /v1/documents?upsert=true`,
 * which could then overwrite the wrong document with no error anywhere.
 *
 * There are two ways to reach it and they do not look alike, which is why both are here:
 *
 *   documents   the `externalId` VALUE was already immutable on update; what was mutable was its
 *               uniqueness SCOPE, because the scope is the bound schema's type. Re-typing the
 *               document moves the identifier without ever touching the identifier.
 *   entities    the ordinary shape — the value itself is changed.
 *
 * Each refusal is paired with the non-colliding move, because the change is narrow on purpose: only
 * the colliding case is refused, and a test that asserted only the 400 would be equally green
 * against an update path that had simply stopped working.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

describe('externalId collisions on the update paths', () => {
    const tag = uniqueTag().replace(/-/g, '_');

    describe('documents — a re-type moves the uniqueness scope', () => {
        const typeA = `smoke_xid_a_${tag}`;
        const typeB = `smoke_xid_b_${tag}`;
        const typeC = `smoke_xid_c_${tag}`;
        const schemaIds: Record<string, string> = {};
        const documentIds: string[] = [];
        const sharedExternalId = `xid-${uniqueTag()}`;
        let mover: string;

        beforeAll(async () => {
            for (const t of [typeA, typeB, typeC]) {
                const schema = await client.schemas.createSchema({ body: {
                    typeName: t,
                    displayName: `Smoke ExternalId ${t}`,
                    indexMode: 'NONE',
                    allowedSurfaces: ['document'],
                    fields: [{ fieldId: 'note', fieldType: 'string' }],
                } });
                schemaIds[t] = schema.id!;
            }

            // The document that will try to move, bound to type A.
            const a = await client.documents.ingestDocument({ body: {
                title: 'mover', text: 'x', indexMode: 'TEXT',
                schemaId: schemaIds[typeA], externalId: sharedExternalId,
            } });
            mover = a.id!;
            documentIds.push(mover);

            // The occupant: same externalId, already on type B. Legitimately allowed to coexist,
            // because uniqueness is per TYPE.
            const b = await client.documents.ingestDocument({ body: {
                title: 'occupant', text: 'y', indexMode: 'TEXT',
                schemaId: schemaIds[typeB], externalId: sharedExternalId,
            } });
            documentIds.push(b.id!);
        });

        afterAll(async () => {
            for (const id of documentIds) {
                await tryCleanup(`delete document ${id}`, () => client.documents.deleteDocument({ id }));
            }
            for (const id of Object.values(schemaIds)) {
                await tryCleanup(`delete schema ${id}`, () => client.schemas.deleteSchema({ id }));
            }
        });

        test('two documents may share an externalId across DIFFERENT types — the premise', async () => {
            // Stated as its own cell and read back from the server, not from this file's own
            // bookkeeping: if sharing were not legal the refusal below would be trivial, and would
            // stay green for the wrong reason if the second ingest had silently failed.
            const [first, second] = await Promise.all(
                documentIds.map((id) => client.documents.getDocument({ id })),
            );
            expect(first.externalId).toBe(sharedExternalId);
            expect(second.externalId).toBe(sharedExternalId);
            expect(first.schemaId).not.toBe(second.schemaId);
        });

        test('re-typing onto a type where the externalId is TAKEN is refused', async () => {
            await expect(client.documents.patchDocument({
                id: mover, body: { title: 'mover', schemaId: schemaIds[typeB] },
            })).rejects.toMatchObject({ statusCode: 400 });

            // The document is untouched — the refusal did not half-apply the re-type.
            const still = await client.documents.getDocument({ id: mover });
            expect(still.schemaId).toBe(schemaIds[typeA]);
        });

        // Runs whatever a cell did, so a mid-cell failure cannot leave `mover` on the wrong type and
        // redden the cells after it for an unrelated reason.
        afterEach(async () => {
            await tryCleanup('restore mover to type A', () => client.documents.patchDocument({
                id: mover, body: { title: 'mover', schemaId: schemaIds[typeA] },
            }));
        });

        test('re-typing onto a type where it is FREE still works', async () => {
            // The control. Without it the cell above could pass against a re-type that had simply
            // stopped working.
            const moved = await client.documents.patchDocument({
                id: mover, body: { title: 'mover', schemaId: schemaIds[typeC] },
            });
            expect(moved.schemaId).toBe(schemaIds[typeC]);
            expect(moved.externalId).toBe(sharedExternalId);
        });

        test('a document with NO externalId re-types onto an occupied type freely', async () => {
            // A guard that treated a null identifier as a value would refuse every re-type of an
            // identifier-less document — and neither the refusal cell nor the free-type control
            // above can see that, because both documents carry one.
            const anonymous = await client.documents.ingestDocument({ body: {
                title: 'anonymous', text: 'z', indexMode: 'TEXT', schemaId: schemaIds[typeA],
            } });
            documentIds.push(anonymous.id!);
            const moved = await client.documents.patchDocument({
                id: anonymous.id!, body: { title: 'anonymous', schemaId: schemaIds[typeB] },
            });
            expect(moved.schemaId).toBe(schemaIds[typeB]);
        });

        test('re-sending the CURRENT schemaId of a document is unaffected', async () => {
            // A no-op re-type must not be read as a collision with the document itself.
            const same = await client.documents.patchDocument({
                id: mover, body: { title: 'mover', schemaId: schemaIds[typeA] },
            });
            expect(same.schemaId).toBe(schemaIds[typeA]);
        });
    });

    describe('identity entities — the value itself moves', () => {
        // 2-32 chars, lowercase letter first, then a-z 0-9 _ -
        const namespace = `ns${uniqueTag().replace(/[^a-z0-9]/g, '').slice(0, 24)}`;
        const occupiedExternalId = `taken-${uniqueTag()}`;
        const freeExternalId = `free-${uniqueTag()}`;
        let moverId: string;
        let occupantId: string;
        const moverExternalId = `mover-${uniqueTag()}`;

        beforeAll(async () => {
            await client.identity.registerNamespace({ body: {
                namespace, specificityRank: 500, entityBacked: true,
            } });
            const occupant = await client.identity.createEntity({
                namespace, body: { externalId: occupiedExternalId, name: 'occupant' },
            });
            occupantId = occupant.id!;
            const mover = await client.identity.createEntity({
                namespace, body: { externalId: moverExternalId, name: 'mover' },
            });
            moverId = mover.id!;
        });

        afterAll(async () => {
            for (const id of [moverId, occupantId]) {
                await tryCleanup(`delete entity ${id}`,
                    () => client.identity.deleteEntity({ namespace, id }));
            }
            await tryCleanup(`delete namespace ${namespace}`,
                () => client.identity.deleteNamespace({ namespace }));
        });

        test('moving onto an externalId another entity holds is refused', async () => {
            await expect(client.identity.updateEntity({
                namespace, id: moverId, body: { externalId: occupiedExternalId, name: 'mover' },
            })).rejects.toMatchObject({ statusCode: 400 });

            const still = await client.identity.getEntity({ namespace, id: moverId });
            expect(still.externalId).toBe(moverExternalId);
            // …and the occupant still holds it, so the refusal did not disturb the other row either.
            const occupant = await client.identity.getEntity({ namespace, id: occupantId });
            expect(occupant.externalId).toBe(occupiedExternalId);
        });

        afterEach(async () => {
            await tryCleanup('restore mover externalId', () => client.identity.updateEntity({
                namespace, id: moverId, body: { externalId: moverExternalId, name: 'mover' },
            }));
        });

        test('moving onto an UNUSED externalId still works', async () => {
            const moved = await client.identity.updateEntity({
                namespace, id: moverId, body: { externalId: freeExternalId, name: 'mover' },
            });
            expect(moved.externalId).toBe(freeExternalId);
        });

        test('the same externalId in a DIFFERENT namespace is not a collision', async () => {
            // Uniqueness is per namespace, so the occupant's identifier must be free in another one.
            // The documents half asserts its cross-type analogue explicitly; without this the entity
            // half would be equally green against a guard that had become tenant-wide.
            const other = `ns${uniqueTag().replace(/[^a-z0-9]/g, '').slice(0, 24)}`;
            // A distinct specificityRank: the value is unique per namespace, and reusing the
            // first one fails registration for a reason that has nothing to do with this test.
            await client.identity.registerNamespace({ body: {
                namespace: other, specificityRank: 501, entityBacked: true,
            } });
            const twin = await client.identity.createEntity({
                namespace: other, body: { externalId: occupiedExternalId, name: 'twin' },
            });
            expect(twin.externalId).toBe(occupiedExternalId);
            await tryCleanup(`delete twin ${twin.id}`,
                () => client.identity.deleteEntity({ namespace: other, id: twin.id! }));
            await tryCleanup(`delete namespace ${other}`,
                () => client.identity.deleteNamespace({ namespace: other }));
        });

        test('re-sending the CURRENT externalId of an entity is unaffected', async () => {
            const same = await client.identity.updateEntity({
                namespace, id: moverId, body: { externalId: moverExternalId, name: 'mover again' },
            });
            expect(same.externalId).toBe(moverExternalId);
        });
    });
});
