/**
 * schema-lineage.spec.ts — `basedOn` schema customization and `specificityRank`
 * on scope namespaces.
 *
 * The first schema created under a `typeName` has no `basedOn` and becomes
 * that name's shared BASE. Every other schema of that name must declare
 * `basedOn` pointing at the base — a PRIVATE variant (owned by one user) or a
 * SHARED/org variant (owned by a scope value). `GET /v1/schemas?recordType=`,
 * `POST /v1/records`/`POST /v1/documents` by `typeName` alone, and document
 * lookup-by-field all resolve to the caller's own variant when one exists,
 * otherwise the shared base.
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

interface MintedToken { token: string; expiresAt: number; }
interface ErrorBody { message?: string; [k: string]: unknown }

/** Runs a call expected to reject and returns its {statusCode, body}. Fails
 *  loudly if the call resolves — a silent success is the worst outcome for a
 *  negative-path assertion. */
async function captureError(p: Promise<unknown>): Promise<{ statusCode?: number; body: ErrorBody }> {
    try {
        await p;
    } catch (e) {
        const err = e as { statusCode?: number; body?: unknown };
        if (err.statusCode === undefined) throw e;
        return { statusCode: err.statusCode, body: (err.body ?? {}) as ErrorBody };
    }
    throw new Error('expected the call to reject, but it resolved successfully');
}

describe('schema lineage (basedOn / specificityRank)', () => {
    // ----- basedOn: base + variant relatedness -----

    test('first schema under a typeName has no basedOn — becomes the lineage base', async () => {
        const recordType = `smoke_lineage_${uniqueTag()}`;
        const base = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Lineage Base',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }],
        } });
        try {
            expect(base.basedOn).toBeFalsy();
        } finally {
            await tryCleanup('delete base schema', () => client.schemas.deleteSchema({ id: base.id! }));
        }
    });

    test('a second schema under an existing typeName without basedOn is rejected with a 400', async () => {
        // RED-prove the negative: a happy-path-only test wouldn't catch a guard
        // that silently stopped enforcing this.
        const recordType = `smoke_lineage_noby_${uniqueTag()}`;
        const base = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Lineage Base (no-basedOn negative)',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }],
        } });
        // A distinct owner, so this lands as a genuinely NEW schema rather than
        // an idempotent re-create of the identical ownerless base.
        const owner = await client.identity.createUser({ body: { externalId: 'lineage-noby-' + uniqueTag() } });
        try {
            const { statusCode } = await captureError(client.schemas.createSchema({ body: {
                typeName: recordType,
                displayName: 'Second schema, same name, no basedOn',
                indexMode: 'TEXT',
                allowedSurfaces: ['record'],
                fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }],
                userId: owner.id,
            } }));
            expect(statusCode).toBe(400);
        } finally {
            await tryCleanup('delete base schema', () => client.schemas.deleteSchema({ id: base.id! }));
            await tryCleanup('delete owner user', () => client.identity.deleteUser({ id: owner.id! }));
        }
    });

    test('a schema with basedOn pointing at the base, owned by a distinct user, succeeds as a private variant', async () => {
        const recordType = `smoke_lineage_priv_${uniqueTag()}`;
        const base = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Lineage Base (private variant)',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }],
        } });
        const owner = await client.identity.createUser({ body: { externalId: 'lineage-owner-' + uniqueTag() } });
        let variant;
        try {
            variant = await client.schemas.createSchema({ body: {
                typeName: recordType,
                displayName: 'Lineage Private Variant',
                indexMode: 'TEXT',
                allowedSurfaces: ['record'],
                fields: [
                    { fieldId: 'note', fieldType: 'string', searchable: true },
                    { fieldId: 'privateExtra', fieldType: 'string', searchable: false },
                ],
                basedOn: base.id,
                userId: owner.id,
            } });
            expect(variant.basedOn).toBe(base.id);
            expect(variant.id).not.toBe(base.id);
        } finally {
            if (variant) await tryCleanup('delete variant schema', () => client.schemas.deleteSchema({ id: variant!.id! }));
            await tryCleanup('delete base schema', () => client.schemas.deleteSchema({ id: base.id! }));
            await tryCleanup('delete owner user', () => client.identity.deleteUser({ id: owner.id! }));
        }
    });

    // ----- recordType resolution: shadows by ownership, not fail-loud ambiguity -----

    test('GET /v1/schemas?recordType= resolves to the base with no owner selector, to the variant with ?userId=', async () => {
        const recordType = `smoke_lineage_resolve_${uniqueTag()}`;
        const base = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Resolution Base',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }],
        } });
        const owner = await client.identity.createUser({ body: { externalId: 'resolve-owner-' + uniqueTag() } });
        let variant;
        try {
            variant = await client.schemas.createSchema({ body: {
                typeName: recordType,
                displayName: 'Resolution Variant',
                indexMode: 'TEXT',
                allowedSurfaces: ['record'],
                fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }],
                basedOn: base.id,
                userId: owner.id,
            } });

            // No selector — the shared base wins. Before this release two
            // schemas sharing a typeName with no declared relationship would
            // have 400'd here as an ambiguous type.
            const noSelector = await client.schemas.listSchemas({ recordType });
            expect((noSelector.data ?? []).map((s) => s.id)).toEqual([base.id]);

            // ?userId= the variant's owner — resolves to the variant, not the base.
            const withSelector = await client.schemas.listSchemas({ recordType, userId: owner.id });
            expect((withSelector.data ?? []).map((s) => s.id)).toEqual([variant.id]);
        } finally {
            if (variant) await tryCleanup('delete variant schema', () => client.schemas.deleteSchema({ id: variant!.id! }));
            await tryCleanup('delete base schema', () => client.schemas.deleteSchema({ id: base.id! }));
            await tryCleanup('delete owner user', () => client.identity.deleteUser({ id: owner.id! }));
        }
    });

    test("POST /v1/records by typeName alone resolves to the scoped caller's own variant", async () => {
        const recordType = `smoke_lineage_recres_${uniqueTag()}`;
        const base = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Record-Resolution Base',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }],
        } });
        const owner = await client.identity.createUser({ body: { externalId: 'recres-owner-' + uniqueTag() } });
        let variant;
        let recordId: string | undefined;
        try {
            variant = await client.schemas.createSchema({ body: {
                typeName: recordType,
                displayName: 'Record-Resolution Variant',
                indexMode: 'TEXT',
                allowedSurfaces: ['record'],
                fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }],
                basedOn: base.id,
                userId: owner.id,
            } });

            const minted = (await client.auth.mintToken({
                userId: owner.id,
                scope: {
                    allowedActions: ['records:crud'],
                    identity: { userId: owner.id! },
                },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);

            // typeName alone, no schemaId — must resolve via the token's own
            // identity to the OWNER's variant, not the shared base.
            const record = await scoped.records.createRecord({ body: {
                typeName: recordType,
                payload: { note: 'resolved via own basedOn variant' },
            } });
            recordId = record.id!;
            expect(record.schemaId).toBe(variant.id);
        } finally {
            if (recordId) await tryCleanup('delete record', () => client.records.deleteRecord({ id: recordId! }));
            if (variant) await tryCleanup('delete variant schema', () => client.schemas.deleteSchema({ id: variant!.id! }));
            await tryCleanup('delete base schema', () => client.schemas.deleteSchema({ id: base.id! }));
            await tryCleanup('delete owner user', () => client.identity.deleteUser({ id: owner.id! }));
        }
    });

    // ----- specificityRank on namespaces -----

    test('POST /v1/namespaces without specificityRank is rejected with a 400', async () => {
        const namespace = 'smk_rank_' + uniqueTag().replace(/-/g, '').slice(0, 12);
        // specificityRank is a required field in the SDK's own type — the cast
        // below is what lets this negative test express the omitted-field case
        // at all, not a workaround for a missing type.
        const { statusCode } = await captureError(client.identity.registerNamespace({
            body: { namespace } as any,
        }));
        expect(statusCode).toBe(400);
    });

    test('specificityRank breaks the tie when a caller holds two scope dimensions during basedOn resolution', async () => {
        // A caller can hold values in at most two scope dimensions. Register a
        // custom namespace ranked ABOVE the built-in `org` namespace so a
        // caller holding both an org-scope variant and a namespace-scope
        // variant resolves to the more specific one.
        const recordType = `smoke_lineage_rank_${uniqueTag()}`;
        const namespace = 'smk_team_' + uniqueTag().replace(/-/g, '').slice(0, 12);
        const teamValue = 'team-' + uniqueTag();

        const base = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Rank Tie-break Base',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }],
        } });
        const org = await client.identity.createEntity({ namespace: 'org', body: {
            externalId: 'rank-org-' + uniqueTag(),
            name: 'Rank Tie-break Org',
        } });
        let orgVariant;
        let teamVariant;
        try {
            await client.identity.registerNamespace({
                body: {
                    namespace,
                    specificityRank: 999_000, // more specific than the built-in namespaces
                    entityBacked: false,
                },
            });

            orgVariant = await client.schemas.createSchema({ body: {
                typeName: recordType,
                displayName: 'Org-scoped Variant',
                indexMode: 'TEXT',
                allowedSurfaces: ['record'],
                fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }],
                basedOn: base.id,
                scopes: [`org:${org.id}`],
            } });
            teamVariant = await client.schemas.createSchema({ body: {
                typeName: recordType,
                displayName: 'Namespace-scoped Variant',
                indexMode: 'TEXT',
                allowedSurfaces: ['record'],
                fields: [{ fieldId: 'note', fieldType: 'string', searchable: true }],
                basedOn: base.id,
                scopes: [`${namespace}:${teamValue}`],
            } });

            const minted = (await client.auth.mintToken({
                scope: {
                    allowedActions: ['records:crud'],
                    identity: { 'scope:org': org.id!, [`scope:${namespace}`]: teamValue },
                    // A namespace dimension always needs explicit clause authority to authorize
                    // placement into it — identity alone is no longer sufficient (only the principal
                    // itself gets that free pass). Grant it here rather than relying on identity to
                    // imply it.
                    dataScope: { 'scope:org': [org.id!], [`scope:${namespace}`]: [teamValue] },
                },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);

            let recordId: string | undefined;
            try {
                const record = await scoped.records.createRecord({ body: {
                    typeName: recordType,
                    payload: { note: 'resolved via the higher-specificity scope variant' },
                } });
                recordId = record.id!;
                // The caller holds BOTH scope:org and scope:<namespace>. The
                // higher specificityRank (the custom namespace) must win.
                expect(record.schemaId).toBe(teamVariant.id);
                expect(record.schemaId).not.toBe(orgVariant.id);
            } finally {
                if (recordId) await tryCleanup('delete record', () => client.records.deleteRecord({ id: recordId! }));
            }
        } finally {
            if (teamVariant) await tryCleanup('delete namespace-scoped variant', () => client.schemas.deleteSchema({ id: teamVariant!.id! }));
            if (orgVariant) await tryCleanup('delete org-scoped variant', () => client.schemas.deleteSchema({ id: orgVariant!.id! }));
            await tryCleanup('delete base schema', () => client.schemas.deleteSchema({ id: base.id! }));
            await tryCleanup('delete org entity', () => client.identity.deleteEntity({ namespace: 'org', id: org.id! }));
            await tryCleanup('delete namespace', () => client.identity.deleteNamespace({ namespace }));
        }
    });

    // ----- userId/scope selectors on document lookup -----

    test("POST /v1/documents/lookup resolves the caller's own variant with ?userId=, the base otherwise", async () => {
        // The variant declares a lookup field the base does NOT — resolving to
        // the wrong schema means the field isn't recognized as a lookup field
        // at all, so the selector has an observable effect, not just a label.
        const docType = `smoke_lineage_doclkp_${uniqueTag()}`;
        const base = await client.schemas.createSchema({ body: {
            typeName: docType,
            displayName: 'Doc Lookup Base',
            indexMode: 'TEXT',
            allowedSurfaces: ['document'],
            fields: [{ fieldId: 'title', fieldType: 'string', searchable: true }],
        } });
        const owner = await client.identity.createUser({ body: { externalId: 'doclkp-owner-' + uniqueTag() } });
        let variant;
        let docId: string | undefined;
        const poNumber = 'PO-' + uniqueTag();
        try {
            variant = await client.schemas.createSchema({ body: {
                typeName: docType,
                displayName: 'Doc Lookup Variant',
                indexMode: 'TEXT',
                allowedSurfaces: ['document'],
                fields: [
                    { fieldId: 'title', fieldType: 'string', searchable: true },
                    { fieldId: 'poNumber', fieldType: 'string', searchable: false },
                ],
                lookupFields: [{ fieldName: 'poNumber', unique: true }],
                basedOn: base.id,
                userId: owner.id,
            } });

            const doc = await client.documents.ingestDocument({ body: {
                title: 'Doc Lookup Variant Doc',
                text: 'lineage doc-lookup smoke content',
                indexMode: 'NONE',
                schemaId: variant.id,
                userId: owner.id,
                payload: { poNumber },
            } });
            docId = doc.id!;

            // ?userId= the variant's owner — resolves to the variant, which
            // declares poNumber as a lookup field, so the lookup finds it.
            const found = await client.documents.lookupDocuments({
                type: docType, field: 'poNumber', value: poNumber, userId: owner.id,
            });
            expect((found.data ?? []).map((d) => d.id)).toContain(docId);

            // No selector — resolves to the shared base, which has no
            // poNumber lookup field declared at all, so nothing matches.
            const withoutSelector = await client.documents.lookupDocuments({
                type: docType, field: 'poNumber', value: poNumber,
            });
            expect((withoutSelector.data ?? []).map((d) => d.id)).not.toContain(docId);
        } finally {
            if (docId) await tryCleanup('delete document', () => client.documents.deleteDocument({ id: docId! }));
            if (variant) await tryCleanup('delete variant schema', () => client.schemas.deleteSchema({ id: variant!.id! }));
            await tryCleanup('delete base schema', () => client.schemas.deleteSchema({ id: base.id! }));
            await tryCleanup('delete owner user', () => client.identity.deleteUser({ id: owner.id! }));
        }
    });

    // 0.42.0 — documents/lookup gained sortFrom/sortTo, the equivalent of the
    // 0.38.0 records-side feature (composite-lookup.spec.ts). Documents keep
    // single-field lookups (composite/multi-field stays records-only), so this
    // only needs to prove the bound narrows an exact `value` match by the
    // lookup field's sort key (createdAt, the default) — same shape as the
    // records-side test, on the documents surface for the first time.
    test('POST /v1/documents/lookup: sortFrom/sortTo narrow an exact value match by createdAt', async () => {
        const docType = `smoke_lineage_docsort_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: docType,
            displayName: 'Doc Lookup Sort Window',
            indexMode: 'NONE',
            allowedSurfaces: ['document'],
            fields: [{ fieldId: 'batch', fieldType: 'string' }],
            lookupFields: [{ fieldName: 'batch' }],
        } });
        const batch = 'batch-' + uniqueTag();
        let docOld: string | undefined;
        let docNew: string | undefined;
        try {
            const older = await client.documents.ingestDocument({ body: {
                title: 'doc-sort-older', text: 'older', indexMode: 'NONE',
                schemaId: schema.id, payload: { batch },
            } });
            docOld = older.id!;
            await new Promise((r) => setTimeout(r, 1200)); // ensure a distinct createdAt tick
            const newer = await client.documents.ingestDocument({ body: {
                title: 'doc-sort-newer', text: 'newer', indexMode: 'NONE',
                schemaId: schema.id, payload: { batch },
            } });
            docNew = newer.id!;

            const sortFromMs = String(Date.parse((await client.documents.getDocument({ id: docNew })).createdAt!));
            const bounded = await client.documents.lookupDocuments({
                type: docType, field: 'batch', value: batch, sortFrom: sortFromMs,
            });
            const boundedIds = (bounded.data ?? []).map((d) => d.id);
            expect(boundedIds).toContain(docNew);
            expect(boundedIds).not.toContain(docOld); // created before the sortFrom bound

            const unbounded = await client.documents.lookupDocuments({ type: docType, field: 'batch', value: batch });
            const unboundedIds = (unbounded.data ?? []).map((d) => d.id);
            expect(unboundedIds).toContain(docOld);
            expect(unboundedIds).toContain(docNew);
        } finally {
            if (docOld) await tryCleanup('delete older document', () => client.documents.deleteDocument({ id: docOld! }));
            if (docNew) await tryCleanup('delete newer document', () => client.documents.deleteDocument({ id: docNew! }));
            await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schema.id! }));
        }
    });

    // -------------------------------------------------------------------
    // 0.40.0 — allowedSurfaces narrowed from "no identity surface" to
    // "no `user` surface": an `entity`-surfaced schema is now writable by an
    // ordinary scoped credential (homed in that credential's own context,
    // not RESERVED_DEFAULT), while `user` still requires root.
    // -------------------------------------------------------------------
    describe('allowedSurfaces: entity vs. user (0.40.0)', () => {
        test('a scoped credential CAN create an entity-surfaced schema, but NOT a user-surfaced one', async () => {
            const ctxId = ('assrf' + uniqueTag()).slice(0, 31);
            await client.auth.createAppContext({ body: { contextId: ctxId, name: 'allowedSurfaces spec' } });
            const minted = (await client.auth.mintToken({
                contextId: ctxId, scope: { allowedActions: ['schemas:c', 'schemas:r'] },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);
            let entitySchemaId: string | undefined;
            try {
                const entityType = `smoke_ent_surf_${uniqueTag()}`;
                const created = await scoped.schemas.createSchema({ body: {
                    typeName: entityType, displayName: 'Entity-surfaced (scoped)',
                    indexMode: 'NONE', allowedSurfaces: ['entity'],
                    fields: [{ fieldId: 'name', fieldType: 'string', searchable: false }],
                } });
                entitySchemaId = created.id!;
                expect(created.allowedSurfaces).toContain('entity');

                const userType = `smoke_user_surf_${uniqueTag()}`;
                await expect(scoped.schemas.createSchema({ body: {
                    typeName: userType, displayName: 'User-surfaced (scoped, should fail)',
                    indexMode: 'NONE', allowedSurfaces: ['user'],
                    fields: [{ fieldId: 'name', fieldType: 'string', searchable: false }],
                } })).rejects.toMatchObject({ statusCode: 403 });
            } finally {
                if (entitySchemaId) await tryCleanup('entity schema', () => client.schemas.deleteSchema({ id: entitySchemaId! }));
                await tryCleanup('context', () => client.auth.deleteAppContext({ contextId: ctxId, confirm: ctxId }));
            }
        });

        test('GET /v1/schemas?surface=entity merges the caller\'s own context with the tenant-wide home', async () => {
            const ctxId = ('asmrg' + uniqueTag()).slice(0, 31);
            await client.auth.createAppContext({ body: { contextId: ctxId, name: 'allowedSurfaces merge spec' } });
            const ownType = `smoke_ent_own_${uniqueTag()}`;
            const tenantType = `smoke_ent_tw_${uniqueTag()}`;
            // Root key writes land in RESERVED_DEFAULT (the tenant-wide home) unless a
            // context-pinned credential writes instead — a scoped credential confined
            // to ctxId is what puts a schema in the CALLER's own context.
            const minted = (await client.auth.mintToken({
                contextId: ctxId, scope: { allowedActions: ['schemas:c', 'schemas:r'] },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);
            const ownSchema = await scoped.schemas.createSchema({ body: {
                typeName: ownType, displayName: 'Own-context entity schema',
                indexMode: 'NONE', allowedSurfaces: ['entity'],
                fields: [{ fieldId: 'name', fieldType: 'string', searchable: false }],
            } });
            const tenantSchema = await client.schemas.createSchema({ body: {
                typeName: tenantType, displayName: 'Tenant-wide entity schema',
                indexMode: 'NONE', allowedSurfaces: ['entity'],
                fields: [{ fieldId: 'name', fieldType: 'string', searchable: false }],
            } });
            try {
                // recordType + surface:'entity' resolves the ONE schema for that type name
                // from own-context-plus-tenant-wide (per the SDK's own field doc) — avoids
                // the plain list's pagination entirely, so a large pre-existing RESERVED_DEFAULT
                // population (this is a long-lived shared tenant) can't push either row past
                // a page boundary.
                const ownFound = await scoped.schemas.listSchemas({ surface: 'entity', recordType: ownType });
                expect((ownFound.data ?? []).map((s) => s.typeName)).toContain(ownType);
                const tenantFound = await scoped.schemas.listSchemas({ surface: 'entity', recordType: tenantType });
                expect((tenantFound.data ?? []).map((s) => s.typeName)).toContain(tenantType);
            } finally {
                await tryCleanup('own schema', () => client.schemas.deleteSchema({ id: ownSchema.id! }));
                await tryCleanup('tenant schema', () => client.schemas.deleteSchema({ id: tenantSchema.id! }));
                await tryCleanup('context', () => client.auth.deleteAppContext({ contextId: ctxId, confirm: ctxId }));
            }
        });
    });
});
