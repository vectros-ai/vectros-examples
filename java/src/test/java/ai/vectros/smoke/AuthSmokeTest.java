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
    void rootKeyPrincipalKeyIdIsStableAcrossCalls() {
        // principalKeyId for a root sk_* key identifies the KEY, not the call —
        // unlike an st_* token's per-mint jti (see
        // scopedTokenPrincipalKeyIdIsUniquePerMint), two pings with the SAME key
        // must report the SAME value. Asserting only "is a string" would not
        // catch a regression that started minting a fresh id per call.
        PingResponse r1 = Smoke.live().auth().ping();
        PingResponse r2 = Smoke.live().auth().ping();
        assertNotNull(r1.getPrincipalKeyId());
        assertEquals(r1.getPrincipalKeyId(), r2.getPrincipalKeyId());
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
    void scopedTokenPrincipalKeyIdIsUniquePerMint() {
        // principalKeyId for an st_* token is the token's own jti (unique per
        // mint), not the bound identity — two tokens minted for the same scope
        // must report different values on ping. Asserting only "is a string"
        // would not catch a regression back to the old (pre-0.39.0) behavior,
        // which echoed the bound user/key id and would be IDENTICAL across mints.
        ScopeRequest scope = ScopeRequest.builder().allowedActions(List.of("records:r")).build();
        MintTokenResponse minted1 = Smoke.live().auth().mintToken(TokenRequest.builder().scope(scope).build());
        MintTokenResponse minted2 = Smoke.live().auth().mintToken(TokenRequest.builder().scope(scope).build());

        PingResponse body1 = Smoke.client(minted1.getToken()).auth().ping();
        PingResponse body2 = Smoke.client(minted2.getToken()).auth().ping();
        assertEquals(ai.vectros.types.PingResponsePrincipalType.TOKEN, body1.getPrincipalType());
        assertNotEquals(body1.getPrincipalKeyId(), body2.getPrincipalKeyId());
    }

    @Test
    void mintTokenRejectsExpiresInSecondsAboveThe1HourCap() {
        // 0.39.0 lowered the max from 86400 (24h) to 3600 (1h). Assert both
        // sides of the exact boundary: 3600 still succeeds (it's also the
        // default), 3601 is rejected.
        ScopeRequest scope = ScopeRequest.builder().allowedActions(List.of("records:r")).build();
        MintTokenResponse atCap = Smoke.live().auth().mintToken(
            TokenRequest.builder().scope(scope).expiresInSeconds(3600).build());
        assertTrue(atCap.getToken().startsWith("st_"));

        Smoke.expectStatus(() -> Smoke.live().auth().mintToken(
            TokenRequest.builder().scope(scope).expiresInSeconds(3601).build()), 400);
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
