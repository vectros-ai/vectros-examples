/**
 * documents-untyped-externalid.spec.ts: an externalId needs a schemaId, or an explicit confirmation.
 *
 * A document's externalId is unique within its schema, not across the tenant. Supplying one without a
 * schemaId therefore lands the document in a separate UNTYPED slot, which is almost never what a caller
 * who simply forgot the schemaId meant: they would end up with a second copy beside the typed document
 * they were targeting, and no error to say so. The platform refuses that request with a 400 unless the
 * caller also passes `confirmUntyped: true`, which says the untyped slot is deliberate.
 *
 * The three outcomes are all pinned, because the refusal alone could be any 400:
 *   externalId, no schemaId            -> 400 naming both ways out
 *   externalId + confirmUntyped        -> created (the slot is deliberate)
 *   externalId + schemaId              -> created (the typed document is targeted)
 * and the file-upload route is held to the same rule, since it creates documents too.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

type Rejection = { statusCode?: number; body?: { message?: string } };

describe('documents: externalId without a schemaId', () => {
    const documentIds: string[] = [];
    const schemaIds: string[] = [];

    afterAll(async () => {
        for (const id of documentIds) {
            await tryCleanup('delete document', () => client.documents.deleteDocument({ id }));
        }
        for (const id of schemaIds) {
            await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id }));
        }
    });

    test('ingest is refused with 400 and the message names both ways out', async () => {
        let rejected: Rejection | null = null;
        let leaked: string | undefined;
        try {
            leaked = (await client.documents.ingestDocument({ body: {
                title: 'untyped externalId probe', text: 'n/a', indexMode: 'NONE',
                externalId: `untyped-${uniqueTag()}`,
            } })).id;
        } catch (err) {
            rejected = err as Rejection;
        }
        if (leaked) documentIds.push(leaked);
        expect(rejected).not.toBeNull();
        expect(rejected!.statusCode).toBe(400);
        expect(rejected!.body?.message ?? '').toContain('schemaId');
        expect(rejected!.body?.message ?? '').toContain('confirmUntyped');
    });

    test('ingest with confirmUntyped is accepted: the untyped slot is deliberate', async () => {
        const created = await client.documents.ingestDocument({ confirmUntyped: true, body: {
            title: 'confirmed untyped document', text: 'n/a', indexMode: 'NONE',
            externalId: `untyped-ok-${uniqueTag()}`,
        } });
        documentIds.push(created.id!);
        expect(created.created).toBe(true);
        expect(created.schemaId ?? null).toBeNull();
    });

    test('ingest with a schemaId is accepted without the flag: the typed document is targeted', async () => {
        const typeName = `smoke_untyped_ext_${uniqueTag().replace(/-/g, '_')}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName,
            displayName: 'Untyped externalId smoke type',
            allowedSurfaces: ['document'],
            fields: [{ fieldId: 'category', fieldType: 'string', required: false }],
        } });
        schemaIds.push(schema.id!);
        const created = await client.documents.ingestDocument({ body: {
            title: 'typed document', text: 'n/a', indexMode: 'NONE',
            externalId: `typed-${uniqueTag()}`, schemaId: schema.id!,
        } });
        documentIds.push(created.id!);
        expect(created.created).toBe(true);
        expect(created.schemaId).toBe(schema.id);
    });

    test('the file-upload route refuses the same request with 400', async () => {
        let rejected: Rejection | null = null;
        let leaked: string | undefined;
        try {
            leaked = (await client.documents.uploadDocument({
                fileName: 'untyped-probe.txt', fileType: 'text/plain',
                externalId: `untyped-upload-${uniqueTag()}`,
            })).id;
        } catch (err) {
            rejected = err as Rejection;
        }
        if (leaked) documentIds.push(leaked);
        expect(rejected).not.toBeNull();
        expect(rejected!.statusCode).toBe(400);
        expect(rejected!.body?.message ?? '').toContain('confirmUntyped');
    });
});
