package ai.vectros.smoke;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/**
 * The API error response contract. A malformed JSON body must come back as a
 * clean 4xx whose body is well-formed JSON and never leaks Jackson internals.
 * These tests go around the SDK (raw HTTP via Smoke.rawPost) — the typed surface
 * would reject the deliberately malformed bodies at call time, but the backend
 * contract must hold against any well-formed HTTP request with a malformed JSON
 * body.
 */
class ErrorContractSmokeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // A deliberately malformed schema body: lookupFields should be
    // [{fieldName, unique}], not a bare string array.
    private static final String MALFORMED_SCHEMA_BODY =
        "{\"recordType\":\"task\",\"displayName\":\"Task\",\"lookupFields\":[\"externalId\"]}";

    @Test
    void malformedBodyIs4xxNever5xx() throws Exception {
        Smoke.RawResponse r = Smoke.rawPost("/v1/schemas", MALFORMED_SCHEMA_BODY);
        assertTrue(r.status() >= 400 && r.status() < 500, "expected 4xx, got " + r.status());
        JsonNode body = MAPPER.readTree(r.body()); // throwing here IS the bug class we guard
        assertTrue(body.hasNonNull("message") && body.get("message").asText().length() > 0);
    }

    @Test
    void responseBodyParsesWithoutControlChars() throws Exception {
        Smoke.RawResponse r = Smoke.rawPost("/v1/schemas", MALFORMED_SCHEMA_BODY);
        assertDoesNotThrow(() -> MAPPER.readTree(r.body()));
        for (int i = 0; i < r.body().length(); i++) {
            char ch = r.body().charAt(i);
            assertTrue(ch >= 0x20 || ch == '\t' || ch == '\n' || ch == '\r',
                "raw control char in error body at " + i);
        }
    }

    @Test
    void errorBodyCarriesMessageAndRequestId() throws Exception {
        Smoke.RawResponse r = Smoke.rawPost("/v1/schemas", MALFORMED_SCHEMA_BODY);
        JsonNode body = MAPPER.readTree(r.body());
        assertTrue(body.hasNonNull("message"));
        // requestId is your hook to ask support to look up logs.
        assertTrue(body.hasNonNull("requestId") && body.get("requestId").asText().length() > 0,
            "expected a non-empty requestId");
    }

    @Test
    void errorBodyDoesNotLeakJacksonInternals() throws Exception {
        Smoke.RawResponse r = Smoke.rawPost("/v1/schemas", MALFORMED_SCHEMA_BODY);
        for (String marker : new String[]{"com.fasterxml", "MismatchedInput", "JsonMappingException", "[Source:"}) {
            assertFalse(r.body().contains(marker), "error body leaked internal marker: " + marker);
        }
    }

    @Test
    void completelyBrokenJsonStillClean4xx() throws Exception {
        Smoke.RawResponse r = Smoke.rawPost("/v1/schemas", "{this is not even close to valid JSON");
        assertTrue(r.status() >= 400 && r.status() < 500, "expected 4xx, got " + r.status());
        JsonNode body = MAPPER.readTree(r.body());
        assertTrue(body.hasNonNull("message"));
    }
}
