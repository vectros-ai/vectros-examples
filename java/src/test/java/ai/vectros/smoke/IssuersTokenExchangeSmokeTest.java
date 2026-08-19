package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.resources.auth.requests.DeleteAppContextRequest;
import ai.vectros.resources.auth.requests.IssuerRequest;
import ai.vectros.resources.auth.requests.ListIssuersRequest;
import ai.vectros.resources.auth.requests.TokenExchangeRequest;
import ai.vectros.resources.auth.requests.TokenRequest;
import ai.vectros.resources.identity.requests.UserExistsByEmailRequest;
import ai.vectros.types.AccessProfileRequest;
import ai.vectros.types.AppContextRequest;
import ai.vectros.types.IssuerPage;
import ai.vectros.types.IssuerResponse;
import ai.vectros.types.MintTokenResponse;
import ai.vectros.types.RoleRequest;
import ai.vectros.types.ScopeClause;
import ai.vectros.types.ScopeRequest;
import ai.vectros.types.UserRequest;
import ai.vectros.types.UserResponse;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.stream.Collectors;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import static org.junit.jupiter.api.Assertions.*;

/**
 * The trusted BYO-IdP issuer registry and RFC 8693 token exchange — the
 * Java-language analogue of {@code issuers-token-exchange.spec.ts}.
 *
 * SCOPE NOTE (see that file for the full reasoning): a genuinely SUCCESSFUL
 * exchange needs a subject_token signed by a PUBLICLY reachable JWKS this
 * suite controls the private key for -- no such fixture is available, and
 * standing one up is out of scope here. This covers the full issuer-registry
 * CRUD contract plus every exchange() rejection reachable without one,
 * including a real 401 (registered against Google's real, stable public
 * JWKS, presented with a signature that can never verify against it).
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class IssuersTokenExchangeSmokeTest {

    private static final String GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
    private static final String JWT_TYPE = "urn:ietf:params:oauth:token-type:jwt";
    private static final Base64.Encoder B64URL = Base64.getUrlEncoder().withoutPadding();
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private String ctxId;

    @BeforeAll
    void setUp() {
        ctxId = slug("ix");
        Smoke.live().auth().createAppContext(
            AppContextRequest.builder().contextId(ctxId).name("issuers spec parent").build());
    }

    @AfterAll
    void tearDown() {
        try {
            Smoke.live().auth().deleteAppContext(ctxId,
                DeleteAppContextRequest.builder().confirm(ctxId).build());
        } catch (RuntimeException ignored) { }
    }

    /** header.payload.garbage-signature — structurally a JWT, never cryptographically verifiable. */
    private static String fakeJwt(String iss, Object aud, String sub) {
        String header = B64URL.encodeToString("{\"alg\":\"RS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        StringBuilder claims = new StringBuilder("{");
        if (iss != null) claims.append("\"iss\":\"").append(iss).append("\",");
        if (aud instanceof List<?> list) {
            claims.append("\"aud\":[").append(
                list.stream().map(a -> "\"" + a + "\"").collect(Collectors.joining(","))).append("],");
        } else if (aud != null) {
            claims.append("\"aud\":\"").append(aud).append("\",");
        }
        if (sub != null) claims.append("\"sub\":\"").append(sub).append("\",");
        if (claims.charAt(claims.length() - 1) == ',') claims.setLength(claims.length() - 1);
        claims.append("}");
        String payload = B64URL.encodeToString(claims.toString().getBytes(StandardCharsets.UTF_8));
        String sig = B64URL.encodeToString(("not-a-real-signature-" + Smoke.uniqueTag()).getBytes(StandardCharsets.UTF_8));
        return header + "." + payload + "." + sig;
    }

    private static String slug(String prefix) {
        String s = prefix + Smoke.uniqueTag();
        return s.substring(0, Math.min(31, s.length()));
    }

    // Every register/delete elsewhere in this file uses the root client. Writing an issuer
    // registration accepts ONLY a root sk_* key or the CLI bootstrap's dedicated provisioning
    // capability — a capability that can never be granted to an ordinary role, and that a bare
    // '*' wildcard does not satisfy either. An ordinary scoped token carrying neither must be
    // refused.
    @Test
    void registerIssuerWithOrdinaryScopedTokenIs403() {
        MintTokenResponse minted = Smoke.live().auth().mintToken(TokenRequest.builder()
            .scope(ScopeRequest.builder().allowedActions(List.of("records:r")).build())
            .contextId(ctxId).build());
        VectrosApiClient scoped = Smoke.client(minted.getToken());
        Smoke.expectStatus(() -> scoped.auth().registerIssuer(IssuerRequest.builder()
            .issuerId(slug("noauth")).issuer("https://" + Smoke.uniqueTag() + ".example.com/")
            .jwksUri("https://www.googleapis.com/oauth2/v3/certs")
            .audience("aud-" + Smoke.uniqueTag()).contextId(ctxId).build()), 403);
    }

    @Test
    void deleteIssuerWithOrdinaryScopedTokenIs403() {
        MintTokenResponse minted = Smoke.live().auth().mintToken(TokenRequest.builder()
            .scope(ScopeRequest.builder().allowedActions(List.of("records:r")).build())
            .contextId(ctxId).build());
        VectrosApiClient scoped = Smoke.client(minted.getToken());
        // The gate runs before any existence check — a non-existent issuerId must still 403, never
        // 404, so this proves the GATE fired, not a coincidental not-found.
        Smoke.expectStatus(() -> scoped.auth().deleteIssuer(slug("noauth")), 403);
    }

    @Test
    void registerGetListDeleteThenGet404s() {
        String issuerId = slug("reg");
        String issuer = "https://" + Smoke.uniqueTag() + ".example.com/";
        String audience = "aud-" + Smoke.uniqueTag();
        try {
            IssuerResponse created = Smoke.live().auth().registerIssuer(IssuerRequest.builder()
                .issuerId(issuerId).issuer(issuer).jwksUri("https://www.googleapis.com/oauth2/v3/certs")
                .audience(audience).contextId(ctxId).build());
            assertTrue(created.getCreated().orElse(false));
            assertEquals(issuerId, created.getIssuerId().orElse(null));

            IssuerResponse loaded = Smoke.live().auth().getIssuer(issuerId);
            assertEquals(audience, loaded.getAudience().orElse(null));

            // DRAIN all pages rather than trusting the default first page to still hold ours --
            // the shared tenant accumulates issuers across runs (including residue from an
            // aborted run's incomplete teardown), which can push a fresh registration off page 1.
            List<String> listedIds = new java.util.ArrayList<>();
            String cursor = null;
            do {
                var reqBuilder = ListIssuersRequest.builder().limit(100L);
                if (cursor != null) reqBuilder.startFrom(cursor);
                IssuerPage page = Smoke.live().auth().listIssuers(reqBuilder.build());
                page.getData().orElseThrow().forEach(i -> listedIds.add(i.getIssuerId().orElse(null)));
                cursor = page.getNextCursor().orElse(null);
            } while (cursor != null);
            assertTrue(listedIds.contains(issuerId));

            Smoke.live().auth().deleteIssuer(issuerId);
            Smoke.expectStatus(() -> Smoke.live().auth().getIssuer(issuerId), 404);
        } finally {
            try { Smoke.live().auth().deleteIssuer(issuerId); } catch (RuntimeException ignored) { }
        }
    }

    @Test
    void registeringSameIssuerIdTwiceIsIdempotent() {
        String issuerId = slug("idem");
        String issuer = "https://" + Smoke.uniqueTag() + ".example.com/";
        String audience = "aud-" + Smoke.uniqueTag();
        try {
            IssuerResponse first = Smoke.live().auth().registerIssuer(IssuerRequest.builder()
                .issuerId(issuerId).issuer(issuer).jwksUri("https://www.googleapis.com/oauth2/v3/certs")
                .audience(audience).contextId(ctxId).build());
            assertTrue(first.getCreated().orElse(false));

            // Second call names DIFFERENT issuer/audience — idempotency keys on issuerId alone, so
            // the ORIGINAL values must survive.
            IssuerResponse second = Smoke.live().auth().registerIssuer(IssuerRequest.builder()
                .issuerId(issuerId).issuer("https://different.example.com/").jwksUri("https://www.googleapis.com/oauth2/v3/certs")
                .audience("different-aud").contextId(ctxId).build());
            assertFalse(second.getCreated().orElse(true));
            assertEquals(issuer, second.getIssuer().orElse(null));
            assertEquals(audience, second.getAudience().orElse(null));
        } finally {
            try { Smoke.live().auth().deleteIssuer(issuerId); } catch (RuntimeException ignored) { }
        }
    }

    @Test
    void secondIssuerIdCannotClaimAnAlreadyRegisteredPair() {
        String issuer = "https://" + Smoke.uniqueTag() + ".example.com/";
        String audience = "aud-" + Smoke.uniqueTag();
        String firstId = slug("paira");
        String secondId = slug("pairb");
        try {
            Smoke.live().auth().registerIssuer(IssuerRequest.builder()
                .issuerId(firstId).issuer(issuer).jwksUri("https://www.googleapis.com/oauth2/v3/certs")
                .audience(audience).contextId(ctxId).build());
            Smoke.expectStatus(() -> Smoke.live().auth().registerIssuer(IssuerRequest.builder()
                .issuerId(secondId).issuer(issuer).jwksUri("https://www.googleapis.com/oauth2/v3/certs")
                .audience(audience).contextId(ctxId).build()), 400);
        } finally {
            try { Smoke.live().auth().deleteIssuer(firstId); } catch (RuntimeException ignored) { }
        }
    }

    @Test
    void selfSignupPolicyTargetingAnAlreadyElevatedRoleRejectedAtRegistration() {
        // 'provisioning:c' can never be granted to any role at all (rejected at role-authoring time,
        // independent of self-signup) — wildcard '*' is the grantable literal that is also
        // treated as elevated.
        String roleId = slug("elev");
        String issuerId = slug("selfup");
        Smoke.live().auth().createRole(ctxId, RoleRequest.builder()
            .roleId(roleId).name("Elevated")
            .scopes(List.of(ScopeClause.builder().allowedActions(List.of("*")).build()))
            .build());
        try {
            Smoke.expectStatus(() -> Smoke.live().auth().registerIssuer(IssuerRequest.builder()
                .issuerId(issuerId).issuer("https://" + Smoke.uniqueTag() + ".example.com/")
                .jwksUri("https://www.googleapis.com/oauth2/v3/certs")
                .audience("aud-" + Smoke.uniqueTag()).contextId(ctxId)
                .selfSignupPolicies(List.of(ai.vectros.types.SelfSignupPolicy.builder()
                    .signupType("member").roleId(roleId).build()))
                .build()), 400);
        } finally {
            try { Smoke.live().auth().deleteRole(ctxId, roleId); } catch (RuntimeException ignored) { }
        }
    }

    @Test
    void exchangeMissingSubjectTokenIs400() {
        Smoke.expectStatus(() -> Smoke.live().auth().exchangeToken(TokenExchangeRequest.builder()
            .grantType(GRANT_TYPE).subjectToken("").subjectTokenType(JWT_TYPE).build()), 400);
    }

    @Test
    void exchangeMalformedJwtIs400() {
        Smoke.expectStatus(() -> Smoke.live().auth().exchangeToken(TokenExchangeRequest.builder()
            .grantType(GRANT_TYPE).subjectToken("not-even-jwt-shaped").subjectTokenType(JWT_TYPE).build()), 400);
    }

    @Test
    void exchangeUnregisteredIssuerIs404() {
        String jwt = fakeJwt("https://never-registered-" + Smoke.uniqueTag() + ".example.com/",
            "no-such-audience-" + Smoke.uniqueTag(), "someone");
        Smoke.expectStatus(() -> Smoke.live().auth().exchangeToken(TokenExchangeRequest.builder()
            .grantType(GRANT_TYPE).subjectToken(jwt).subjectTokenType(JWT_TYPE).build()), 404);
    }

    @Test
    void exchangeRegisteredIssuerButUnverifiableSignatureIs401ThenDeregisteredIs404() {
        String issuerId = slug("verify");
        String issuer = "https://accounts.google.com";
        String audience = "aud-" + Smoke.uniqueTag();
        Smoke.live().auth().registerIssuer(IssuerRequest.builder()
            .issuerId(issuerId).issuer(issuer).jwksUri("https://www.googleapis.com/oauth2/v3/certs")
            .audience(audience).contextId(ctxId).build());
        try {
            String jwt = fakeJwt(issuer, audience, "smoke-" + Smoke.uniqueTag());
            Smoke.expectStatus(() -> Smoke.live().auth().exchangeToken(TokenExchangeRequest.builder()
                .grantType(GRANT_TYPE).subjectToken(jwt).subjectTokenType(JWT_TYPE).build()), 401);

            Smoke.live().auth().deleteIssuer(issuerId);
            String jwt2 = fakeJwt(issuer, audience, "smoke-" + Smoke.uniqueTag());
            Smoke.expectStatus(() -> Smoke.live().auth().exchangeToken(TokenExchangeRequest.builder()
                .grantType(GRANT_TYPE).subjectToken(jwt2).subjectTokenType(JWT_TYPE).build()), 404);
        } finally {
            try { Smoke.live().auth().deleteIssuer(issuerId); } catch (RuntimeException ignored) { }
        }
    }

    // -----------------------------------------------------------------------
    // Token exchange — OAuth error envelope shape (RFC 6749 §5.2)
    // -----------------------------------------------------------------------
    // Every rejection test above asserts statusOf() only. This proves the BODY
    // shape too — the deliberate deviation from this API's usual {message}
    // envelope, since a generic OAuth client (not the Vectros SDK) is the
    // documented caller. Uses Smoke.rawPost — the Fern ApiException has no
    // typed field for either OAuth key (no response schema is declared for
    // the 4xx/401/403/404 cases).

    @Test
    void exchange400UsesOAuthEnvelopeNotMessage() throws Exception {
        Smoke.RawResponse r = Smoke.rawPost("/v1/auth/token/exchange",
            "{\"grant_type\":\"" + GRANT_TYPE + "\",\"subject_token\":\"\",\"subject_token_type\":\"" + JWT_TYPE + "\"}");
        assertEquals(400, r.status());
        JsonNode body = MAPPER.readTree(r.body());
        assertTrue(body.hasNonNull("error") && body.get("error").asText().length() > 0);
        assertTrue(body.hasNonNull("error_description") && body.get("error_description").asText().length() > 0);
        assertFalse(body.has("message"));
    }

    @Test
    void exchange404UsesOAuthEnvelopeNotMessage() throws Exception {
        String jwt = fakeJwt("https://definitely-never-registered-" + Smoke.uniqueTag() + ".example.com/",
            "no-such-audience-" + Smoke.uniqueTag(), null);
        Smoke.RawResponse r = Smoke.rawPost("/v1/auth/token/exchange",
            "{\"grant_type\":\"" + GRANT_TYPE + "\",\"subject_token\":\"" + jwt + "\",\"subject_token_type\":\"" + JWT_TYPE + "\"}");
        assertEquals(404, r.status());
        JsonNode body = MAPPER.readTree(r.body());
        assertTrue(body.hasNonNull("error") && body.get("error").asText().length() > 0);
        assertTrue(body.hasNonNull("error_description") && body.get("error_description").asText().length() > 0);
        assertFalse(body.has("message"));
    }

    @Test
    void exchange401UsesOAuthEnvelopeNotMessage() throws Exception {
        String issuerId = slug("envl");
        String issuer = "https://accounts.google.com";
        String audience = "aud-" + Smoke.uniqueTag();
        Smoke.live().auth().registerIssuer(IssuerRequest.builder()
            .issuerId(issuerId).issuer(issuer).jwksUri("https://www.googleapis.com/oauth2/v3/certs")
            .audience(audience).contextId(ctxId).build());
        try {
            String jwt = fakeJwt(issuer, audience, "smoke-" + Smoke.uniqueTag());
            Smoke.RawResponse r = Smoke.rawPost("/v1/auth/token/exchange",
                "{\"grant_type\":\"" + GRANT_TYPE + "\",\"subject_token\":\"" + jwt + "\",\"subject_token_type\":\"" + JWT_TYPE + "\"}");
            assertEquals(401, r.status());
            JsonNode body = MAPPER.readTree(r.body());
            assertTrue(body.hasNonNull("error") && body.get("error").asText().length() > 0);
            assertTrue(body.hasNonNull("error_description") && body.get("error_description").asText().length() > 0);
            assertFalse(body.has("message"));
        } finally {
            try { Smoke.live().auth().deleteIssuer(issuerId); } catch (RuntimeException ignored) { }
        }
    }

    @Test
    void existsByEmailTrueForAMemberFalseForAStranger() {
        String email = Smoke.uniqueTag() + "@test.com";
        UserResponse user = Smoke.live().identity().createUser(
            UserRequest.builder().externalId(Smoke.uniqueTag()).email(email).build());
        Smoke.live().auth().createAccessProfile(ctxId, AccessProfileRequest.builder()
            .principalId("usr_" + user.getId().orElseThrow())
            .scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r")).build()))
            .build());
        try {
            var found = Smoke.live().identity().userExistsByEmail(
                UserExistsByEmailRequest.builder().email(email).contextId(ctxId).build());
            assertTrue(found.getExists());
            assertEquals(user.getId().orElseThrow(), found.getUserId().orElse(null));

            var notFound = Smoke.live().identity().userExistsByEmail(UserExistsByEmailRequest.builder()
                .email(Smoke.uniqueTag() + "-nobody@test.com").contextId(ctxId).build());
            assertFalse(notFound.getExists());
        } finally {
            try { Smoke.live().auth().deleteAccessProfile(ctxId, "usr_" + user.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(user.getId().orElseThrow()); } catch (RuntimeException ignored) { }
        }
    }

    // -----------------------------------------------------------------------
    // GET /v1/app-contexts/{contextId}/profiles — batched email resolution
    // -----------------------------------------------------------------------
    // Only the singular getAccessProfile path asserts email resolution elsewhere in this suite.
    // The LIST endpoint resolves email via a separate, batched code path — two distinct
    // users/profiles so a mis-keyed batch (rows swapped, or the whole page resolved from one
    // row's email) would be caught, not just "email is present somewhere".
    @Test
    void listAccessProfilesResolvesEmailPerRow() {
        String emailA = Smoke.uniqueTag() + "-a@test.com";
        String emailB = Smoke.uniqueTag() + "-b@test.com";
        UserResponse userA = Smoke.live().identity().createUser(
            UserRequest.builder().externalId(Smoke.uniqueTag()).email(emailA).build());
        UserResponse userB = Smoke.live().identity().createUser(
            UserRequest.builder().externalId(Smoke.uniqueTag()).email(emailB).build());
        Smoke.live().auth().createAccessProfile(ctxId, AccessProfileRequest.builder()
            .principalId("usr_" + userA.getId().orElseThrow())
            .scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r")).build()))
            .build());
        Smoke.live().auth().createAccessProfile(ctxId, AccessProfileRequest.builder()
            .principalId("usr_" + userB.getId().orElseThrow())
            .scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r")).build()))
            .build());
        try {
            // Root key holds users:r implicitly — email present, and correctly per-row.
            var page = Smoke.live().auth().listAccessProfiles(ctxId,
                ai.vectros.resources.auth.requests.ListAccessProfilesRequest.builder().build());
            var rows = page.getData().orElseThrow();
            String foundEmailA = rows.stream()
                .filter(p -> ("usr_" + userA.getId().orElseThrow()).equals(p.getPrincipalId().orElse(null)))
                .findFirst().flatMap(p -> p.getEmail()).orElse(null);
            String foundEmailB = rows.stream()
                .filter(p -> ("usr_" + userB.getId().orElseThrow()).equals(p.getPrincipalId().orElse(null)))
                .findFirst().flatMap(p -> p.getEmail()).orElse(null);
            assertEquals(emailA, foundEmailA);
            assertEquals(emailB, foundEmailB);

            // A scoped token holding profiles:r but NOT users:r — email must be absent on every row.
            MintTokenResponse minted = Smoke.live().auth().mintToken(TokenRequest.builder()
                .scope(ScopeRequest.builder().allowedActions(List.of("profiles:r")).build())
                .contextId(ctxId).build());
            var scopedPage = Smoke.client(minted.getToken()).auth().listAccessProfiles(ctxId,
                ai.vectros.resources.auth.requests.ListAccessProfilesRequest.builder().build());
            var scopedRows = scopedPage.getData().orElseThrow();
            assertTrue(scopedRows.size() >= 2);
            scopedRows.forEach(p -> assertTrue(p.getEmail().isEmpty(), "expected no email on scoped list row"));
        } finally {
            try { Smoke.live().auth().deleteAccessProfile(ctxId, "usr_" + userA.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().auth().deleteAccessProfile(ctxId, "usr_" + userB.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(userA.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(userB.getId().orElseThrow()); } catch (RuntimeException ignored) { }
        }
    }
}
