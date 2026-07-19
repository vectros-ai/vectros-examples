/**
 * folders.spec.ts — Folder CRUD, hierarchy, ownership filters, protection guards.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

describe('folders', () => {
    let userId: string;
    let parentFolderId: string;
    let subFolderId: string;
    let userOwnedFolderId: string;
    const folderIds: string[] = [];

    beforeAll(async () => {
        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userId = user.id!;
    });

    afterAll(async () => {
        // Delete in reverse-create order — children first, then parents,
        // then user. tryCleanup swallows errors so a half-failed cleanup
        // doesn't mask a real test failure.
        for (const id of [...folderIds].reverse()) {
            await tryCleanup(`delete folder ${id}`, () => client.folders.deleteFolder({ id }));
        }
        await tryCleanup('delete user', () => client.identity.deleteUser({ id: userId }));
    });

    test('create folder under the default tenant root', async () => {
        const folder = await client.folders.createFolder({ body: {
            name: 'Smoke Root ' + uniqueTag(),
        } });
        folderIds.push(folder.id!);
        parentFolderId = folder.id!;
        expect(folder.id).toBeTruthy();
        // parentFolderId here is the TENANT ROOT folder's id (not null) — the
        // root acts as the natural parent of any unparented folder.
        expect(folder.parentFolderId).toBeTruthy();
        expect(folder.parentFolderId).not.toBe(folder.id);
        expect(folder.isProtected).toBe(false);
    });

    test('create subfolder under existing folder', async () => {
        const sub = await client.folders.createFolder({ body: {
            name: 'Smoke Sub ' + uniqueTag(),
            parentFolderId,
        } });
        folderIds.push(sub.id!);
        subFolderId = sub.id!;
        expect(sub.id).toBeTruthy();
        expect(sub.parentFolderId).toBe(parentFolderId);
    });

    test('get folder returns parentFolderId correctly', async () => {
        const loaded = await client.folders.getFolder({ id: subFolderId });
        expect(loaded.id).toBe(subFolderId);
        expect(loaded.parentFolderId).toBe(parentFolderId);
    });

    test('update folder name + description', async () => {
        const newName = 'Smoke Renamed ' + uniqueTag();
        const newDesc = 'Updated by smoke test';
        const updated = await client.folders.updateFolder({
            id: subFolderId,
            body: {
                name: newName,
                description: newDesc,
                parentFolderId,
            },
        });
        expect(updated.name).toBe(newName);
        expect(updated.description).toBe(newDesc);
        // Re-read to confirm the persisted state matches the response.
        const reload = await client.folders.getFolder({ id: subFolderId });
        expect(reload.name).toBe(newName);
        expect(reload.description).toBe(newDesc);
    });

    test('list folders with userId ownership filter', async () => {
        // Create a user-owned folder, then filter list by userId — must
        // include the user-owned one and exclude the unowned root.
        const userFolder = await client.folders.createFolder({ body: {
            name: 'Smoke User-Owned ' + uniqueTag(),
            userId,
        } });
        folderIds.push(userFolder.id!);
        userOwnedFolderId = userFolder.id!;

        const list = await client.folders.listFolders({ userId, limit: 100 });
        const ids = (list.data ?? []).map((f) => f.id);
        expect(ids).toContain(userOwnedFolderId);
        // The unparented Smoke Root + Smoke Sub were created WITHOUT userId,
        // so a userId-scoped list must NOT include them.
        expect(ids).not.toContain(parentFolderId);
    });

    test('cannot delete non-empty folder (400)', async () => {
        // Create a folder + a child folder in it. Try to delete the parent
        // while the child still exists — must reject with 400 (not 500).
        const parent = await client.folders.createFolder({ body: { name: 'Non-Empty Parent ' + uniqueTag() } });
        const child  = await client.folders.createFolder({ body: {
            name: 'Non-Empty Child ' + uniqueTag(),
            parentFolderId: parent.id!,
        } });
        // afterAll deletes folderIds in REVERSE order, so push the PARENT
        // first and the CHILD last → the child is deleted before the parent.
        // (Pushing child-first did the opposite: the reversed cleanup hit the
        // still-non-empty parent first and logged a spurious 400 every run.)
        folderIds.push(parent.id!);
        folderIds.push(child.id!);

        await expect(client.folders.deleteFolder({ id: parent.id! })).rejects.toMatchObject({
            statusCode: 400,
        });
    });

    test('listFolders shows tenant-root folder with isProtected=true', async () => {
        // Tenant-root folder is created lazily when you first interact
        // with folders. Should be reachable via listFolders with no filters,
        // and its isProtected flag must be true.
        const folders = (await client.folders.listFolders({ limit: 100 })).data ?? [];
        const root = folders.find((f) => f.isProtected === true);
        expect(root).toBeDefined();
        // Verifies the parent of one of our created folders is this root.
        expect(folders.some((f) => f.id === parentFolderId && f.parentFolderId === root!.id)).toBe(true);
    });
});

/**
 * records folder + userId listing precedence.
 *
 * `GET /v1/records?folderId=F&userId=U` walks the folder-scoped index. A record that
 * carries an `org:<id>` scope in ADDITION to its `folderId` + `userId` must still be
 * keyed such that the combined folder+userId filter returns it. This block pins that
 * contract — a record owning all three dimensions is returned by the combined filter
 * AND still carries its `org:<id>` scope — plus a NEGATIVE control (a same-folder
 * record owned by a DIFFERENT user must be excluded, so the userId filter is proven
 * load-bearing) and the pagination contract (a fully-filtered feed resumes via the
 * cursor).
 */
describe('records (folder + user listing precedence)', () => {
    let schemaId: string;
    let recordType: string;
    let userId: string;
    let otherUserId: string;
    let orgEntityId: string;
    let folderId: string;
    // The three user-owned records that MUST surface under the {folderId, userId} filter.
    const userRecordIds: string[] = [];
    // A same-folder record owned by otherUserId — the negative control that must be EXCLUDED.
    let foreignRecId: string;
    // Everything created, for teardown (staging is shared).
    const recordIds: string[] = [];

    beforeAll(async () => {
        recordType = `smoke_folder_owner_${uniqueTag()}`.replace(/-/g, '_');
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Smoke Folder-Precedence Record',
            indexMode: 'NONE',   // store-only: this is a listing test, no search needed
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'name', fieldType: 'string', required: true }],
        } });
        schemaId = schema.id!;
        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userId = user.id!;
        const otherUser = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        otherUserId = otherUser.id!;
        const org = await client.identity.createEntity({ namespace: 'org', body: { externalId: uniqueTag(), name: 'Folder Owner Listing Org' } });
        orgEntityId = org.id!;
        const folder = await client.folders.createFolder({ body: { name: 'Folder Owner Listing ' + uniqueTag() } });
        folderId = folder.id!;

        // Three records, each owning ALL THREE dimensions (folder + user + org scope) —
        // the exact shape the folder+userId listing filter must key correctly.
        for (let i = 0; i < 3; i++) {
            const rec = await client.records.createRecord({ body: {
                typeName: recordType,
                schemaId,
                payload: { name: `folder-owner-record-${i}-${uniqueTag()}` },
                folderId,
                userId,
                scopes: [`org:${orgEntityId}`],
            } });
            userRecordIds.push(rec.id!);
            recordIds.push(rec.id!);
        }

        // Negative control: SAME folder + org, DIFFERENT user. The {folderId, userId}
        // filter must exclude it — without this, folderId alone isolates the set and
        // the userId filter's correctness is never actually exercised.
        const foreign = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId,
            payload: { name: `folder-owner-foreign-${uniqueTag()}` },
            folderId,
            userId: otherUserId,
            scopes: [`org:${orgEntityId}`],
        } });
        foreignRecId = foreign.id!;
        recordIds.push(foreignRecId);
    });

    afterAll(async () => {
        for (const id of recordIds) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        await tryCleanup('delete folder', () => client.folders.deleteFolder({ id: folderId }));
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
        await tryCleanup('delete user', () => client.identity.deleteUser({ id: userId }));
        await tryCleanup('delete other user', () => client.identity.deleteUser({ id: otherUserId }));
        await tryCleanup('delete org', () =>
            client.identity.deleteEntity({ namespace: 'org', id: orgEntityId }));
    });

    test('folderId+userId filter returns the user\'s all-three-dimension records (carrying an org scope) and excludes a foreign owner', async () => {
        const list = await client.records.listRecords({ folderId, userId, limit: 100 });
        const rows = list.data ?? [];
        const listedIds = rows.map((r) => r.id);
        // Every all-three-dimension record owned by userId must surface under the combined filter.
        for (const id of userRecordIds) expect(listedIds).toContain(id);
        // NEGATIVE: the same-folder record owned by otherUserId must NOT — this is what
        // makes the userId dimension of the filter load-bearing (a regression that drops
        // the userId filter would over-return it and fail here).
        expect(listedIds).not.toContain(foreignRecId);

        // ...and the surfaced record still carries the `org:<id>` scope whose sort-key
        // precedence must hold — proving it wasn't dropped or mis-projected.
        const sample = rows.find((r) => r.id === userRecordIds[0]);
        expect(sample).toBeDefined();
        expect(sample!.scopes ?? []).toContain(`org:${orgEntityId}`);
        expect(sample!.userId).toBe(userId);
        expect(sample!.folderId).toBe(folderId);
    });

    test('a fully-filtered folder+userId feed resumes via the cursor (and never leaks the foreign owner)', async () => {
        // limit:1 forces pagination across the 3 user-owned records. Drain every page
        // via nextCursor and assert the filtered feed is complete and stable — a cursor
        // that dropped the folder+userId filter (or lost precedence) would leak the
        // foreign-owner row, return wrong rows, or never terminate.
        const seen = new Set<string>();
        let cursor: string | null | undefined;
        let pages = 0;
        do {
            const page = await client.records.listRecords(
                cursor ? { folderId, userId, limit: 1, startFrom: cursor } : { folderId, userId, limit: 1 });
            for (const r of page.data ?? []) {
                seen.add(r.id!);
                // Every page's rows stay correctly filtered — the foreign-owner row never appears.
                expect(r.userId).toBe(userId);
                expect(r.folderId).toBe(folderId);
                expect(r.id).not.toBe(foreignRecId);
            }
            cursor = page.nextCursor;
            pages++;
            if (pages > 20) throw new Error('pagination did not terminate — cursor loop');
        } while (cursor);

        // All three user-owned records were reached across the paged feed; the foreign one was not.
        for (const id of userRecordIds) expect(seen.has(id)).toBe(true);
        expect(seen.has(foreignRecId)).toBe(false);
        // Pagination actually happened (more than one page for 3 records at limit:1).
        expect(pages).toBeGreaterThan(1);
    });
});
