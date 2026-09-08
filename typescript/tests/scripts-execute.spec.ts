/**
 * scripts-execute.spec.ts — synchronous script execution: push a stored script, run it as one
 * atomic transaction, and read back what it created.
 *
 * This is also the reference example for the "create a folder and file documents into it"
 * composition: one call instead of several independently-failing round trips.
 *
 * The `/v1/scripts/execute` calls go through a raw fetch rather than the generated client for one
 * reason only: this spec asserts on RESPONSE STATUS, including the refusals (403, 422), and a
 * generated client raises those as exceptions rather than returning them. Everything else — pushing a
 * script, minting a token — uses the client, as `scripts-triggers.spec.ts` does throughout. The fetch
 * is the suite's rate-limit-aware one, so a shared-tenant 429 waits visibly instead of failing an
 * assertion that expected a 200.
 */
import { client } from '../src/client';
import { rateLimitAwareFetch } from '../src/rateLimitFetch';
import { uniqueTag, tryCleanup } from '../src/helpers';

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

async function rawJson(
    method: string,
    path: string,
    body: unknown,
    opts: { token?: string; idempotencyKey?: string } = {},
): Promise<{ status: number; json: any; headers: Headers }> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token ?? apiKey()}`,
    };
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const resp = await rateLimitAwareFetch(`${baseUrl()}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await resp.text();
    return { status: resp.status, json: text ? JSON.parse(text) : null, headers: resp.headers };
}

async function pushScript(name: string, source: string, declaredInputContract?: string): Promise<string> {
    const { status, json } = await rawJson('POST', '/v1/scripts', { name, source, declaredInputContract });
    if (status !== 201) throw new Error(`script push failed: ${status} ${JSON.stringify(json)}`);
    return json.id as string;
}

async function executeScript(
    body: unknown,
    opts: { token?: string; idempotencyKey?: string } = {},
): Promise<{ status: number; json: any; headers: Headers }> {
    return rawJson('POST', '/v1/scripts/execute', body, opts);
}

// The composition every test here runs: a folder plus N text documents filed into it, returned as
// ids. Sized in rows, not entities: a folder is 3 rows and a plain text document 1, against a
// 100-row transaction — so up to 97 plain documents per call.
const CREATE_FOLDER_WITH_DOCUMENTS = `
var folder = vectros.folders.create({ name: input.params.name });
var documentIds = [];
for (var i = 0; i < input.params.documents.length; i++) {
  var d = input.params.documents[i];
  documentIds.push(vectros.documents.create({
    title: d.title, text: d.text, indexMode: 'TEXT', folderId: folder.id
  }).id);
}
({ folderId: folder.id, documentIds: documentIds });
`;

describe('scripts: synchronous execution', () => {
    const scriptName = 'smoke-create-folder-' + uniqueTag();
    const scriptIds: string[] = [];
    const folderIds: string[] = [];
    const documentIds: string[] = [];

    beforeAll(async () => {
        scriptIds.push(await pushScript(scriptName, CREATE_FOLDER_WITH_DOCUMENTS,
            '{ name: string, documents: { title: string, text: string }[] }'));
    });

    afterAll(async () => {
        for (const id of documentIds) {
            await tryCleanup(`delete document ${id}`, () => client.documents.deleteDocument({ id }));
        }
        for (const id of folderIds) {
            await tryCleanup(`delete folder ${id}`, () => client.folders.deleteFolder({ id }));
        }
        for (const id of scriptIds) {
            await tryCleanup(`delete script ${id}`, () => rawJson('DELETE', `/v1/scripts/${id}`, undefined));
        }
    });

    test('creates a folder and its documents in one call, and returns their ids after commit', async () => {
        const { status, json } = await executeScript({
            scriptRef: { name: scriptName, version: 'latest' },
            input: { name: 'Smoke Case ' + uniqueTag(), documents: [
                { title: 'intake', text: 'Intake notes.' },
                { title: 'consent', text: 'Consent form.' },
            ] },
        });
        expect(status).toBe(200);
        expect(json.execution.id).toBeTruthy();
        expect(typeof json.execution.durationMs).toBe('number');
        expect(json.execution.durationMs).toBeGreaterThan(0);
        const { folderId, documentIds: ids } = json.result;
        folderIds.push(folderId);
        documentIds.push(...ids);
        expect(ids).toHaveLength(2);

        // Everything the response names is committed state.
        const folder = await client.folders.getFolder({ id: folderId });
        expect(folder.id).toBe(folderId);
        for (const id of ids) {
            const doc = await client.documents.getDocument({ id });
            expect(doc.folderId).toBe(folderId);
        }
    });

    test('a script that throws after writing commits nothing and returns its own message', async () => {
        const name = 'smoke-half-' + uniqueTag();
        scriptIds.push(await pushScript(name,
            "vectros.folders.create({ name: 'never-' + input.params.tag }); throw new Error('deliberate');"));
        const tag = uniqueTag();
        const { status, json } = await executeScript({ scriptRef: { name, version: 'latest' }, input: { tag } });
        expect(status).toBe(400);
        expect(json.errorCode).toBe('SCRIPT_ERROR');
        expect(json.message).toContain('deliberate');
        // Scoped to a page large enough that a concurrent run on the shared tenant cannot push the
        // row we are asserting the ABSENCE of off the end — a negative assertion that silently goes
        // vacuous is worse than no assertion.
        const page = await client.folders.listFolders({ limit: 100 });
        expect((page.data ?? []).some((f: any) => f.name === 'never-' + tag)).toBe(false);
    });

    test('execute needs the scripts:x permission; a data-only token is refused', async () => {
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['folders:cr', 'documents:cr'] },
        })) as { token: string };
        const { status } = await executeScript(
            { scriptRef: { name: scriptName, version: 'latest' }, input: { name: 'x', documents: [] } },
            { token: minted.token },
        );
        expect(status).toBe(403);
    });

    test('scripts:x alone runs the script, but its writes still need the data permissions', async () => {
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['scripts:x:' + scriptName] },
        })) as { token: string };
        const { status, json } = await executeScript(
            { scriptRef: { name: scriptName, version: 'latest' }, input: { name: 'x', documents: [] } },
            { token: minted.token },
        );
        expect(status).toBe(403);
        expect(json.errorCode).toBe('AUTHORIZATION_DENIED');
        expect(json.message).toContain('folders.create');
    });

    test('a scripts:x qualified to a DIFFERENT script name cannot run this one', async () => {
        // The cell that makes the name qualifier mean something. Every other test here proves
        // `scripts:x:<name>` mints and reaches the handler; none would notice if the handler ignored
        // the name and admitted any script — the silently-inert-qualifier defect that the grammar
        // rejection at mint time exists to prevent, arriving at the other end of the pipe.
        const wrong = (await client.auth.mintToken({
            scope: { allowedActions: ['scripts:x:some-other-script', 'folders:cr', 'documents:cr'] },
        })) as { token: string };
        const refused = await executeScript(
            { scriptRef: { name: scriptName, version: 'latest' }, input: { name: 'x', documents: [] } },
            { token: wrong.token },
        );
        expect(refused.status).toBe(403);

        // The pair. Without it the 403 could be any refusal on this route — a malformed scope, a
        // missing data permission, an unrelated gate — rather than the name qualifier doing its job.
        const right = (await client.auth.mintToken({
            scope: { allowedActions: [`scripts:x:${scriptName}`, 'folders:cr', 'documents:cr'] },
        })) as { token: string };
        const allowed = await executeScript(
            {
                scriptRef: { name: scriptName, version: 'latest' },
                input: { name: 'Qualified ' + uniqueTag(), documents: [] },
            },
            { token: right.token },
        );
        expect(allowed.status).toBe(200);
        folderIds.push(allowed.json.result.folderId);
    });

    test('a retry under the same Idempotency-Key replays the first response without running again', async () => {
        const key = 'smoke-' + uniqueTag();
        const body = {
            scriptRef: { name: scriptName, version: 'latest' },
            input: { name: 'Idempotent ' + uniqueTag(), documents: [{ title: 'only', text: 'once' }] },
        };
        const first = await executeScript(body, { idempotencyKey: key });
        expect(first.status).toBe(200);
        folderIds.push(first.json.result.folderId);
        documentIds.push(...first.json.result.documentIds);

        const second = await executeScript(body, { idempotencyKey: key });
        expect(second.status).toBe(200);
        expect(second.json.result.folderId).toBe(first.json.result.folderId);
        expect(second.headers.get('idempotent-replayed')).toBe('true');

        const reused = await executeScript(
            { ...body, input: { ...body.input, name: 'different' } },
            { idempotencyKey: key },
        );
        expect(reused.status).toBe(422);
        expect(reused.json.errorCode).toBe('IDEMPOTENCY_KEY_REUSED');
    });
});

// ---------------------------------------------------------------------------
// Read-your-own-writes inside one execution
//
// Every read and every guard used to be answered from the state that existed before the execution
// started, so a script could contradict itself: delete a row and still list it, write the same row
// twice and silently lose the first write, create two rows that collide only at commit.
//
// These cells all run inside ONE execution and return their own observations, because that is the
// only place the property is visible: from outside, after the commit, a script that read stale state
// and one that read its own writes can produce the same final rows.
// ---------------------------------------------------------------------------

describe('scripts: an execution sees its own writes', () => {
    const scriptIds: string[] = [];
    const folderIds: string[] = [];
    const documentIds: string[] = [];
    const recordIds: string[] = [];
    const schemaIds: string[] = [];
    let recordType: string;

    beforeAll(async () => {
        recordType = `smoke_ryow_${uniqueTag().replace(/-/g, '_')}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Smoke Read-Your-Own-Writes',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [
                { fieldId: 'a', fieldType: 'string' },
                { fieldId: 'b', fieldType: 'string' },
                { fieldId: 'code', fieldType: 'string' },
            ],
            lookupFields: [{ fieldName: 'code', unique: true }],
        } });
        schemaIds.push(schema.id!);
    });

    afterAll(async () => {
        for (const id of documentIds) {
            await tryCleanup(`delete document ${id}`, () => client.documents.deleteDocument({ id }));
        }
        for (const id of recordIds) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        for (const id of folderIds) {
            await tryCleanup(`delete folder ${id}`, () => client.folders.deleteFolder({ id }));
        }
        for (const id of schemaIds) {
            await tryCleanup(`delete schema ${id}`, () => client.schemas.deleteSchema({ id }));
        }
        for (const id of scriptIds) {
            await tryCleanup(`delete script ${id}`, () => rawJson('DELETE', `/v1/scripts/${id}`, undefined));
        }
    });

    /** Push a one-off script and run it, returning the raw response. */
    async function runOnce(source: string, input: unknown): Promise<{ status: number; json: any }> {
        const name = 'smoke-ryow-' + uniqueTag();
        scriptIds.push(await pushScript(name, source));
        return executeScript({ scriptRef: { name, version: 'latest' }, input });
    }

    test('a list subtracts what this execution deleted, and shows what it updated', async () => {
        // The rows must PRE-EXIST the execution: a list deliberately does not show a row the same
        // execution created, so a script that made its own fixtures could not see either effect.
        const folder = await client.folders.createFolder({ body: { name: 'ryow-' + uniqueTag() } });
        folderIds.push(folder.id!);
        const keep = await client.documents.ingestDocument({ body: {
            title: 'keep', text: 'original', indexMode: 'TEXT', folderId: folder.id,
        } });
        const drop = await client.documents.ingestDocument({ body: {
            title: 'drop', text: 'doomed', indexMode: 'TEXT', folderId: folder.id,
        } });
        documentIds.push(keep.id!);

        const source = [
            "function ids(rows) { var o = []; for (var i = 0; i < rows.length; i++) o.push(rows[i].id); return o; }",
            "function titles(rows) { var o = []; for (var i = 0; i < rows.length; i++) o.push(rows[i].title); return o; }",
            "var before = vectros.documents.query({ folderId: input.params.folderId }).data.length;",
            "vectros.documents.delete(input.params.dropId);",
            "vectros.documents.update(input.params.keepId, { title: 'renamed' });",
            "var after = vectros.documents.query({ folderId: input.params.folderId }).data;",
            "var created = vectros.documents.create({ title: 'made-in-flight', text: 'x', indexMode: 'TEXT', folderId: input.params.folderId });",
            "var afterCreate = vectros.documents.query({ folderId: input.params.folderId }).data;",
            "({ before: before, afterIds: ids(after), afterTitles: titles(after), createdId: created.id, afterCreateCount: afterCreate.length });",
        ].join('\n');

        const { status, json } = await runOnce(source, {
            folderId: folder.id, dropId: drop.id, keepId: keep.id,
        });

        expect(status).toBe(200);
        documentIds.push(json.result.createdId);

        expect(json.result.before).toBe(2);
        // The deleted row is gone from the LIST, not merely from get(id) — that half already worked,
        // and the two disagreeing is what the defect looked like.
        expect(json.result.afterIds).not.toContain(drop.id);
        expect(json.result.afterIds).toContain(keep.id);
        // …and the updated row carries this execution's content, not the pre-execution content.
        expect(json.result.afterTitles).toContain('renamed');
        // The deliberate limit, asserted so a future change to it is a decision rather than a
        // surprise: a list does not show a row this execution CREATED — you hold its id already.
        expect(json.result.afterCreateCount).toBe(1);
    });

    test('a second write to the same row builds on the first, not on the pre-execution state', async () => {
        // Two partial updates each used to merge onto the state before the execution, so the second
        // silently discarded the first's fields — a data loss with no error anywhere.
        const seeded = await client.records.createRecord({ body: {
            typeName: recordType,
            payload: { a: 'original-a', b: 'original-b', code: 'ryow-' + uniqueTag() },
        } });
        recordIds.push(seeded.id!);

        const source = [
            "vectros.records.update(input.params.id, { payload: { a: 'first-write' } });",
            "vectros.records.update(input.params.id, { payload: { b: 'second-write' } });",
            "vectros.records.get(input.params.id).payload;",
        ].join('\n');

        const { status, json } = await runOnce(source, { id: seeded.id });

        expect(status).toBe(200);
        expect(json.result.a).toBe('first-write');
        expect(json.result.b).toBe('second-write');

        // And the commit agrees with what the script saw — the read was not a local illusion.
        const committed: any = await client.records.getRecord({ id: seeded.id! });
        expect(committed.payload.a).toBe('first-write');
        expect(committed.payload.b).toBe('second-write');
    });

    test('a uniqueness guard sees a row staged earlier in the same execution', async () => {
        // Both writes used to be admitted and collide at commit. Now the second is refused while the
        // script is still running, so the script can catch it and do something about it.
        const code = 'clash-' + uniqueTag();
        const source = [
            "vectros.records.create({ typeName: input.params.type, payload: { a: '1', code: input.params.code } });",
            "var refused = false;",
            "try {",
            "  vectros.records.create({ typeName: input.params.type, payload: { a: '2', code: input.params.code } });",
            "} catch (e) { refused = true; }",
            "({ refused: refused });",
        ].join('\n');

        const { status, json } = await runOnce(source, { type: recordType, code });

        expect(status).toBe(200);
        expect(json.result.refused).toBe(true);

        // Exactly one row carries the code — the guard refused the second write rather than letting
        // two through to collide (or, worse, letting both land).
        const page: any = await client.records.listRecords({ type: recordType, includePayload: 'true' });
        const withCode = (page.data ?? []).filter((r: any) => r.payload?.code === code);
        for (const r of withCode) recordIds.push(r.id);
        expect(withCode.length).toBe(1);
    });

    test('an idempotent create finds a row this execution has already written to', async () => {
        // The echo probe must see the execution's OWN staged write — not the committed row underneath
        // it, and not nothing at all. Hiding staged rows from every read would also hide them from
        // their own idempotency probe, turning an ordinary update-then-idempotent-create sequence
        // into a 400.
        const externalId = 'echo-' + uniqueTag();
        const seeded = await client.records.createRecord({ body: {
            typeName: recordType,
            externalId,
            payload: { a: 'committed', code: 'echo-' + uniqueTag() },
        } });
        recordIds.push(seeded.id!);

        const source = [
            "vectros.records.update(input.params.id, { payload: { a: 'staged-update' } });",
            "var echoed = vectros.records.create({ typeName: input.params.type, externalId: input.params.externalId, payload: { a: 'ignored' } });",
            "({ echoedId: echoed.id, echoedA: echoed.payload ? echoed.payload.a : null });",
        ].join('\n');

        const { status, json } = await runOnce(source, {
            type: recordType, externalId, id: seeded.id,
        });

        expect(status).toBe(200);
        expect(json.result.echoedId).toBe(seeded.id);
        // The discriminating assertion. `echoedId` alone would pass against a probe that read the
        // COMMITTED row and ignored the staged write entirely; the content is what separates them.
        expect(json.result.echoedA).toBe('staged-update');
    });

    test('…but claiming an identifier only a SIBLING of this execution staged is still refused', async () => {
        // The guard the cell above must not relax. Creating the same `externalId` twice in one
        // execution is a mistake, not an idempotent repeat: there is no prior row to be idempotent
        // WITH, so echoing would silently collapse two intended rows into one.
        const externalId = 'sibling-' + uniqueTag();
        const source = [
            "vectros.records.create({ typeName: input.params.type, externalId: input.params.externalId, payload: { a: 'first' } });",
            "vectros.records.create({ typeName: input.params.type, externalId: input.params.externalId, payload: { a: 'second' } });",
            "({ reached: 'the end' });",
        ].join('\n');

        const { status, json } = await runOnce(source, { type: recordType, externalId });

        expect(status).toBe(400);
        expect(json.errorCode).toBe('SCRIPT_ERROR');
        expect(json.message).toContain(externalId);

        // Nothing was committed — the refusal aborted the transaction rather than leaving the first
        // create behind.
        const page: any = await client.records.listRecords({ type: recordType });
        expect((page.data ?? []).some((r: any) => r.externalId === externalId)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The budgets. Each is a published number a partner sizes their integration
// against, and each fails in a direction they have to be able to handle.
// ---------------------------------------------------------------------------

describe('scripts: the execution budgets', () => {
    const scriptIds: string[] = [];
    const folderIds: string[] = [];

    afterAll(async () => {
        for (const id of folderIds) {
            await tryCleanup(`delete folder ${id}`, () => client.folders.deleteFolder({ id }));
        }
        for (const id of scriptIds) {
            await tryCleanup(`delete script ${id}`, () => rawJson('DELETE', `/v1/scripts/${id}`, undefined));
        }
    });

    /** Push a one-off script and return its referenceable name. */
    async function push(source: string): Promise<string> {
        const name = 'smoke-budget-' + uniqueTag();
        scriptIds.push(await pushScript(name, source));
        return name;
    }

    // A script whose result is a single string of `input.params.bytes` characters. Built by doubling
    // rather than by a loop of concatenations, so it stays well inside the statement budget and the
    // cell under test is the RESULT cap rather than an accidental resource limit.
    const SIZED_RESULT = [
        "var s = 'x';",
        "while (s.length < input.params.bytes) { s = s + s; }",
        "({ blob: s.substring(0, input.params.bytes) });",
    ].join('\n');

    test('a result over 256 KB is refused, and a smaller one from the same script is not', async () => {
        const name = await push(SIZED_RESULT);

        const tooBig = await executeScript({
            scriptRef: { name, version: 'latest' },
            input: { bytes: 300_000 },
        });
        expect(tooBig.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(tooBig.json)).toContain('RESULT_TOO_LARGE');

        // The control, and what makes the refusal a CAP rather than the script being broken: the same
        // script, the same code path, a smaller result, accepted.
        const fine = await executeScript({
            scriptRef: { name, version: 'latest' },
            input: { bytes: 1_000 },
        });
        expect(fine.status).toBe(200);
        expect(fine.json.result.blob).toHaveLength(1_000);
    });

    test('with an Idempotency-Key the cap drops to 16 KB — the SAME result, two verdicts', async () => {
        // The sharpest available demonstration that the keyed cap is real: one script, one result
        // size chosen to sit between the two caps, run twice. Unkeyed it succeeds; keyed it is
        // refused. Nothing about the script or its output differs — only the header.
        const name = await push(SIZED_RESULT);
        const between = { scriptRef: { name, version: 'latest' }, input: { bytes: 100_000 } };

        const unkeyed = await executeScript(between);
        expect(unkeyed.status).toBe(200);
        expect(unkeyed.json.result.blob).toHaveLength(100_000);

        const keyed = await executeScript(between, { idempotencyKey: 'smoke-cap-' + uniqueTag() });
        expect(keyed.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(keyed.json)).toContain('RESULT_TOO_LARGE');
    });

    test('a transaction over 100 storage rows is refused, and nothing is committed', async () => {
        // A folder is 3 rows and a plain text document 1, so 120 documents under one folder is
        // comfortably past the cap without depending on the exact row accounting.
        const name = await push([
            "var folder = vectros.folders.create({ name: 'budget-' + input.params.tag });",
            "for (var i = 0; i < input.params.count; i++) {",
            "  vectros.documents.create({ title: 't' + i, text: 'x', indexMode: 'TEXT', folderId: folder.id });",
            "}",
            "({ folderId: folder.id });",
        ].join('\n'));

        const tag = uniqueTag();
        const over = await executeScript({
            scriptRef: { name, version: 'latest' },
            input: { tag, count: 120 },
        });
        expect(over.status).toBeGreaterThanOrEqual(400);
        // The error names the two numbers a partner needs in order to re-plan the call.
        const body = JSON.stringify(over.json);
        expect(body).toContain('total');
        expect(body).toContain('limit');

        // All-or-nothing holds at the cap too: the folder the script created before it ran out of
        // budget is not left behind.
        const page: any = await client.folders.listFolders({ limit: 100 });
        expect((page.data ?? []).some((f: any) => f.name === 'budget-' + tag)).toBe(false);

        // The control: the same script, under the cap, commits.
        const under = await executeScript({
            scriptRef: { name, version: 'latest' },
            input: { tag: uniqueTag(), count: 5 },
        });
        expect(under.status).toBe(200);
        folderIds.push(under.json.result.folderId);
    });
});
