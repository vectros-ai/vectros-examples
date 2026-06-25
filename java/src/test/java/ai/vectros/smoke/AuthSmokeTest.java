package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.types.MintTokenResponse;
import ai.vectros.types.PingResponse;
import ai.vectros.types.RecordRequest;
import ai.vectros.types.ScopeRequest;
import ai.vectros.resources.auth.requests.TokenRequest;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/**
 * API-key auth, health check, and the scoped-token mint/enforce cycle. The ping
 * test is the single most important smoke check: if it fails, the key is invalid
 * or the API unreachable.
 */
class AuthSmokeTest {

    // ANCHOR — most important test in the suite.
    @Test
    void pingOkWithValidKey() {
        PingResponse r = Smoke.live().auth().ping();
        assertNotNull(r);
        assertNotNull(r.getEnvironment());
    }

    @Test
    void ping403WithInvalidKey() {
        VectrosApiClient bad = Smoke.client("sk_live_invalid_for_smoke_test");
        // Invalid keys surface as 403 (denied before any handler runs), not 401.
        Smoke.expectStatus(() -> bad.auth().ping(), 403);
    }

    @Test
    void getUsageDeserializes() {
        // Auth-bearing GET + clean Jackson deserialization of the usage report.
        assertNotNull(Smoke.live().auth().getUsage());
    }

    @Test
    void mintScopedTokenReturnsTokenAndExpiry() {
        MintTokenResponse minted = Smoke.live().auth().mintToken(TokenRequest.builder()
            .scope(ScopeRequest.builder().allowedActions(List.of("records:r")).build()).build());
        assertTrue(minted.getToken().startsWith("st_"), "expected an st_ scoped token");
        assertTrue(minted.getExpiresAt() > Instant.now().getEpochSecond(), "expiry must be in the future");
    }

    @Test
    void scopedTokenRecordsRAllowsListBlocksCreate() {
        // Action-letter enforcement: 'r' allows list, blocks create with a
        // uniform 403 (the API does not reveal which scope check failed).
        MintTokenResponse minted = Smoke.live().auth().mintToken(TokenRequest.builder()
            .scope(ScopeRequest.builder().allowedActions(List.of("records:r")).build()).build());
        VectrosApiClient scoped = Smoke.client(minted.getToken());

        // list is a read — allowed.
        assertNotNull(scoped.records().listRecords(
            ai.vectros.resources.records.requests.ListRecordsRequest.builder().type("any").build()));

        // create is a write — must be rejected with a uniform 403.
        Smoke.expectStatus(() -> scoped.records().createRecord(RecordRequest.builder()
            .typeName("smoke_unauthorized_" + Smoke.uniqueTag())
            .schemaId("irrelevant-blocked-by-scope")
            .payload(Map.of()).build()), 403);
    }
}
