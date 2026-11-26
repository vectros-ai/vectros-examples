/**
 * public-media-profile.spec.ts — a document type declared with
 * `fileProfile: "PUBLIC_MEDIA"` holds images meant for public serving, so
 * the API refuses everything that would change what such a
 * document is: a bad declaration, a text body, a document-level `indexMode`,
 * a retype, a replaced file once the upload has arrived, and the text read.
 * Each refusal is checked for its status AND its stable `errorCode`.
 *
 * Raw `fetch`, not the SDK: the SDK in use may predate the new schema
 * properties, and the assertions are about the wire contract.
 *
 * A public-media upload must declare `size`; the declared type and
 * exact length are then signed into the upload URL, so the storage service itself
 * refuses a PUT with another Content-Type or another length (403), before
 * anything is stored.
 *
 * Not covered here: the refusal of an upload by a principal who signed itself
 * up (`SELF_SIGNUP_UPLOAD_NOT_ALLOWED`), which needs a token-exchange issuer
 * with a self-signup policy on the target environment.
 */
import { pollUntil, presignedUploadHeaders, tryCleanup, uniqueTag } from '../src/helpers';

function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

function apiKey(): string {
    const k = process.env.VECTROS_API_KEY;
    if (!k) throw new Error('VECTROS_API_KEY required');
    return k;
}

// A 1x1 PNG.
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

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

describe('public-media document types', () => {
    const tag = uniqueTag().replace(/-/g, '_');
    const schemaIds: string[] = [];
    const docIds: string[] = [];
    let mediaSchemaId = '';
    let plainSchemaId = '';

    beforeAll(async () => {
        const media = await call('POST', '/v1/schemas', {
            typeName: `smoke_photo_${tag}`,
            displayName: 'Smoke photo',
            allowedSurfaces: ['document'],
            fileProfile: 'PUBLIC_MEDIA',
            mediaKinds: ['image'],
            maxBytes: 1048576,
            contentTypes: ['image/png'],
        });
        expect(media.status).toBe(201);
        mediaSchemaId = media.body.id;
        schemaIds.push(mediaSchemaId);
        expect(media.body.fileProfile).toBe('PUBLIC_MEDIA');
        expect(media.body.indexMode).toBe('NONE');
        expect(media.body.contentTypes).toEqual(['image/png']);

        const plain = await call('POST', '/v1/schemas', {
            typeName: `smoke_letter_${tag}`,
            displayName: 'Smoke letter',
            allowedSurfaces: ['document'],
            indexMode: 'NONE',
        });
        expect(plain.status).toBe(201);
        plainSchemaId = plain.body.id;
        schemaIds.push(plainSchemaId);
    });

    // Where public images are not enabled in this environment, every upload of a public-media type is refused with 503
    // PUBLIC_ACCESS_UNAVAILABLE. One probe decides, and asserts that refusal, so the upload cases below either run in full or the
    // refusal itself is what this spec checked: never a silent pass.
    let processing: boolean | undefined;
    async function imagesProcessed(): Promise<boolean> {
        if (processing === undefined) {
            const probe = await call('POST', '/v1/documents/upload', {
                fileName: 'probe.png', fileType: 'image/png', schemaId: mediaSchemaId, size: PNG.length,
            });
            if (probe.status === 503) {
                expect(probe.body.errorCode).toBe('PUBLIC_ACCESS_UNAVAILABLE');
                processing = false;
            } else {
                expect(probe.status).toBe(201);
                docIds.push(probe.body.id);
                processing = true;
            }
        }
        return processing;
    }

    afterAll(async () => {
        for (const id of docIds) {
            await tryCleanup(`delete doc ${id}`, () => call('DELETE', `/v1/documents/${id}`));
        }
        for (const id of schemaIds) {
            await tryCleanup(`delete schema ${id}`, () => call('DELETE', `/v1/schemas/${id}`));
        }
    });

    test('a bad declaration is refused with its code', async () => {
        expectRefused(await call('POST', '/v1/schemas', {
            typeName: `smoke_clip_${tag}`, displayName: 'Clip', allowedSurfaces: ['document'],
            fileProfile: 'PUBLIC_MEDIA', mediaKinds: ['video'],
        }), 400, 'MEDIA_KIND_NOT_AVAILABLE');
        expectRefused(await call('POST', '/v1/schemas', {
            typeName: `smoke_pic_${tag}`, displayName: 'Pic', allowedSurfaces: ['record'],
            fileProfile: 'PUBLIC_MEDIA',
        }), 400, 'PUBLIC_MEDIA_SCHEMA_INVALID');
        expectRefused(await call('POST', '/v1/schemas', {
            typeName: `smoke_svg_${tag}`, displayName: 'Svg', allowedSurfaces: ['document'],
            fileProfile: 'PUBLIC_MEDIA', contentTypes: ['image/svg+xml'],
        }), 400, 'PUBLIC_MEDIA_SCHEMA_INVALID');
    });

    test('a text create and a document-level indexMode are refused', async () => {
        expectRefused(await call('POST', '/v1/documents', {
            title: 'not an image', text: 'hello', schemaId: mediaSchemaId,
        }), 400, 'PUBLIC_MEDIA_TEXT_NOT_ALLOWED');
        if (!(await imagesProcessed())) return;   // the probe asserted the 503
        expectRefused(await call('POST', '/v1/documents/upload', {
            // `size` is sent so the refusal under test is the indexMode, not a missing size
            fileName: 'p.png', fileType: 'image/png', schemaId: mediaSchemaId, indexMode: 'NONE', size: PNG.length,
        }), 409, 'PUBLIC_MEDIA_TYPE_CHANGE_NOT_ALLOWED');
    });

    test('once the upload arrives the file cannot be replaced, the type cannot change, and there is no text', async () => {
        if (!(await imagesProcessed())) return;   // the probe asserted the 503
        const externalId = `smoke-photo-${tag}`;
        const init = await call('POST', '/v1/documents/upload', {
            fileName: 'p.png', fileType: 'image/png', schemaId: mediaSchemaId, externalId, size: PNG.length,
        });
        expect(init.status).toBe(201);
        const id: string = init.body.id;
        docIds.push(id);

        const put = await fetch(init.body.uploadUrl, {
            method: 'PUT',
            body: PNG,
            headers: { 'Content-Type': 'image/png', ...presignedUploadHeaders(init.body) },
        });
        expect(put.status).toBe(200);
        await pollUntil('the upload to arrive', async () => {
            const d = await call('GET', `/v1/documents/${id}`);
            return d.status === 200 && d.body.indexStatus !== 'PENDING_UPLOAD' ? d : undefined;
        }, 120_000);

        expectRefused(await call('POST', '/v1/documents/upload', {
            fileName: 'q.png', fileType: 'image/png', schemaId: mediaSchemaId, externalId, size: PNG.length,
        }), 409, 'PUBLIC_MEDIA_IMMUTABLE');
        expectRefused(await call('PATCH', `/v1/documents/${id}`, { schemaId: plainSchemaId }), 409,
            'PUBLIC_MEDIA_TYPE_CHANGE_NOT_ALLOWED');
        expectRefused(await call('GET', `/v1/documents/${id}/text`), 409, 'NO_TEXT_FOR_MEDIA');

        // A title edit is still an ordinary edit.
        const edit = await call('PATCH', `/v1/documents/${id}`, { title: 'Front door' });
        expect(edit.status).toBe(200);
    });

    // Bound uploads
    test('a public-media upload without size, of a type it does not accept, or over its limit is refused', async () => {
        if (!(await imagesProcessed())) return;   // the probe asserted the 503
        expectRefused(await call('POST', '/v1/documents/upload', {
            fileName: 'p.png', fileType: 'image/png', schemaId: mediaSchemaId,
        }), 400, 'SIZE_REQUIRED');
        const heic = await call('POST', '/v1/documents/upload', {
            fileName: 'IMG_0001.HEIC', schemaId: mediaSchemaId, size: 10,
        });
        expectRefused(heic, 400, 'MEDIA_FORMAT_NOT_ACCEPTED');
        expect(heic.body.acceptedTypes).toEqual(['image/png']);
        // the type does not accept JPEG, so no conversion is offered
        expect(heic.body.convertTo).toBeUndefined();
        expectRefused(await call('POST', '/v1/documents/upload', {
            fileName: 'p.png', fileType: 'image/png', schemaId: mediaSchemaId, size: 1048577,
        }), 400, 'MEDIA_TOO_LARGE');
    });

    test('a bound upload: the storage service refuses another Content-Type or another length, and takes the declared one', async () => {
        if (!(await imagesProcessed())) return;   // the probe asserted the 503
        const init = await call('POST', '/v1/documents/upload', {
            fileName: 'b.png', fileType: 'image/png', schemaId: mediaSchemaId, size: PNG.length,
        });
        expect(init.status).toBe(201);
        docIds.push(init.body.id);
        expect(init.body.requiredHeaders).toEqual({ 'Content-Type': 'image/png', 'If-None-Match': '*' });
        const precondition = { 'If-None-Match': '*' };

        const spoofedType = await fetch(init.body.uploadUrl, {
            method: 'PUT', body: PNG, headers: { ...precondition, 'Content-Type': 'text/html' },
        });
        expect(spoofedType.status).toBe(403);
        const longer = await fetch(init.body.uploadUrl, {
            method: 'PUT', body: Buffer.concat([PNG, Buffer.from([0])]), headers: init.body.requiredHeaders,
        });
        expect(longer.status).toBe(403);
        const shorter = await fetch(init.body.uploadUrl, {
            method: 'PUT', body: PNG.subarray(0, PNG.length - 1), headers: init.body.requiredHeaders,
        });
        expect(shorter.status).toBe(403);

        const exact = await fetch(init.body.uploadUrl, { method: 'PUT', body: PNG, headers: init.body.requiredHeaders });
        expect(exact.status).toBe(200);
    });

    test('a plain upload without size is refused (size is required for every upload); with size it is bound', async () => {
        // API 0.51.0 or later.
        expectRefused(await call('POST', '/v1/documents/upload', {
            fileName: 'u.txt', fileType: 'text/plain', schemaId: plainSchemaId,
        }), 400, 'SIZE_REQUIRED');
        const bound = await call('POST', '/v1/documents/upload', {
            fileName: 'b.txt', fileType: 'text/plain; charset=utf-8', schemaId: plainSchemaId, size: 5,
        });
        expect(bound.status).toBe(201);
        docIds.push(bound.body.id);
        // the type the URL was signed for is the normalized one, not the string sent
        expect(bound.body.requiredHeaders).toEqual({ 'Content-Type': 'text/plain', 'If-None-Match': '*' });
        const put = await fetch(bound.body.uploadUrl, { method: 'PUT', body: 'hello', headers: bound.body.requiredHeaders });
        expect(put.status).toBe(200);
    });

    test('the profile cannot be added to a type that already has documents', async () => {
        const init = await call('POST', '/v1/documents/upload', {
            // the upload is only started, never PUT, so any positive size will do
            fileName: 'l.pdf', fileType: 'application/pdf', schemaId: plainSchemaId, size: 1,
        });
        expect(init.status).toBe(201);
        docIds.push(init.body.id);
        expectRefused(await call('PUT', `/v1/schemas/${plainSchemaId}`, { fileProfile: 'PUBLIC_MEDIA' }), 409,
            'PUBLIC_MEDIA_PROFILE_LOCKED');
    });
});
