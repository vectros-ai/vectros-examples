package ai.vectros.smoke;

import ai.vectros.resources.auth.requests.TokenRequest;
import ai.vectros.resources.auth.requests.UpdateAccessProfileRequest;
import ai.vectros.types.AccessProfileRequest;
import ai.vectros.types.AccessProfileResponse;
import ai.vectros.types.AppContextRequest;
import ai.vectros.types.MintTokenResponse;
import ai.vectros.types.ScopeClause;
import ai.vectros.types.ScopeRequest;
import ai.vectros.types.UserRequest;
import ai.vectros.types.UserResponse;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import static org.junit.jupiter.api.Assertions.*;

/**
 * 0.40.0: the profiles:c/u/d principal-qualifier axis (literal usr_&lt;id&gt;
 * or the {@code self} sentinel). The Java-language analogue of the
 * "profiles:c/u/d qualifier" describe block in access-profiles.spec.ts.
 * Ports the core positive ({@code profiles:u:self}) and negative (an
 * unqualifiable resource rejected at authoring time) pair.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AccessProfilesSmokeTest {

    private String ctxId;

    @BeforeAll
    void setUp() {
        ctxId = Smoke.slug("ap");
        Smoke.live().auth().createAppContext(AppContextRequest.builder().contextId(ctxId).name("access-profiles spec parent (java)").build());
    }

    @AfterAll
    void tearDown() {
        try { Smoke.live().auth().deleteAppContext(ctxId,
            ai.vectros.resources.auth.requests.DeleteAppContextRequest.builder().confirm(ctxId).build());
        } catch (RuntimeException ignored) { }
    }

    private record RealPrincipal(String principalId, String userId) {}

    private static RealPrincipal realPrincipal() {
        UserResponse user = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        String userId = user.getId().orElseThrow();
        return new RealPrincipal("usr_" + userId, userId);
    }

    @Test
    void profilesUSelfUpdatesOwnProfileButNotAnothers() {
        RealPrincipal own = realPrincipal();
        RealPrincipal other = realPrincipal();
        Smoke.live().auth().createAccessProfile(ctxId, AccessProfileRequest.builder()
            .principalId(own.principalId()).scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r")).build())).build());
        Smoke.live().auth().createAccessProfile(ctxId, AccessProfileRequest.builder()
            .principalId(other.principalId()).scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r")).build())).build());
        try {
            // Superset-of-caller: the minted scope also carries records:r/search:r,
            // the actions this test writes. scope.identity.userId (distinct from the
            // top-level mint userId) is what `self` resolves against.
            MintTokenResponse minted = Smoke.live().auth().mintToken(TokenRequest.builder()
                .scope(ScopeRequest.builder()
                    .allowedActions(List.of("profiles:u:self", "records:r", "search:r"))
                    .identity(Map.of("userId", own.userId()))
                    .build())
                .userId(own.userId()).contextId(ctxId)
                .build());
            var scoped = Smoke.client(minted.getToken());

            AccessProfileResponse updated = scoped.auth().updateAccessProfile(ctxId, own.principalId(),
                UpdateAccessProfileRequest.builder().body(AccessProfileRequest.builder()
                    .principalId(own.principalId())
                    .scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r", "search:r")).build()))
                    .build()).build());
            assertTrue(updated.getScopes().orElseThrow().get(0).getAllowedActions().contains("search:r"));

            Smoke.expectStatus(() -> scoped.auth().updateAccessProfile(ctxId, other.principalId(),
                UpdateAccessProfileRequest.builder().body(AccessProfileRequest.builder()
                    .principalId(other.principalId())
                    .scopes(List.of(ScopeClause.builder().allowedActions(List.of("search:r")).build()))
                    .build()).build()), 403);
        } finally {
            try { Smoke.live().auth().deleteAccessProfile(ctxId, own.principalId()); } catch (RuntimeException ignored) { }
            try { Smoke.live().auth().deleteAccessProfile(ctxId, other.principalId()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(own.userId()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(other.userId()); } catch (RuntimeException ignored) { }
        }
    }

    @Test
    void profilesRDoesNotAcceptAQualifier() {
        RealPrincipal p = realPrincipal();
        try {
            Smoke.expectStatus(() -> Smoke.live().auth().createAccessProfile(ctxId, AccessProfileRequest.builder()
                .principalId(p.principalId()).scopes(List.of(ScopeClause.builder().allowedActions(List.of("profiles:r:self")).build()))
                .build()), 400);
        } finally {
            try { Smoke.live().identity().deleteUser(p.userId()); } catch (RuntimeException ignored) { }
        }
    }
}
