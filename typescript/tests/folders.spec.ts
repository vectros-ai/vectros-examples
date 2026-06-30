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
