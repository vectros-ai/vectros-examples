package ai.vectros.smoke;

import ai.vectros.resources.identity.requests.CreateEntityRequest;
import ai.vectros.resources.identity.requests.DeleteEntityRequest;
import ai.vectros.resources.identity.requests.DeleteNamespaceRequest;
import ai.vectros.resources.identity.requests.GetEntityRequest;
import ai.vectros.resources.identity.requests.GetNamespaceRequest;
import ai.vectros.resources.identity.requests.RegisterNamespaceRequest;
import ai.vectros.resources.records.requests.ListRecordsRequest;
import ai.vectros.types.AppContextRequest;
import ai.vectros.types.EntityRequest;
import ai.vectros.types.EntityResponse;
import ai.vectros.types.FieldDef;
import ai.vectros.types.FieldDefFieldType;
import ai.vectros.types.LookupDef;
import ai.vectros.types.NamespaceRequest;
import ai.vectros.types.NamespaceResponse;
import ai.vectros.types.RecordRequest;
import ai.vectros.types.RecordResponse;
import ai.vectros.types.SchemaRequest;
import ai.vectros.types.SchemaRequestAllowedSurfacesItem;
import ai.vectros.types.SchemaRequestIndexMode;
import ai.vectros.types.SchemaResponse;
import ai.vectros.types.ScopeRequest;
import ai.vectros.types.MintTokenResponse;
import ai.vectros.resources.auth.requests.TokenRequest;
import ai.vectros.types.UserRequest;
import ai.vectros.types.UserResponse;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import static org.junit.jupiter.api.Assertions.*;

/**
 * 0.40.0: namespace placement and namespace membership. The Java-language
 * analogue of {@code namespaces.spec.ts} (see that file for the full
 * mechanism). Ports one representative test per axis (tenant-wide placement
 * CRUD; the membership-follows-the-record + immediate-revocation proof)
 * rather than every edge case TS already covers exhaustively.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class NamespacesSmokeTest {

    private String recordType;
    private String schemaId;

    private static String nsName(String prefix) {
        String raw = (prefix + Smoke.uniqueTag()).toLowerCase();
        String cleaned = raw.replaceAll("[^a-z0-9_-]", "");
        return cleaned.substring(0, Math.min(32, cleaned.length()));
    }

    private static int uniqueRank() {
        return 10_000 + ThreadLocalRandom.current().nextInt(900_000);
    }

    @BeforeAll
    void setUp() {
        recordType = "smoke_member_java_" + Smoke.uniqueTag();
        SchemaResponse schema = Smoke.live().schemas().createSchema(SchemaRequest.builder()
            .typeName(recordType).displayName("Membership Grant Schema (java)")
            .indexMode(SchemaRequestIndexMode.NONE)
            .allowedSurfaces(List.of(SchemaRequestAllowedSurfacesItem.RECORD))
            .fields(List.of(FieldDef.builder().fieldId("granteeUserId").fieldType(FieldDefFieldType.STRING)
                .required(true).searchable(false).build()))
            // REQUIRED: membershipTargetField must be a declared lookup field, or
            // resolution refuses to resolve anyone for this namespace at all.
            .lookupFields(List.of(LookupDef.builder().fieldName("granteeUserId").build()))
            .build());
        schemaId = schema.getId().orElseThrow();
    }

    @AfterAll
    void tearDown() {
        try { Smoke.live().schemas().deleteSchema(schemaId); } catch (RuntimeException ignored) { }
    }

    // -----------------------------------------------------------------------
    // Placement
    // -----------------------------------------------------------------------

    @Test
    void tenantWideRegistrationRegisterGetListUpdateDelete() {
        String namespace = nsName("tw");
        int rank = uniqueRank();
        NamespaceResponse created = Smoke.live().identity().registerNamespace(
            NamespaceRequest.builder().namespace(namespace).specificityRank(rank).build());
        assertEquals(namespace, created.getNamespace().orElse(null));
        assertTrue(created.getContextId().isEmpty());

        try {
            NamespaceResponse loaded = Smoke.live().identity().getNamespace(namespace);
            assertTrue(loaded.getContextId().isEmpty());
            assertEquals(rank, loaded.getSpecificityRank().orElse(-1));

            NamespaceResponse updated = Smoke.live().identity().updateNamespace(namespace,
                NamespaceRequest.builder().namespace(namespace).specificityRank(rank + 1).build());
            assertEquals(rank + 1, updated.getSpecificityRank().orElse(-1));

            var listed = Smoke.live().identity().listNamespaces();
            var names = listed.getData().orElseThrow().stream().map(n -> n.getNamespace().orElse(null)).toList();
            assertTrue(names.contains(namespace));
        } finally {
            Smoke.live().identity().deleteNamespace(namespace);
        }
        Smoke.expectStatus(() -> Smoke.live().identity().getNamespace(namespace), 404);
    }

    @Test
    void contextOwnedRegistrationEntitiesInvisibleFromSiblingContext() {
        String ctxA = Smoke.slug("nsa");
        String ctxB = Smoke.slug("nsb");
        String namespace = nsName("co");
        Smoke.live().auth().createAppContext(AppContextRequest.builder().contextId(ctxA).name("namespace ctx A (java)").build());
        Smoke.live().auth().createAppContext(AppContextRequest.builder().contextId(ctxB).name("namespace ctx B (java)").build());

        NamespaceResponse created = Smoke.live().identity().registerNamespace(RegisterNamespaceRequest.builder()
            .body(NamespaceRequest.builder().namespace(namespace).specificityRank(500).entityBacked(true).build())
            .contextId(ctxA)
            .build());
        assertEquals(ctxA, created.getContextId().orElse(null));

        String entityId = null;
        try {
            NamespaceResponse loaded = Smoke.live().identity().getNamespace(namespace,
                GetNamespaceRequest.builder().contextId(ctxA).build());
            assertEquals(ctxA, loaded.getContextId().orElse(null));
            Smoke.expectStatus(() -> Smoke.live().identity().getNamespace(namespace,
                GetNamespaceRequest.builder().contextId(ctxB).build()), 404);

            EntityResponse entity = Smoke.live().identity().createEntity(namespace, CreateEntityRequest.builder()
                .body(EntityRequest.builder().externalId("ent-" + Smoke.uniqueTag()).name("A-owned").build())
                .contextId(ctxA)
                .build());
            entityId = entity.getId().orElseThrow();
            final String finalEntityId = entityId;

            Smoke.expectStatus(() -> Smoke.live().identity().getEntity(namespace, finalEntityId,
                GetEntityRequest.builder().contextId(ctxB).build()), 404);

            EntityResponse reloaded = Smoke.live().identity().getEntity(namespace, entityId,
                GetEntityRequest.builder().contextId(ctxA).build());
            assertEquals(entityId, reloaded.getId().orElse(null));
        } finally {
            if (entityId != null) {
                final String finalEntityId = entityId;
                try { Smoke.live().identity().deleteEntity(namespace, finalEntityId,
                    DeleteEntityRequest.builder().contextId(ctxA).build()); } catch (RuntimeException ignored) { }
            }
            try { Smoke.live().identity().deleteNamespace(namespace,
                DeleteNamespaceRequest.builder().contextId(ctxA).build()); } catch (RuntimeException ignored) { }
            try { Smoke.live().auth().deleteAppContext(ctxA,
                ai.vectros.resources.auth.requests.DeleteAppContextRequest.builder().confirm(ctxA).build()); } catch (RuntimeException ignored) { }
            try { Smoke.live().auth().deleteAppContext(ctxB,
                ai.vectros.resources.auth.requests.DeleteAppContextRequest.builder().confirm(ctxB).build()); } catch (RuntimeException ignored) { }
        }
    }

    // -----------------------------------------------------------------------
    // Membership -- ${{ member.scope.<ns> }} resolves fresh on every request
    // -----------------------------------------------------------------------

    @Test
    void bareMemberScopeGrantFollowsTheRecordAndRevokesImmediately() {
        String namespace = nsName("m");
        String value = "team-" + Smoke.uniqueTag();
        // membershipContextId='default': a record created with a root API key has
        // no way to target a non-default context, so the grant record and the mint
        // below must agree on 'default' or the membership placeholder resolves to
        // nothing.
        Smoke.live().identity().registerNamespace(NamespaceRequest.builder()
            .namespace(namespace).specificityRank(uniqueRank())
            .membershipRecordType(recordType).membershipTargetField("granteeUserId")
            .membershipContextId("default").build());
        UserResponse user = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        String grantId = null;
        try {
            RecordResponse grant = Smoke.live().records().createRecord(RecordRequest.builder()
                .typeName(recordType).schemaId(schemaId)
                .payload(Map.of("granteeUserId", user.getId().orElseThrow()))
                .scopes(List.of(namespace + ":" + value)).build());
            grantId = grant.getId().orElseThrow();
            // Not polling for INDEXED: indexMode NONE (store-only) -- reads go
            // through listRecords (the primary store), not search.

            // scope.identity.userId is REQUIRED and distinct from the top-level
            // userId -- membership resolution looks up the caller's own identity
            // from scope.identity.
            MintTokenResponse minted = Smoke.live().auth().mintToken(TokenRequest.builder()
                .scope(ScopeRequest.builder()
                    .allowedActions(List.of("records:r"))
                    .identity(Map.of("userId", user.getId().orElseThrow()))
                    .dataScope(Map.of("scope:" + namespace, List.of("${{ member.scope." + namespace + " }}")))
                    .build())
                .userId(user.getId().orElseThrow())
                .build());
            var scoped = Smoke.client(minted.getToken());

            var seen = scoped.records().listRecords(ListRecordsRequest.builder()
                .type(recordType).scope(namespace + ":" + value).build());
            final String finalGrantId = grantId;
            assertTrue(seen.getData().orElseThrow().stream().anyMatch(r -> finalGrantId.equals(r.getId().orElse(null))));

            // Revoke -- delete the grant record -- then immediately re-query with
            // the SAME (unexpired, not re-minted) token. Resolution is per-request.
            Smoke.live().records().deleteRecord(grantId);
            grantId = null;
            Smoke.expectStatus(() -> scoped.records().listRecords(ListRecordsRequest.builder()
                .type(recordType).scope(namespace + ":" + value).build()), 403);
        } finally {
            if (grantId != null) {
                final String finalGrantId = grantId;
                try { Smoke.live().records().deleteRecord(finalGrantId); } catch (RuntimeException ignored) { }
            }
            try { Smoke.live().identity().deleteUser(user.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteNamespace(namespace); } catch (RuntimeException ignored) { }
        }
    }
}
