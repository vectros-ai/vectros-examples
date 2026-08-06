package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.types.FieldDef;
import ai.vectros.types.FieldDefFieldType;
import ai.vectros.types.LookupDef;
import ai.vectros.types.SchemaRequest;
import ai.vectros.types.SchemaRequestAllowedSurfacesItem;
import ai.vectros.types.SchemaRequestIndexMode;
import ai.vectros.types.RecordRequest;
import ai.vectros.resources.records.requests.LookupRecordsRequest;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/**
 * SDK 0.38.0's composite lookup (`fieldNames` in place of `fieldName`, and the
 * new array-typed `values` parameter) — the Java-language analogue of the
 * TypeScript composite-lookup example.
 *
 * This test also settles the one open question for Java's generated client:
 * whether it sends a REPEATED `values=a&values=b` query parameter (the
 * correct `style: form, explode: true` encoding) or some other encoding that
 * splits a single value at an internal comma into two legs — whether that
 * would be a literal comma-join (`values=a,b`) or a different indexed form.
 * Either wrong encoding silently corrupts any legal value that itself
 * contains a comma — indistinguishable from the caller having meant one more
 * leg than they did. {@link #commaBearingValueSurvivesAsOneLegNotSplit}
 * is the empirical Java confirmation — it writes a record whose lookup VALUE
 * itself contains a comma and proves it survives as one leg, not two.
 */
class CompositeLookupSmokeTest {

    private static VectrosApiClient root;
    private static String recordType;
    private static String schemaId;
    private static String recOpenBilling;
    private static String recOpenCommaValue;

    @BeforeAll
    static void provision() {
        root = Smoke.live();
        recordType = ("smoke_ticket_" + Smoke.uniqueTag()).replace("-", "_");

        var schema = root.schemas().createSchema(SchemaRequest.builder()
            .typeName(recordType).displayName("Composite Lookup Smoke")
            .indexMode(SchemaRequestIndexMode.NONE)
            // A lookup over several fields cannot set `unique` or
            // `rangeEnabled`, and its schema must list `record` as its only
            // allowedSurfaces entry.
            .allowedSurfaces(List.of(SchemaRequestAllowedSurfacesItem.RECORD))
            .fields(List.of(
                FieldDef.builder().fieldId("status").fieldType(FieldDefFieldType.STRING)
                    .required(true).filterable(true).build(),
                FieldDef.builder().fieldId("area").fieldType(FieldDefFieldType.STRING)
                    .required(true).filterable(true).build()))
            // Declare with `fieldNames` in place of `fieldName`.
            .lookupFields(List.of(LookupDef.builder().fieldNames(List.of("status", "area")).build()))
            .build());
        schemaId = schema.getId().orElseThrow();

        recOpenBilling = root.records().createRecord(RecordRequest.builder()
            .typeName(recordType).schemaId(schemaId)
            .payload(Map.of("status", "open", "area", "billing")).build())
            .getId().orElseThrow();
        // The comma-bearing value — see the class doc for why this is the
        // one case that would silently regress with zero signal from the
        // type system.
        recOpenCommaValue = root.records().createRecord(RecordRequest.builder()
            .typeName(recordType).schemaId(schemaId)
            .payload(Map.of("status", "open", "area", "billing,enterprise")).build())
            .getId().orElseThrow();
    }

    @AfterAll
    static void teardown() {
        if (recOpenBilling != null) try { root.records().deleteRecord(recOpenBilling); } catch (Exception ignore) {}
        if (recOpenCommaValue != null) try { root.records().deleteRecord(recOpenCommaValue); } catch (Exception ignore) {}
        if (schemaId != null) try { root.schemas().deleteSchema(schemaId); } catch (Exception ignore) {}
    }

    private static List<String> lookupIds(List<String> values) {
        var page = root.records().lookupRecords(LookupRecordsRequest.builder()
            .type(recordType).field("status,area").values(values).build());
        return page.getData().orElse(List.of()).stream()
            .map(r -> r.getId().orElse(null)).filter(Objects::nonNull).collect(Collectors.toList());
    }

    @Test
    void fullTupleMatchesExactlyOneRecord() {
        List<String> ids = lookupIds(List.of("open", "billing"));
        assertEquals(List.of(recOpenBilling), ids); // exactly one match — not "contains"
    }

    @Test
    void commaBearingValueSurvivesAsOneLegNotSplit() {
        // If the wire serialization comma-joined `values` instead of
        // repeating the query parameter, `values=["open", "billing,enterprise"]`
        // would arrive at the server looking like three legs
        // (open, billing, enterprise) rather than two — either rejected
        // outright or simply not matching this record — so this assertion
        // fails one way or another if the encoding regresses.
        List<String> ids = lookupIds(List.of("open", "billing,enterprise"));
        assertTrue(ids.contains(recOpenCommaValue),
            "comma-bearing value must survive as one leg — if this fails, the Java client is " +
            "comma-joining `values` instead of repeating the query parameter");
        assertFalse(ids.contains(recOpenBilling)); // "billing" != "billing,enterprise"
    }
}
