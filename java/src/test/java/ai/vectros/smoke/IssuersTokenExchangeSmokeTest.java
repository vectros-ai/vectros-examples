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

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
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
 * standing one up is out of scope here.
 *
 * A successful exchange also needs an ACTIVE registration. One made without
 * {@code restrictedToDomain} starts as {@code pending_verification} and is
 * activated only by {@code POST /v1/auth/issuers/{issuerId}/verify} with a
 * real login token from the IdP, which this suite cannot produce — so
 * everything that needs an active registration (a real 401 from a signature
 * that fails to verify, suspend/reinstate, {@code context_id}
 * disambiguation) is covered by backend unit tests, not here. This covers the
 * issuer-registry CRUD contract, the pending state and its uniform 404 at
 * exchange, every rejection {@code verify} can produce, and every exchange()
 * rejection reachable without an active registration.
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

    // Raw, AUTHENTICATED HTTP for the issuer-registry calls whose newest members the installed
    // SDK build may not model yet (the verify call, the verification* fields, a PUT of `status`).
    // Same bearer key the SDK client uses. POST reuses Smoke.rawPost; PUT has no shared helper.
    private static Smoke.RawResponse rawPut(String path, String body) throws Exception {
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(20)).build();
        HttpRequest req = HttpRequest.newBuilder(URI.create(Smoke.baseUrl() + path))
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer " + Smoke.env("VECTROS_API_KEY"))
            .timeout(Duration.ofSeconds(30))
            .PUT(HttpRequest.BodyPublishers.ofString(body))
            .build();
        HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
        return new Smoke.RawResponse(resp.statusCode(), resp.body());
    }

    /** JSON body for POST .../verify: {"token": "<jwt>"}. */
    private static String verifyBody(String jwt) {
        return MAPPER.createObjectNode().put("token", jwt).toString();
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
    void samePairRegisteredWithoutADomainUnderDifferentContextsYieldsTwoPendingRegistrations() {
        // A registration made without restrictedToDomain does not claim its (issuer, audience)
        // pair when registered — the pair is claimed only once the registration is verified,
        // which this suite cannot do. So pair-uniqueness between two domain-less registrations is
        // not observable here: the same pair under two DIFFERENT contexts registers twice, both
        // pending. (The same pair under the SAME context is still refused, but by the
        // one-active-IdP-per-context rule, which the next test isolates.)
        String otherCtxId = slug("pr2");
        Smoke.live().auth().createAppContext(AppContextRequest.builder().contextId(otherCtxId).name("pair-uniqueness spec 2 (java)").build());
        String issuer = "https://" + Smoke.uniqueTag() + ".example.com/";
        String audience = "aud-" + Smoke.uniqueTag();
        String firstId = slug("pr2a");
        String secondId = slug("pr2b");
        try {
            IssuerResponse first = Smoke.live().auth().registerIssuer(IssuerRequest.builder()
                .issuerId(firstId).issuer(issuer).jwksUri("https://www.googleapis.com/oauth2/v3/certs")
                .audience(audience).contextId(ctxId).build());
            IssuerResponse second = Smoke.live().auth().registerIssuer(IssuerRequest.builder()
                .issuerId(secondId).issuer(issuer).jwksUri("https://www.googleapis.com/oauth2/v3/certs")
                .audience(audience).contextId(otherCtxId).build());
            assertTrue(first.getCreated().orElse(false));
            assertEquals("pending_verification", first.getStatus().orElse(null));
            assertTrue(second.getCreated().orElse(false));
            assertEquals("pending_verification", second.getStatus().orElse(null));
        } finally {
            try { Smoke.live().auth().deleteIssuer(firstId); } catch (RuntimeException ignored) { }
            try { Smoke.live().auth().deleteIssuer(secondId); } catch (RuntimeException ignored) { }
            try { Smoke.live().auth().deleteAppContext(otherCtxId,
                DeleteAppContextRequest.builder().confirm(otherCtxId).build()); } catch (RuntimeException ignored) { }
        }
    }

    @Test
    void secondDistinctIssuerInSameContextRefusedOneActiveIdpPerContext() {
        // A context has exactly one active issuer, and a pending registration already holds its
        // context, so a second registration is refused before the first is ever verified.
        // DIFFERENT (issuer, audience) pair, SAME context.
        String firstId = slug("oneidp1");
        String secondId = slug("oneidp2");
        try {
            Smoke.live().auth().registerIssuer(IssuerRequest.builder()
                .issuerId(firstId).issuer("https://" + Smoke.uniqueTag() + ".example.com/")
                .jwksUri("https://www.googleapis.com/oauth2/v3/certs")
                .audience("aud-" + Smoke.uniqueTag()).contextId(ctxId).build());
            Smoke.expectStatus(() -> Smoke.live().auth().registerIssuer(IssuerRequest.builder()
                .issuerId(secondId).issuer("https://" + Smoke.uniqueTag() + ".example.com/")
                .jwksUri("https://www.googleapis.com/oauth2/v3/certs")
                .audience("aud-" + Smoke.uniqueTag()).contextId(ctxId).build()), 400);
        } finally {
            try { Smoke.live().auth().deleteIssuer(firstId); } catch (RuntimeException ignored) { }
        }
    }

    // Not covered here: the optional context_id disambiguation field (a context_id naming a
    // context the issuer is not registered against -> 404). It is only distinguishable from an
    // unrecognized issuer when the registration is ACTIVE; a pending registration already 404s at
    // exchange whatever context_id is sent. An active registration requires proving control of a
    // real IdP, so that path is covered by backend unit tests rather than this suite.

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

    // A registration made without restrictedToDomain is pending_verification: it carries a
    // verification challenge and accepts no token exchange until it is verified. (The 401 a
    // registered issuer returns for a signature that fails to verify needs an ACTIVE registration,
    // so it is covered by backend unit tests rather than this suite.)
    @Test
    void registrationWithoutDomainIsPendingVerificationWithChallengeAndItsIssAudIs404AtExchange() throws Exception {
        String issuerId = slug("pend");
        String issuer = "https://" + Smoke.uniqueTag() + ".example.com/";
        String audience = "aud-" + Smoke.uniqueTag();
        try {
            // Raw, so the verification* fields are read off the wire whatever the installed SDK
            // build models.
            Smoke.RawResponse r = Smoke.rawPost("/v1/auth/issuers", MAPPER.createObjectNode()
                .put("issuerId", issuerId).put("issuer", issuer)
                .put("jwksUri", "https://www.googleapis.com/oauth2/v3/certs")
                .put("audience", audience).put("contextId", ctxId).toString());
            assertEquals(201, r.status());
            JsonNode body = MAPPER.readTree(r.body());
            assertEquals("pending_verification", body.path("status").asText());
            assertEquals("https://vectros.ai/claims/issuer_challenge", body.path("verificationClaim").asText());
            assertTrue(body.path("verificationNonce").asText().length() > 0);
            assertTrue(body.path("verificationExpiresAt").asText().length() > 0);

            assertEquals("pending_verification", Smoke.live().auth().getIssuer(issuerId).getStatus().orElse(null));

            // Deliberately uniform with the "never registered" 404 (not a 401): a caller cannot
            // tell an unverified registration from an unregistered issuer.
            String jwt = fakeJwt(issuer, audience, "smoke-" + Smoke.uniqueTag());
            Smoke.expectStatus(() -> Smoke.live().auth().exchangeToken(TokenExchangeRequest.builder()
                .grantType(GRANT_TYPE).subjectToken(jwt).subjectTokenType(JWT_TYPE).build()), 404);
        } finally {
            try { Smoke.live().auth().deleteIssuer(issuerId); } catch (RuntimeException ignored) { }
        }
    }

    // A registration still pending verification can be neither activated nor suspended through
    // PUT — activation happens only via verify, and suspending an unverified registration is
    // meaningless. (Suspend/reinstate of an ACTIVE registration is not reachable from this suite:
    // an active registration requires proving control of a real IdP, so that path is covered by
    // backend unit tests.)
    @Test
    void statusCannotBeChangedOnAPendingRegistration() throws Exception {
        String issuerId = slug("pendput");
        Smoke.live().auth().registerIssuer(IssuerRequest.builder()
            .issuerId(issuerId).issuer("https://" + Smoke.uniqueTag() + ".example.com/")
            .jwksUri("https://www.googleapis.com/oauth2/v3/certs")
            .audience("aud-" + Smoke.uniqueTag()).contextId(ctxId).build());
        try {
            assertEquals("pending_verification", Smoke.live().auth().getIssuer(issuerId).getStatus().orElse(null));

            assertEquals(400, rawPut("/v1/auth/issuers/" + issuerId, "{\"status\":\"active\"}").status());
            assertEquals(400, rawPut("/v1/auth/issuers/" + issuerId, "{\"status\":\"suspended\"}").status());

            // Unchanged after both rejected attempts.
            assertEquals("pending_verification", Smoke.live().auth().getIssuer(issuerId).getStatus().orElse(null));
        } finally {
            try { Smoke.live().auth().deleteIssuer(issuerId); } catch (RuntimeException ignored) { }
        }
    }

    // verify against Google's real, stable, publicly-reachable OpenID configuration, so the
    // server-side discovery fetch genuinely succeeds — the refusals are the verification checks
    // themselves, not "couldn't reach the IdP at all".
    @Test
    void verifyWithATokenWhoseSignatureCannotVerifyIs400AndTheRegistrationStaysPending() throws Exception {
        String issuerId = slug("vfybad");
        String issuer = "https://accounts.google.com";
        String audience = "aud-" + Smoke.uniqueTag();
        Smoke.live().auth().registerIssuer(IssuerRequest.builder()
            .issuerId(issuerId).issuer(issuer).jwksUri("https://www.googleapis.com/oauth2/v3/certs")
            .audience(audience).contextId(ctxId).build());
        try {
            Smoke.RawResponse r = Smoke.rawPost("/v1/auth/issuers/" + issuerId + "/verify",
                verifyBody(fakeJwt(issuer, audience, "smoke-" + Smoke.uniqueTag())));
            assertEquals(400, r.status());
            // The refusal must come from the SIGNATURE check, not from failing to reach the issuer's discovery
            // document: both are a 400, and only the first shows verification can work at all.
            assertTrue(r.body().contains("could not be verified against the issuer"), r.body());
            assertFalse(r.body().contains("could not be fetched"), r.body());
            assertEquals("pending_verification", Smoke.live().auth().getIssuer(issuerId).getStatus().orElse(null));
        } finally {
            try { Smoke.live().auth().deleteIssuer(issuerId); } catch (RuntimeException ignored) { }
        }
    }

    // verify trusts the keys the issuer PUBLISHES, not the ones the registration names: the
    // registered jwksUri must equal the jwks_uri in the issuer's own OpenID configuration, or a
    // registrant could point verification at keys of their own.
    @Test
    void verifyWhenJwksUriDiffersFromThePublishedOneIs400NamingThePublishedOne() throws Exception {
        String issuerId = slug("vfyjwks");
        String issuer = "https://accounts.google.com";
        String audience = "aud-" + Smoke.uniqueTag();
        Smoke.live().auth().registerIssuer(IssuerRequest.builder()
            .issuerId(issuerId).issuer(issuer).jwksUri("https://www.googleapis.com/oauth2/v1/certs")
            .audience(audience).contextId(ctxId).build());
        try {
            Smoke.RawResponse r = Smoke.rawPost("/v1/auth/issuers/" + issuerId + "/verify",
                verifyBody(fakeJwt(issuer, audience, "smoke-" + Smoke.uniqueTag())));
            assertEquals(400, r.status());
            assertTrue(r.body().contains("https://www.googleapis.com/oauth2/v3/certs"),
                "expected the published jwks_uri in: " + r.body());
        } finally {
            try { Smoke.live().auth().deleteIssuer(issuerId); } catch (RuntimeException ignored) { }
        }
    }

    @Test
    void verifyOnANeverRegisteredIssuerIdIs404() throws Exception {
        Smoke.RawResponse r = Smoke.rawPost("/v1/auth/issuers/" + slug("nosuch") + "/verify",
            verifyBody(fakeJwt("https://accounts.google.com", "aud-" + Smoke.uniqueTag(), "smoke-" + Smoke.uniqueTag())));
        assertEquals(404, r.status());
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

    // The 401 (a registered issuer whose token signature fails) has no reachable path from this
    // suite: it needs an ACTIVE registration, and activating one requires proving control of a
    // real IdP, so that envelope is covered by backend unit tests. A registration still pending
    // verification is the closest reachable case — it answers with the same uniform 404 as an
    // unregistered issuer, and must carry the same OAuth envelope.
    @Test
    void exchangePendingRegistration404UsesOAuthEnvelopeNotMessage() throws Exception {
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
            assertEquals(404, r.status());
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
