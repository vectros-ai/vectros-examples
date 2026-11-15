/**
 * public-media-asset.spec.ts — the `asset` and `assets` field types: record
 * fields that hold one image or an array of images, each the id of a document
 * of a `fileProfile: "PUBLIC_MEDIA"` type.
 *
 * Covered now:
 *   - an asset field is refused on a schema without a `publicView`
 *     (`ASSET_FIELD_NOT_ALLOWED`), and on a projection view that does not list it;
 *   - on a schema whose view lists it, the declaration is accepted and
 *     `documentTypes` round-trips;
 *   - a record write naming an image that has not been processed, or a document
 *     id that does not exist, is refused (`ASSET_NOT_ATTACHABLE`), and an
 *     array field refuses the same image twice;
 *   - a public-media document has no `media` object before it is processed.
 *
 * Gated: the image's desired publish state following its record (`HELD` for a
 * draft, `PUBLIC` once published, `HELD` again when unpublished) needs an image
 * that has finished processing. Set `PUBLIC_MEDIA_PROCESSING=1` on an
 * environment that processes public-media uploads to run that walk.
 *
 * PRECONDITION: public access must be turned on for the test tenant of the key's
 * account (the account owner turns it on). The key is `VECTROS_RUN_SMOKE_API_KEY`
 * when set, otherwise `VECTROS_API_KEY`. Without that switch a schema with a `publicView` is refused with
 * `PUBLIC_ACCESS_NOT_ENABLED`, and this spec FAILS saying so rather than
 * skipping: a skipped run is not evidence.
 *
 * Raw `fetch`, not the SDK: the assertions are about the wire contract, and the
 * SDK in use may predate these properties.
 */
import { pollUntil, presignedUploadHeaders, tryCleanup, uniqueTag } from '../src/helpers';

function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

function apiKey(): string {
    const k = process.env.VECTROS_RUN_SMOKE_API_KEY || process.env.VECTROS_API_KEY;
    if (!k) throw new Error('VECTROS_API_KEY (or VECTROS_RUN_SMOKE_API_KEY) required');
    return k;
}

interface Reply {
    status: number;
    body: Record<string, any>;
}

async function call(method: string, path: string, body?: unknown): Promise<Reply> {
    const resp = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await resp.text();
    let parsed: Record<string, any> = {};
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = { raw: text };
        }
    }
    return { status: resp.status, body: parsed };
}

function expectRefused(reply: Reply, status: number, errorCode: string): void {
    expect({ status: reply.status, errorCode: reply.body.errorCode }).toEqual({ status, errorCode });
    expect(typeof reply.body.message).toBe('string');
}

// A 1x1 PNG.
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

describe('the asset field type', () => {
    const tag = uniqueTag().replace(/-/g, '_');
    const photoType = `smoke_photo_${tag}`;
    const listingType = `smoke_listing_${tag}`;
    const schemaIds: string[] = [];
    const docIds: string[] = [];
    const recordIds: string[] = [];
    let listingSchemaId = '';
    let org = '';

    async function upload(): Promise<string> {
        const init = await call('POST', '/v1/documents/upload', {
            fileName: 'p.png', fileType: 'image/png', schemaId: schemaIds[0], size: PNG.length,
        });
        expect(init.status).toBe(201);
        docIds.push(init.body.id);
        const put = await fetch(init.body.uploadUrl, {
            method: 'PUT',
            body: PNG,
            headers: { 'Content-Type': 'image/png', ...presignedUploadHeaders(init.body) },
        });
        expect(put.status).toBe(200);
        return init.body.id;
    }

    beforeAll(async () => {
        const media = await call('POST', '/v1/schemas', {
            typeName: photoType, displayName: 'Smoke photo', allowedSurfaces: ['document'], fileProfile: 'PUBLIC_MEDIA',
        });
        expect(media.status).toBe(201);
        schemaIds.push(media.body.id);

        const listing = await call('POST', '/v1/schemas', {
            typeName: listingType,
            displayName: 'Smoke listing',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'title', fieldType: 'string' },
                { fieldId: 'state', fieldType: 'string', filterable: true },
                { fieldId: 'cover', fieldType: 'asset', documentTypes: [photoType] },
                { fieldId: 'gallery', fieldType: 'assets', documentTypes: [photoType] },
            ],
            lookupFields: [{ fieldName: 'state' }],
            publicView: {
                mode: 'projection',
                ownedBy: ['scope:org'],
                fields: ['title', 'cover', 'gallery'],
                publishWhen: { field: 'state', in: ['live'] },
            },
        });
        if (listing.status === 409 && listing.body.errorCode === 'PUBLIC_ACCESS_NOT_ENABLED') {
            throw new Error('PRECONDITION: public access is off for this account; turn it on to run this spec');
        }
        expect(listing.status).toBe(201);
        listingSchemaId = listing.body.id;
        schemaIds.push(listingSchemaId);
        const cover = listing.body.fields.find((f: any) => f.fieldId === 'cover');
        expect(cover.fieldType).toBe('asset');
        expect(cover.documentTypes).toEqual([photoType]);

        const entity = await call('POST', '/v1/entities/org', { externalId: `asset-org-${tag}`, name: 'Asset Org' });
        expect(entity.status).toBe(201);
        org = entity.body.id;
    });

    afterAll(async () => {
        for (const id of recordIds) {
            await tryCleanup(`delete record ${id}`, () => call('DELETE', `/v1/records/${id}`));
        }
        for (const id of docIds) {
            await tryCleanup(`delete doc ${id}`, () => call('DELETE', `/v1/documents/${id}`));
        }
        for (const id of [...schemaIds].reverse()) {
            await tryCleanup(`delete schema ${id}`, () => call('DELETE', `/v1/schemas/${id}`));
        }
        if (org) await tryCleanup(`delete org ${org}`, () => call('DELETE', `/v1/entities/org/${org}`));
    });

    test('an asset field is refused where its images could never be public', async () => {
        expectRefused(await call('POST', '/v1/schemas', {
            typeName: `smoke_private_${tag}`, displayName: 'Private', allowedSurfaces: ['record'],
            fields: [{ fieldId: 'cover', fieldType: 'asset', documentTypes: [photoType] }],
        }), 400, 'ASSET_FIELD_NOT_ALLOWED');
        expectRefused(await call('POST', '/v1/schemas', {
            typeName: `smoke_unlisted_${tag}`, displayName: 'Unlisted', allowedSurfaces: ['record'],
            fields: [{ fieldId: 'title', fieldType: 'string' }, { fieldId: 'cover', fieldType: 'asset', documentTypes: [photoType] }],
            publicView: { mode: 'projection', ownedBy: ['scope:org'], fields: ['title'] },
        }), 400, 'ASSET_FIELD_NOT_ALLOWED');
    });

    test('a record write naming an image that cannot be attached is refused', async () => {
        const pending = await upload();
        const doc = await call('GET', `/v1/documents/${pending}`);
        expect(doc.status).toBe(200);
        expect(doc.body.media).toBeUndefined();

        const base = { typeName: listingType, schemaId: listingSchemaId, scopes: [`org:${org}`] };
        expectRefused(await call('POST', '/v1/records', {
            ...base, payload: { title: 'Flat', state: 'draft', cover: 'no-such-document' },
        }), 400, 'ASSET_NOT_ATTACHABLE');
        if (process.env.PUBLIC_MEDIA_PROCESSING !== '1') {
            expectRefused(await call('POST', '/v1/records', {
                ...base, payload: { title: 'Flat', state: 'draft', cover: pending },
            }), 400, 'ASSET_NOT_ATTACHABLE');
        }
        expectRefused(await call('POST', '/v1/records', {
            ...base, payload: { title: 'Flat', state: 'draft', gallery: [pending, pending] },
        }), 400, 'ASSET_NOT_ATTACHABLE');
    });

    const walk = process.env.PUBLIC_MEDIA_PROCESSING === '1' ? test : test.skip;
    walk('an image\'s desired state follows its record\'s publish state', async () => {
        const id = await upload();
        await pollUntil('the image to be processed', async () => {
            const d = await call('GET', `/v1/documents/${id}`);
            return d.status === 200 && d.body.media && d.body.media.state === 'READY' ? d : undefined;
        }, 180_000);

        const created = await call('POST', '/v1/records', {
            typeName: listingType, schemaId: listingSchemaId, scopes: [`org:${org}`],
            payload: { title: 'Flat', state: 'draft', cover: id },
        });
        expect(created.status).toBe(201);
        recordIds.push(created.body.id);
        // a document read is eventually consistent: poll for each desired state rather than read it once
        const desiredBecomes = (want: string) => pollUntil(`media.desired to be ${want}`, async () => {
            const d = await call('GET', `/v1/documents/${id}`);
            return d.status === 200 && d.body.media && d.body.media.desired === want ? d : undefined;
        }, 30_000);
        await desiredBecomes('HELD');

        expect((await call('PATCH', `/v1/records/${created.body.id}`, { payload: { state: 'live' } })).status).toBe(200);
        await desiredBecomes('PUBLIC');

        expect((await call('PATCH', `/v1/records/${created.body.id}`, { payload: { state: 'closed' } })).status).toBe(200);
        await desiredBecomes('HELD');
    });
});
