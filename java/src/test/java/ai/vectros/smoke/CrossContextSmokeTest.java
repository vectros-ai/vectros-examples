package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.types.FieldDef;
import ai.vectros.types.FieldDefFieldType;
import ai.vectros.types.LookupDef;
import ai.vectros.types.SearchResult;
import ai.vectros.types.SchemaRequest;
import ai.vectros.types.SchemaRequestAllowedSurfacesItem;
import ai.vectros.types.SchemaRequestIndexMode;
import ai.vectros.types.DocumentRequest;
import ai.vectros.types.DocumentRequestIndexMode;
import ai.vectros.types.RecordRequest;
import ai.vectros.resources.records.requests.LookupRecordsRequest;
import ai.vectros.resources.records.requests.ListRecordsRequest;
import ai.vectros.resources.search.requests.SearchRequest;
import ai.vectros.resources.search.types.SearchRequestMode;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/**
 * End-to-end proof that an app context is a fail-closed data partition within
 * ONE tenant. Each test is SYMMETRIC — each confined caller sees ONLY its own
 * object and gets a
 * uniform 404 for the sibling's (no existence probe). Cross-context get/delete
 * return 404 (the partition), NOT 403 (scope denial — covered in AuthSmokeTest).
 */
class CrossContextSmokeTest {

    private static VectrosApiClient root;
    private static CrossContext.Fixture fx;

    @BeforeAll
    static void provision() {
        Assumptions.assumeTrue(Smoke.optEnv("VECTROS_API_KEY") != null, "VECTROS_API_KEY required");
        Assumptions.assumeTrue(Smoke.optEnv("VECTROS_LIVE_TENANT_ID") != null,
            "VECTROS_LIVE_TENANT_ID required for cross-context isolation");
        root = Smoke.live();
        fx = CrossContext.provisionTwo(root);
    }

    @AfterAll
    static void teardown() {
        if (fx != null) fx.teardown(root);
    }

    @Test
    void recordsEachContextSeesOnlyItsOwn() {
        CrossContext.Handle a = fx.a, b = fx.b;
        String type = ("xctx_rec_" + Smoke.uniqueTag()).replace("-", "_");
        String mrnA = "MRN-A-" + Smoke.uniqueTag(), mrnB = "MRN-B-" + Smoke.uniqueTag();

        String recA = createRecord(a, type, mrnA);
        String recB = createRecord(b, type, mrnB);

        // ctxA sees A, never B.
        assertEquals(recA, a.api.records().getRecord(recA).getId().orElseThrow());
        Smoke.expectStatus(() -> a.api.records().getRecord(recB), 404);
        assertEquals(List.of(recA), lookupRecordIds(a, type, "mrn", mrnA));
        assertEquals(List.of(), lookupRecordIds(a, type, "mrn", mrnB));
        assertTrue(listRecordIds(a, type).contains(recA));
        assertFalse(listRecordIds(a, type).contains(recB));

        // ctxB sees B, never A.
        assertEquals(recB, b.api.records().getRecord(recB).getId().orElseThrow());
        Smoke.expectStatus(() -> b.api.records().getRecord(recA), 404);
        assertEquals(List.of(recB), lookupRecordIds(b, type, "mrn", mrnB));
        assertEquals(List.of(), lookupRecordIds(b, type, "mrn", mrnA));

        // Mutate isolation: neither can DELETE the other's record (the confined
        // keys hold records:d, so a 404 is the partition, not a missing scope).
        Smoke.expectStatus(() -> b.api.records().deleteRecord(recA), 404);
        Smoke.expectStatus(() -> a.api.records().deleteRecord(recB), 404);
        assertEquals(recA, a.api.records().getRecord(recA).getId().orElseThrow());
        assertEquals(recB, b.api.records().getRecord(recB).getId().orElseThrow());
        // ...and each context CAN delete its OWN (proves both delete routes live).
        a.api.records().deleteRecord(recA);
        Smoke.expectStatus(() -> a.api.records().getRecord(recA), 404);
        b.api.records().deleteRecord(recB);
        Smoke.expectStatus(() -> b.api.records().getRecord(recB), 404);
    }

    @Test
    void documentsEachContextSeesOnlyItsOwnInclSearch() {
        CrossContext.Handle a = fx.a, b = fx.b;
        String type = ("xctx_doc_" + Smoke.uniqueTag()).replace("-", "_");
        String poA = "PO-A-" + Smoke.uniqueTag(), poB = "PO-B-" + Smoke.uniqueTag();
        String markerA = ("XCTXMARKERA_" + Smoke.uniqueTag()).replace("-", "_");
        String markerB = ("XCTXMARKERB_" + Smoke.uniqueTag()).replace("-", "_");
        String startedAt = Instant.now().toString();

        String docA = createDoc(a, type, poA, markerA);
        String docB = createDoc(b, type, poB, markerB);
        pollIndexed(a, docA);
        pollIndexed(b, docB);

        // by-id.
        assertEquals(docA, a.api.documents().getDocument(docA).getId().orElseThrow());
        Smoke.expectStatus(() -> a.api.documents().getDocument(docB), 404);
        assertEquals(docB, b.api.documents().getDocument(docB).getId().orElseThrow());
        Smoke.expectStatus(() -> b.api.documents().getDocument(docA), 404);

        // search — each context finds its own marker; the partition keeps the
        // sibling's document out (positive control proves search is live for both).
        assertTrue(searchDocIds(a, markerA, startedAt).contains(docA));
        assertFalse(searchDocIds(a, markerB, startedAt).contains(docB));
        assertTrue(searchDocIds(b, markerB, startedAt).contains(docB));
        assertFalse(searchDocIds(b, markerA, startedAt).contains(docA));

        // Mutate isolation, then each deletes its own.
        Smoke.expectStatus(() -> b.api.documents().deleteDocument(docA), 404);
        Smoke.expectStatus(() -> a.api.documents().deleteDocument(docB), 404);
        a.api.documents().deleteDocument(docA);
        Smoke.expectStatus(() -> a.api.documents().getDocument(docA), 404);
        b.api.documents().deleteDocument(docB);
        Smoke.expectStatus(() -> b.api.documents().getDocument(docB), 404);
    }

    // ---- helpers (operate through a context's confined client) ----
    private static String createRecord(CrossContext.Handle ctx, String type, String mrn) {
        var schema = ctx.api.schemas().createSchema(SchemaRequest.builder()
            .typeName(type).displayName("Cross-context Record Schema")
            .indexMode(SchemaRequestIndexMode.NONE)
            .allowedSurfaces(List.of(SchemaRequestAllowedSurfacesItem.RECORD))
            .fields(List.of(FieldDef.builder().fieldId("mrn").fieldType(FieldDefFieldType.STRING).required(true).build()))
            .lookupFields(List.of(LookupDef.builder().fieldName("mrn").unique(true).build()))
            .build());
        return ctx.api.records().createRecord(RecordRequest.builder()
            .typeName(type).schemaId(schema.getId().orElseThrow()).payload(Map.of("mrn", mrn)).build())
            .getId().orElseThrow();
    }

    private static List<String> lookupRecordIds(CrossContext.Handle ctx, String type, String field, String value) {
        return ctx.api.records().lookupRecords(LookupRecordsRequest.builder().type(type).field(field).value(value).build())
            .getData().orElse(List.of()).stream().map(r -> r.getId().orElse(null)).filter(java.util.Objects::nonNull).collect(Collectors.toList());
    }

    private static List<String> listRecordIds(CrossContext.Handle ctx, String type) {
        return ctx.api.records().listRecords(ListRecordsRequest.builder().type(type).limit(100L).build())
            .getData().orElse(List.of()).stream().map(r -> r.getId().orElse(null)).filter(java.util.Objects::nonNull).collect(Collectors.toList());
    }

    private static String createDoc(CrossContext.Handle ctx, String type, String po, String marker) {
        var schema = ctx.api.schemas().createSchema(SchemaRequest.builder()
            .typeName(type).displayName("Cross-context Document Schema")
            .indexMode(SchemaRequestIndexMode.TEXT)
            .allowedSurfaces(List.of(SchemaRequestAllowedSurfacesItem.DOCUMENT))
            .fields(List.of(FieldDef.builder().fieldId("po_number").fieldType(FieldDefFieldType.STRING).build()))
            .lookupFields(List.of(LookupDef.builder().fieldName("po_number").unique(false).build()))
            .build());
        return ctx.api.documents().ingestDocument(DocumentRequest.builder()
            .title("Cross-context Doc " + po).schemaId(schema.getId().orElseThrow())
            .text("Confidential note " + marker + " for purchase order " + po + ".")
            .indexMode(DocumentRequestIndexMode.TEXT).storeText(true)
            .payload(Map.of("po_number", po)).build())
            .getId().orElseThrow();
    }

    private static List<String> searchDocIds(CrossContext.Handle ctx, String query, String createdAfter) {
        return ctx.api.search().content(SearchRequest.builder()
            .query(query).mode(SearchRequestMode.TEXT).limit(100).createdAfter(createdAfter).build())
            .getResults().orElse(List.of()).stream()
            .map(SearchResult::getDocumentId).filter(java.util.Optional::isPresent).map(java.util.Optional::get)
            .collect(Collectors.toList());
    }

    private static void pollIndexed(CrossContext.Handle ctx, String docId) {
        for (int i = 0; i < 30; i++) {
            String status = ctx.api.documents().getDocument(docId).getStatus().map(Object::toString).orElse("");
            if ("INDEXED".equals(status)) return;
            if ("FAILED".equals(status)) fail("document " + docId + " reached FAILED during indexing");
            Smoke.sleep(2000);
        }
        fail("document " + docId + " did not reach INDEXED in time");
    }
}
