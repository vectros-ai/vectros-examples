/**
 * public-media-asset.spec.ts — the `asset` and `assets` field types: record
 * fields that hold one image or an array of images, each the id of a document
 * of a `fileProfile: "PUBLIC_MEDIA"` type.
 *
 * Covered now:
 *   - an asset field is accepted on any base schema: on a schema without a
 *     `publicView`, and on a projection view that does not list it (its images are
 *     then kept private); on a schema whose view lists it, `documentTypes`
 *     round-trips;
 *   - a record write naming an image that has not been processed, or a document
 *     id that does not exist, is refused (`ASSET_NOT_ATTACHABLE`), and an
 *     array field refuses the same image twice;
 *   - a public-media document carries `media` from its upload on: a state and the
 *     image's final public `url` (which serves only once the image is published).
 *
 *   - `GET /v1/documents/{id}/download` on an image still being processed is
 *     refused (`409` `NO_DOWNLOAD_FOR_MEDIA`).
 *
 * Gated: the image's desired publish state following its record (`HELD` for a
 * draft, `PUBLIC` once published, `HELD` again when unpublished), and a
 * private draft holding an image that its reader downloads from the private copy,
 * then the approval's listing write moving it to the published listing, need an
 * image that has finished processing. Set `PUBLIC_MEDIA_PROCESSING=1` on an
 * environment that processes public-media uploads to run those walks.
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
    let draftSchemaId = '';
    const draftType = `smoke_draft_${tag}`;
    let org = '';

    /**
     * An uploaded image's document id, or '' where public images are not enabled in this environment: the upload is then
     * refused with 503 PUBLIC_ACCESS_UNAVAILABLE, which this asserts, and the caller has nothing more to check.
     */
    async function upload(): Promise<string> {
        const init = await call('POST', '/v1/documents/upload', {
            fileName: 'p.png', fileType: 'image/png', schemaId: schemaIds[0], size: PNG.length,
        });
        if (init.status === 503) {
            expect(init.body.errorCode).toBe('PUBLIC_ACCESS_UNAVAILABLE');
            return '';
        }
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

        // a PRIVATE draft type (no publicView) declaring an asset field
        const draft = await call('POST', '/v1/schemas', {
            typeName: draftType, displayName: 'Smoke draft', allowedSurfaces: ['record'],
            fields: [{ fieldId: 'title', fieldType: 'string' }, { fieldId: 'cover', fieldType: 'asset', documentTypes: [photoType] }],
        });
        expect(draft.status).toBe(201);
        draftSchemaId = draft.body.id;
        schemaIds.push(draftSchemaId);

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

    test('an asset field is accepted on any base schema, with or without a view that serves it', async () => {
        // the private draft type was created in beforeAll; a projection view that does not list the field is accepted too
        expect(draftSchemaId).not.toBe('');
        const unlisted = await call('POST', '/v1/schemas', {
            typeName: `smoke_unlisted_${tag}`, displayName: 'Unlisted', allowedSurfaces: ['record'],
            fields: [{ fieldId: 'title', fieldType: 'string' }, { fieldId: 'cover', fieldType: 'asset', documentTypes: [photoType] }],
            publicView: { mode: 'projection', ownedBy: ['scope:org'], fields: ['title'] },
        });
        expect(unlisted.status).toBe(201);
        schemaIds.push(unlisted.body.id);
        // a sensitive asset field is still refused
        expectRefused(await call('POST', '/v1/schemas', {
            typeName: `smoke_sensitive_${tag}`, displayName: 'Sensitive', allowedSurfaces: ['record'],
            fields: [{ fieldId: 'cover', fieldType: 'asset', documentTypes: [photoType], sensitive: true }],
        }), 400, 'ASSET_FIELD_NOT_ALLOWED');
    });

    test('a record write naming an image that cannot be attached is refused', async () => {
        const pending = await upload();
        if (!pending) return;   // images are not processed here: upload() asserted the 503
        const doc = await call('GET', `/v1/documents/${pending}`);
        expect(doc.status).toBe(200);
        // the token is minted at upload init, so the final URL exists before the image is processed
        expect(doc.body.media).toBeDefined();
        expect(doc.body.media.url).toMatch(/^https:\/\/[a-z2-7]{26}\.[a-z0-9.-]+\/[a-z2-7]{26}$/);
        const notYetProcessed = doc.body.media.state === 'PROCESSING';
        if (notYetProcessed) {
            // an image still being processed has no download yet
            expectRefused(await call('GET', `/v1/documents/${pending}/download`), 409, 'NO_DOWNLOAD_FOR_MEDIA');
        }

        const base = { typeName: listingType, schemaId: listingSchemaId, scopes: [`org:${org}`] };
        expectRefused(await call('POST', '/v1/records', {
            ...base, payload: { title: 'Flat', state: 'draft', cover: 'no-such-document' },
        }), 400, 'ASSET_NOT_ATTACHABLE');
        // an image is attachable only once READY; where it processes fast it may already be READY by this write
        if (process.env.PUBLIC_MEDIA_PROCESSING !== '1' && notYetProcessed) {
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
        expect(id).not.toBe('');   // the walk runs only where images are processed
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

    walk('a private draft holds its image, its reader downloads it, and the approval moves it to the listing', async () => {
        const id = await upload();
        expect(id).not.toBe('');
        await pollUntil('the image to be processed', async () => {
            const d = await call('GET', `/v1/documents/${id}`);
            return d.status === 200 && d.body.media && d.body.media.state === 'READY' ? d : undefined;
        }, 180_000);

        const draft = await call('POST', '/v1/records', {
            typeName: draftType, schemaId: draftSchemaId, scopes: [`org:${org}`], payload: { title: 'Acme', cover: id },
        });
        expect(draft.status).toBe(201);
        recordIds.push(draft.body.id);
        await pollUntil('the held image', async () => {
            const d = await call('GET', `/v1/documents/${id}`);
            return d.status === 200 && d.body.media && d.body.media.desired === 'HELD' ? d : undefined;
        }, 30_000);

        // the reviewer sees the held image: a signed link to the private copy that serves the processed bytes
        const dl = await call('GET', `/v1/documents/${id}/download`);
        expect(dl.status).toBe(200);
        expect(dl.body.fileType).toMatch(/^image\/(png|jpeg)$/);   // re-encoded: PNG with transparency, otherwise JPEG
        const bytes = await fetch(dl.body.downloadUrl);
        expect(bytes.status).toBe(200);
        expect((await bytes.arrayBuffer()).byteLength).toBeGreaterThan(0);

        // the approval: a published listing that sets the draft's image moves it there
        const listing = await call('POST', '/v1/records', {
            typeName: listingType, schemaId: listingSchemaId, scopes: [`org:${org}`],
            payload: { title: 'Acme', state: 'live', cover: id },
        });
        expect(listing.status).toBe(201);
        recordIds.push(listing.body.id);
        await pollUntil('the moved image to be wanted public', async () => {
            const d = await call('GET', `/v1/documents/${id}`);
            return d.status === 200 && d.body.media && d.body.media.desired === 'PUBLIC' ? d : undefined;
        }, 30_000);

        // the draft keeps the id and still saves, without taking the image back
        const patched = await call('PATCH', `/v1/records/${draft.body.id}`, { payload: { title: 'Acme Ltd' } });
        expect(patched.status).toBe(200);
        expect(patched.body.payload.cover).toBe(id);
        const after = await call('GET', `/v1/documents/${id}`);
        expect(after.body.media.desired).toBe('PUBLIC');
        expect((await call('GET', `/v1/documents/${id}/download`)).status).toBe(200);
    });
});
