/**
 * documents-hostile-file.spec.ts — a hostile upload fails alone.
 *
 * Three files are uploaded together: a DOCX zip bomb (one part that expands
 * far more than 500 times when unpacked), the sample PDF, and the sample
 * Markdown note. The bomb must end with the extraction outcome `UNREADABLE`
 * and no text, while the two ordinary files are extracted (`OK`) and indexed
 * as usual. What a client sees for each is the pattern worth copying: branch
 * on `extraction.outcome`, never on the human-readable `message`.
 *
 * What this does not show: the bomb is refused as soon as its expansion ratio
 * is seen, so it never makes extraction crash or run out of time. It checks
 * the outcomes a client sees, not how a crash would be contained.
 *
 * The bomb is built in memory below, so no hostile file is checked in.
 */
import * as fs from 'fs';
import * as zlib from 'zlib';
import { client } from '../src/client';
import { uniqueTag, pollUntil, tryCleanup, presignedUploadHeaders, withSize } from '../src/helpers';
import { SAMPLE_PDF_PATH } from '../src/fixtures';
import * as path from 'path';

const SAMPLE_MD_PATH = path.join(__dirname, '..', 'fixtures', 'sample.md');
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Statuses after which a document's processing is finished, one way or another. */
const SETTLED = new Set(['INDEXED', 'SKIPPED', 'STORED', 'FAILED']);

// --- a minimal ZIP writer (stored names, DEFLATE bodies), enough for a DOCX ---

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<{ name: string; body: Buffer }>): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const { name, body } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const packed = zlib.deflateRawSync(body, { level: 9 });
        const crc = crc32(body);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);           // version needed
        local.writeUInt16LE(8, 8);            // DEFLATE
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(body.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, packed);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);         // version made by
        central.writeUInt16LE(20, 6);         // version needed
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(body.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        offset += local.length + nameBuf.length + packed.length;
    }
    const dir = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dir, end]);
}

/**
 * A valid single-paragraph DOCX whose one text run is 40 MiB of the letter
 * `a`: about 40 KiB on the wire, roughly a thousandfold expansion.
 */
function docxZipBomb(): Buffer {
    const contentTypes =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>';
    const rels =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>';
    const document = Buffer.concat([
        Buffer.from(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>',
            'utf8'),
        Buffer.alloc(40 * 1024 * 1024, 'a'),
        Buffer.from('</w:t></w:r></w:p></w:body></w:document>', 'utf8'),
    ]);
    return zip([
        { name: '[Content_Types].xml', body: Buffer.from(contentTypes, 'utf8') },
        { name: '_rels/.rels', body: Buffer.from(rels, 'utf8') },
        { name: 'word/document.xml', body: document },
    ]);
}

describe('documents (hostile file)', () => {
    let userId: string;
    const docIds: string[] = [];

    beforeAll(async () => {
        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userId = user.id!;
    });

    afterAll(async () => {
        for (const id of docIds) {
            await tryCleanup(`delete doc ${id}`, () => client.documents.deleteDocument({ id }));
        }
        await tryCleanup('delete user', () => client.identity.deleteUser({ id: userId }));
    });

    async function upload(fileName: string, fileType: string, body: Buffer): Promise<string> {
        const started = await client.documents.uploadDocument(withSize({ fileName, fileType, indexMode: 'HYBRID', userId }, body));
        docIds.push(started.id!);   // recorded before the PUT, so a failed PUT is still cleaned up
        const put = await fetch(started.uploadUrl!, {
            method: 'PUT',
            body,
            headers: { 'Content-Type': fileType, ...presignedUploadHeaders(started) },
        });
        expect(put.status).toBe(200);
        return started.id!;
    }

    async function settled(id: string): Promise<any> {
        return pollUntil(`document ${id} settled`, async () => {
            const doc: any = await client.documents.getDocument({ id });
            return SETTLED.has(doc?.indexStatus) ? doc : undefined;
        }, 170_000);
    }

    test('a zip bomb ends UNREADABLE with no text, and the files uploaded with it are extracted and indexed', async () => {
        const bomb = docxZipBomb();
        // The fixture must really be bomb-shaped, or a pass proves nothing.
        expect(bomb.length).toBeLessThan(200 * 1024);

        // allSettled, not all: a failing upload must not end the test while the others are still
        // in flight, or their documents would be created after cleanup has run.
        const uploads = await Promise.allSettled([
            upload('hostile-zip-bomb.docx', DOCX_TYPE, bomb),
            upload('smoke-clinical-note.pdf', 'application/pdf', fs.readFileSync(SAMPLE_PDF_PATH)),
            upload('smoke-note.md', 'text/markdown', fs.readFileSync(SAMPLE_MD_PATH)),
        ]);
        const failed = uploads.find((u): u is PromiseRejectedResult => u.status === 'rejected');
        if (failed) throw failed.reason;
        const [bombId, pdfId, mdId] = uploads.map((u) => (u as PromiseFulfilledResult<string>).value);
        const [bombDoc, pdfDoc, mdDoc] = await Promise.all([settled(bombId), settled(pdfId), settled(mdId)]);

        // The hostile file: refused, stored, and without text.
        expect(bombDoc.extraction?.outcome).toBe('UNREADABLE');
        expect(bombDoc.extraction?.truncated).toBe(false);
        expect(bombDoc.indexStatus).toBe('SKIPPED');
        await expect(client.documents.getDocumentText({ id: bombId })).rejects.toMatchObject({ statusCode: 404 });

        // The two ordinary files: extracted in full and indexed.
        for (const doc of [pdfDoc, mdDoc]) {
            expect(doc.extraction?.outcome).toBe('OK');
            expect(doc.indexStatus).toBe('INDEXED');
        }
    // Its own budget: three uploads, then up to 170 s of polling (extended by any rate-limit wait),
    // which the suite-wide default would cut short with a bare timeout instead of the poll's message.
    }, 300_000);
});
