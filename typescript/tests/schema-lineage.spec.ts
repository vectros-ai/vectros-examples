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
            namespace,
        } as any));
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
                namespace,
                specificityRank: 999_000, // more specific than the built-in namespaces
                entityBacked: false,
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
});
