package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.resources.auth.requests.CreateAccessProfileRequest;
import ai.vectros.resources.auth.requests.CreateScopedKeyRequest;
import ai.vectros.resources.auth.requests.GetAccessLogRequest;
import ai.vectros.resources.auth.requests.ListProfilesForPrincipalRequest;
import ai.vectros.types.AccessProfileRequest;
import ai.vectros.types.AccessProfileSpec;
import ai.vectros.types.AppContextRequest;
import ai.vectros.types.CreateInviteRequest;
import ai.vectros.types.CreateInviteResponse;
import ai.vectros.types.ReadAccessLogPage;
import ai.vectros.types.ScopeClause;
import ai.vectros.types.ScopedKeyResponse;
import ai.vectros.types.UserRequest;
import ai.vectros.types.UserResponse;

import java.util.List;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import static org.junit.jupiter.api.Assertions.*;

/**
 * 0.40.0: {@code granted_capabilities} on a scope clause (role or access
 * profile) — named platform capabilities that reach across a partition
 * boundary, which {@code allowed_actions} cannot express. The Java-language
 * analogue of {@code capabilities.spec.ts} (see that file for the full
 * rationale; this ports one representative positive+negative pair per
 * capability rather than every edge case TS already covers exhaustively —
 * the point of this file is proving the cross-language wire contract).
 *
 * <p>Every capability-bearing credential here is a real ssk_* scoped key,
 * minted via an access profile carrying grantedCapabilities + createScopedKey
 * — NOT mintToken, whose ScopeRequest has no grantedCapabilities field at
 * all. A capability only relaxes WHO an effect may target, never WHAT scope
 * the resulting credential may carry — the pre-existing subset-of-caller
 * rule still applies on top, so every caller below also holds the scope it's
 * about to confer/read.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class CapabilitiesSmokeTest {

    private String ctxId;

    @BeforeEach
    void setUp() {
        ctxId = Smoke.slug("cap");
        Smoke.live().auth().createAppContext(
            AppContextRequest.builder().contextId(ctxId).name("capabilities spec (java)").build());
    }

    @AfterEach
    void tearDown() {
        try { Smoke.live().auth().deleteAppContext(ctxId,
            ai.vectros.resources.auth.requests.DeleteAppContextRequest.builder().confirm(ctxId).build());
        } catch (RuntimeException ignored) { }
    }

    private record CapableKey(VectrosApiClient scoped, String keyId) {}

    private static CapableKey mintCapableKey(
        String ctxId, String userId, List<String> allowedActions, List<String> grantedCapabilities
    ) {
        String principalId = "usr_" + userId;
        ScopeClause.Builder clause = ScopeClause.builder().allowedActions(allowedActions);
        if (grantedCapabilities != null) clause.grantedCapabilities(grantedCapabilities);
        // upsert=true: create_access_profile is idempotent-by-principalId, so a
        // later call in the same test must upsert or its allowedActions/
        // grantedCapabilities silently never take effect.
        Smoke.live().auth().createAccessProfile(ctxId, CreateAccessProfileRequest.builder()
            .body(AccessProfileRequest.builder().principalId(principalId).scopes(List.of(clause.build())).build())
            .upsert(true).build());
        ScopedKeyResponse key = Smoke.live().auth().createScopedKey(CreateScopedKeyRequest.builder()
            .keyName("cap-" + Smoke.uniqueTag()).tenantId(Smoke.env("VECTROS_LIVE_TENANT_ID"))
            .contextId(ctxId).userId(userId).build());
        String rawKey = key.getRawKey().orElseThrow();
        return new CapableKey(Smoke.client(rawKey), key.getKeyId().orElseThrow());
    }

    // -----------------------------------------------------------------------
    // The three fail-closed rules
    // -----------------------------------------------------------------------

    @Test
    void unrecognizedCapabilityDeniesTheWholeClause() {
        UserResponse user = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        try {
            // The clause also grants an ordinary, otherwise-unconditional records:r --
            // if the unrecognized name only denied ITSELF, this read would still work.
            Smoke.expectStatus(() -> mintCapableKey(
                ctxId, user.getId().orElseThrow(), List.of("records:r"), List.of("not-a-real-capability")), 400);
        } finally {
            try { Smoke.live().auth().deleteAccessProfile(ctxId, "usr_" + user.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(user.getId().orElseThrow()); } catch (RuntimeException ignored) { }
        }
    }

    @Test
    void wildcardAllowedActionsConfersZeroCapabilities() {
        // '*' would ordinarily satisfy almost any allowed_actions check; delegate-mint
        // is the cheapest capability to probe (binding a scoped key to a DIFFERENT
        // principal). A '*'-only credential must still be refused it.
        UserResponse user = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        UserResponse other = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        Smoke.live().auth().createAccessProfile(ctxId, AccessProfileRequest.builder()
            .principalId("usr_" + other.getId().orElseThrow())
            .scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r")).build())).build());
        try {
            CapableKey cap = mintCapableKey(ctxId, user.getId().orElseThrow(), List.of("*"), null);
            try {
                Smoke.expectStatus(() -> cap.scoped().auth().createScopedKey(CreateScopedKeyRequest.builder()
                    .keyName("wc-" + Smoke.uniqueTag()).tenantId(Smoke.env("VECTROS_LIVE_TENANT_ID"))
                    .contextId(ctxId).userId(other.getId().orElseThrow()).build()), 403);
            } finally {
                try { Smoke.live().auth().revokeScopedKey(cap.keyId()); } catch (RuntimeException ignored) { }
            }
        } finally {
            try { Smoke.live().auth().deleteAccessProfile(ctxId, "usr_" + other.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(other.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(user.getId().orElseThrow()); } catch (RuntimeException ignored) { }
        }
    }

    // -----------------------------------------------------------------------
    // member-lifecycle
    // -----------------------------------------------------------------------

    @Test
    void memberLifecycleGatesInviteCreatingABrandNewMember() {
        UserResponse user = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        try {
            // Negative: bare profiles:c WITHOUT member-lifecycle cannot invite. records:r
            // matches the invite's own accessProfile scope so the 403 is attributable
            // only to the missing capability.
            CapableKey neg = mintCapableKey(ctxId, user.getId().orElseThrow(), List.of("profiles:c", "records:r"), null);
            try {
                Smoke.expectStatus(() -> neg.scoped().auth().createInvite(CreateInviteRequest.builder()
                    .email(Smoke.uniqueTag() + "@test.com").contextId(ctxId)
                    .accessProfile(AccessProfileSpec.builder()
                        .scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r")).build())).build())
                    .sendEmail(false).build()), 403);
            } finally {
                try { Smoke.live().auth().revokeScopedKey(neg.keyId()); } catch (RuntimeException ignored) { }
            }

            // Positive: + member-lifecycle CAN.
            CapableKey pos = mintCapableKey(ctxId, user.getId().orElseThrow(), List.of("profiles:c", "records:r"), List.of("member-lifecycle"));
            try {
                CreateInviteResponse invite = pos.scoped().auth().createInvite(CreateInviteRequest.builder()
                    .email(Smoke.uniqueTag() + "@test.com").contextId(ctxId)
                    .accessProfile(AccessProfileSpec.builder()
                        .scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r")).build())).build())
                    .sendEmail(false).build());
                assertTrue(invite.getUserId().isPresent());
                try { Smoke.live().identity().deleteUser(invite.getUserId().orElseThrow()); } catch (RuntimeException ignored) { }
            } finally {
                try { Smoke.live().auth().revokeScopedKey(pos.keyId()); } catch (RuntimeException ignored) { }
            }
        } finally {
            try { Smoke.live().auth().deleteAccessProfile(ctxId, "usr_" + user.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(user.getId().orElseThrow()); } catch (RuntimeException ignored) { }
        }
    }

    // -----------------------------------------------------------------------
    // delegate-mint
    // -----------------------------------------------------------------------

    @Test
    void delegateMintGatesMintingAKeyForAnotherPrincipal() {
        UserResponse user = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        UserResponse other = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        Smoke.live().auth().createAccessProfile(ctxId, AccessProfileRequest.builder()
            .principalId("usr_" + other.getId().orElseThrow())
            .scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r")).build())).build());
        try {
            CapableKey neg = mintCapableKey(ctxId, user.getId().orElseThrow(), List.of("keys:c", "records:r"), null);
            try {
                Smoke.expectStatus(() -> neg.scoped().auth().createScopedKey(CreateScopedKeyRequest.builder()
                    .keyName("delegate-" + Smoke.uniqueTag()).tenantId(Smoke.env("VECTROS_LIVE_TENANT_ID"))
                    .contextId(ctxId).userId(other.getId().orElseThrow()).build()), 403);
            } finally {
                try { Smoke.live().auth().revokeScopedKey(neg.keyId()); } catch (RuntimeException ignored) { }
            }

            CapableKey pos = mintCapableKey(ctxId, user.getId().orElseThrow(), List.of("keys:c", "records:r"), List.of("delegate-mint"));
            try {
                ScopedKeyResponse delegated = pos.scoped().auth().createScopedKey(CreateScopedKeyRequest.builder()
                    .keyName("delegate-ok-" + Smoke.uniqueTag()).tenantId(Smoke.env("VECTROS_LIVE_TENANT_ID"))
                    .contextId(ctxId).userId(other.getId().orElseThrow()).build());
                assertTrue(delegated.getRawKey().orElseThrow().startsWith("ssk_"));
                try { Smoke.live().auth().revokeScopedKey(delegated.getKeyId().orElseThrow()); } catch (RuntimeException ignored) { }
            } finally {
                try { Smoke.live().auth().revokeScopedKey(pos.keyId()); } catch (RuntimeException ignored) { }
            }
        } finally {
            try { Smoke.live().auth().deleteAccessProfile(ctxId, "usr_" + other.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(other.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(user.getId().orElseThrow()); } catch (RuntimeException ignored) { }
        }
    }

    // -----------------------------------------------------------------------
    // forensic-read
    // -----------------------------------------------------------------------

    @Test
    void forensicReadGatesTheTenantWideCallerKeyIdAxis() {
        UserResponse user = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        try {
            CapableKey neg = mintCapableKey(ctxId, user.getId().orElseThrow(), List.of("access-log:r"), null);
            try {
                Smoke.expectStatus(() -> neg.scoped().auth().getAccessLog(
                    GetAccessLogRequest.builder().callerKeyId(neg.keyId()).limit(5).build()), 403);
            } finally {
                try { Smoke.live().auth().revokeScopedKey(neg.keyId()); } catch (RuntimeException ignored) { }
            }

            CapableKey pos = mintCapableKey(ctxId, user.getId().orElseThrow(), List.of("access-log:r"), List.of("forensic-read"));
            try {
                ReadAccessLogPage page = pos.scoped().auth().getAccessLog(
                    GetAccessLogRequest.builder().callerKeyId(pos.keyId()).limit(5).build());
                assertNotNull(page.getData());
            } finally {
                try { Smoke.live().auth().revokeScopedKey(pos.keyId()); } catch (RuntimeException ignored) { }
            }
        } finally {
            try { Smoke.live().identity().deleteUser(user.getId().orElseThrow()); } catch (RuntimeException ignored) { }
        }
    }

    // -----------------------------------------------------------------------
    // context-directory-read
    // -----------------------------------------------------------------------

    @Test
    void contextDirectoryReadGatesCrossContextPrincipalLookup() {
        UserResponse caller = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        String ctxB = Smoke.slug("capb");
        Smoke.live().auth().createAppContext(AppContextRequest.builder().contextId(ctxB).name("context-directory-read B (java)").build());
        UserResponse other = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        Smoke.live().auth().createAccessProfile(ctxId, AccessProfileRequest.builder()
            .principalId("usr_" + other.getId().orElseThrow())
            .scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r")).build())).build());
        Smoke.live().auth().createAccessProfile(ctxB, AccessProfileRequest.builder()
            .principalId("usr_" + other.getId().orElseThrow())
            .scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r")).build())).build());
        try {
            CapableKey neg = mintCapableKey(ctxId, caller.getId().orElseThrow(), List.of("profiles:r"), null);
            try {
                var seen = neg.scoped().auth().listProfilesForPrincipal("usr_" + other.getId().orElseThrow(),
                    ListProfilesForPrincipalRequest.builder().build());
                var seenContexts = seen.getData().orElseThrow().stream().map(p -> p.getContextId().orElse(null)).toList();
                assertTrue(seenContexts.contains(ctxId));
                assertFalse(seenContexts.contains(ctxB));
            } finally {
                try { Smoke.live().auth().revokeScopedKey(neg.keyId()); } catch (RuntimeException ignored) { }
            }

            CapableKey pos = mintCapableKey(ctxId, caller.getId().orElseThrow(), List.of("profiles:r"), List.of("context-directory-read"));
            try {
                var seen = pos.scoped().auth().listProfilesForPrincipal("usr_" + other.getId().orElseThrow(),
                    ListProfilesForPrincipalRequest.builder().build());
                var seenContexts = seen.getData().orElseThrow().stream().map(p -> p.getContextId().orElse(null)).toList();
                assertTrue(seenContexts.contains(ctxId));
                assertTrue(seenContexts.contains(ctxB));
            } finally {
                try { Smoke.live().auth().revokeScopedKey(pos.keyId()); } catch (RuntimeException ignored) { }
            }
        } finally {
            try { Smoke.live().auth().deleteAccessProfile(ctxId, "usr_" + caller.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(caller.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().auth().deleteAccessProfile(ctxId, "usr_" + other.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().auth().deleteAccessProfile(ctxB, "usr_" + other.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(other.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().auth().deleteAppContext(ctxB,
                ai.vectros.resources.auth.requests.DeleteAppContextRequest.builder().confirm(ctxB).build()); } catch (RuntimeException ignored) { }
        }
    }
}
