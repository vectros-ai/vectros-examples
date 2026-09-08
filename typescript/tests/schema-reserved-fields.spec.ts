/**
 * schema-reserved-fields.spec.ts — the field ids a schema may not declare `filterable: true`.
 *
 * A filterable field's value is projected into the search-index metadata map. A handful of keys in
 * that map belong to the platform (the ownership axis and the type discriminator), and a filterable
 * field of the same name would shadow the platform's own value — a silent recall/precision loss that
 * nothing else reports. The declaration is refused instead.
 *
 * Three properties this spec exists to pin, and they regress in different directions:
 *
 *   PER SURFACE, not the union. The record and document models write different key sets, and a
 *   schema is checked against only the surfaces it binds to. Reserving the union would reject
 *   perfectly good document-only and record-only schemas.
 *
 *   FILTERABLE only. A non-filterable field never reaches the metadata map, so a field of any name
 *   is fine as long as it is not filterable.
 *
 *   BOTH SETS for a schema binding BOTH surfaces. Per-surface must not become "whichever surface the
 *   check happened to look at first".
 *
 * `status` is deliberately NOT reserved on either surface — a very common business field name that
 * the platform no longer writes into the index.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

describe('schemas: reserved search-index metadata field ids', () => {
    const createdSchemaIds: string[] = [];

    afterAll(async () => {
        for (const id of createdSchemaIds) {
            await tryCleanup(`delete schema ${id}`, () => client.schemas.deleteSchema({ id }));
        }
    });

    function schemaBody(
        surfaces: string[],
        field: Record<string, unknown>,
    ): any {
        return {
            typeName: `smoke_reserved_${uniqueTag().replace(/-/g, '_')}`,
            displayName: 'Smoke Reserved Field',
            indexMode: 'NONE',
            allowedSurfaces: surfaces,
            fields: [field],
        };
    }

    async function expectRefused(surfaces: string[], fieldId: string): Promise<void> {
        await expect(client.schemas.createSchema({
            body: schemaBody(surfaces, { fieldId, fieldType: 'string', filterable: true }),
        })).rejects.toMatchObject({
            statusCode: 400,
            body: expect.objectContaining({
                // The message names the field and the reason, so a partner can act without guessing.
                message: expect.stringContaining(fieldId),
            }),
        });
    }

    async function expectAccepted(surfaces: string[], field: Record<string, unknown>): Promise<void> {
        const created = await client.schemas.createSchema({ body: schemaBody(surfaces, field) });
        createdSchemaIds.push(created.id!);
        expect(created.id).toBeTruthy();
    }

    // -------------------------------------------------------------------------
    // Refused
    // -------------------------------------------------------------------------

    describe('a filterable field may not shadow a platform key for a surface the schema binds to', () => {
        // The keys the record model writes.
        test.each(['tenantId', 'owner_id', 'folderId', 'rootFolderId', 'recordType'])(
            'record surface refuses filterable %s',
            async (fieldId) => { await expectRefused(['record'], fieldId); },
        );

        // The document model writes those plus two of its own.
        test.each(['model_type', 'title'])(
            'document surface refuses filterable %s',
            async (fieldId) => { await expectRefused(['document'], fieldId); },
        );
    });

    // -------------------------------------------------------------------------
    // Accepted — the three ways this check must NOT over-reach
    // -------------------------------------------------------------------------

    test('a NON-filterable field of a reserved name is fine', async () => {
        // It never reaches the metadata map, so there is nothing for it to shadow.
        await expectAccepted(['record'], { fieldId: 'recordType', fieldType: 'string', filterable: false });
    });

    test('a key only the OTHER surface writes is not a collision', async () => {
        // `title` and `model_type` are document-model keys. A record-only schema can never be bound
        // to a document, so neither is reachable from it.
        await expectAccepted(['record'], { fieldId: 'title', fieldType: 'string', filterable: true });
        await expectAccepted(['record'], { fieldId: 'model_type', fieldType: 'string', filterable: true });
    });

    test('`status` is reserved on neither surface', async () => {
        // The platform no longer publishes a record's lifecycle status into the index, so a schema is
        // free to use the name for a business field of its own — on either surface.
        await expectAccepted(['record'], { fieldId: 'status', fieldType: 'string', filterable: true });
        await expectAccepted(['document'], { fieldId: 'status', fieldType: 'string', filterable: true });
    });

    test('a schema binding BOTH surfaces is checked against BOTH key sets', async () => {
        // The complement of the per-surface rule, and the silent regression it guards: a
        // document-only key admitted because the check stopped at the record set (or the reverse).
        await expectRefused(['record', 'document'], 'title');       // document-side key
        await expectRefused(['record', 'document'], 'recordType');  // on both sets
    });

    test('the UPDATE path validates too, not just create', async () => {
        // The create-validates / update-does-not split is the exact shape two other fixes on this
        // release closed. A schema created clean and then edited to declare a reserved filterable
        // field must be refused on the way in.
        const created = await client.schemas.createSchema({
            body: schemaBody(['record'], { fieldId: 'recordType', fieldType: 'string', filterable: false }),
        });
        createdSchemaIds.push(created.id!);

        await expect(client.schemas.updateSchema({
            id: created.id!,
            body: {
                typeName: created.typeName!,
                displayName: 'Smoke Reserved Field',
                indexMode: 'NONE',
                allowedSurfaces: ['record'],
                fields: [{ fieldId: 'recordType', fieldType: 'string', filterable: true }],
            },
        })).rejects.toMatchObject({ statusCode: 400 });

        const unchanged = await client.schemas.getSchema({ id: created.id! });
        expect((unchanged.fields ?? []).find((f: any) => f.fieldId === 'recordType')?.filterable)
            .toBe(false);
    });

    test('an identity-only schema reserves nothing', async () => {
        // Identity models are not search-indexed at all, so there is no metadata map to collide with.
        await expectAccepted(['entity'], { fieldId: 'recordType', fieldType: 'string', filterable: true });
    });
});
