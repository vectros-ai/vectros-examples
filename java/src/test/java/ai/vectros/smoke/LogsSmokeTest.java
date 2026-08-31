package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.resources.auth.requests.CreateScopedKeyRequest;
import ai.vectros.resources.auth.requests.DeleteAppContextRequest;
import ai.vectros.resources.auth.requests.GetAdminLogsRequest;
import ai.vectros.types.AccessProfileRequest;
import ai.vectros.types.AdminLogsResponse;
import ai.vectros.types.AppContextRequest;
import ai.vectros.types.ScopeClause;
import ai.vectros.types.ScopedKeyResponse;
import ai.vectros.types.UserRequest;
import ai.vectros.types.UserResponse;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import static org.junit.jupiter.api.Assertions.*;

/**
 * 0.40.0: {@code delegationChain} on GET /v1/admin/logs entries -- present on
 * traffic from a delegate-minted key, null on ordinary traffic. The
 * Java-language analogue of the single {@code delegationChain} test in
 * logs.spec.ts (the rest of that file's filter/pagination coverage is not
 * ported here -- this file exists specifically to close the 0.40.0
 * Java-parity gap for the delegationChain field).
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class LogsSmokeTest {

    private static final long POLL_DEADLINE_MS = 90_000;

    private static AdminLogsResponse pollLogs(String keyId) {
        long deadline = System.currentTimeMillis() + POLL_DEADLINE_MS;
        AdminLogsResponse last = null;
        while (System.currentTimeMillis() < deadline) {
            String windowStart = Instant.now().minus(1, ChronoUnit.HOURS).toString();
            last = Smoke.live().auth().getAdminLogs(GetAdminLogsRequest.builder()
                .startTime(windowStart).keyId(keyId).limit(20).build());
            if (!last.getEntries().isEmpty()) return last;
            Smoke.sleep(3000);
        }
        throw new AssertionError("no log entries for key " + keyId + " within " + POLL_DEADLINE_MS + "ms");
    }

    @Test
    void delegationChainPresentOnDelegatedTrafficNullOnOrdinary() {
        String ctx = Smoke.slug("dchainjv");
        Smoke.live().auth().createAppContext(AppContextRequest.builder().contextId(ctx).name("delegationChain spec (java)").build());
        UserResponse delegator = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        UserResponse target = Smoke.live().identity().createUser(UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        String delegatedKeyId = null;
        String delegatorKeyId = null;
        try {
            // delegate-mint only relaxes WHO the credential may be bound to -- the
            // delegator must independently hold a scope that's a superset of the
            // target profile's own scope (records:r below).
            Smoke.live().auth().createAccessProfile(ctx, AccessProfileRequest.builder()
                .principalId("usr_" + delegator.getId().orElseThrow())
                .scopes(List.of(ScopeClause.builder().allowedActions(List.of("keys:c", "records:r"))
                    .grantedCapabilities(List.of("delegate-mint")).build()))
                .build());
            Smoke.live().auth().createAccessProfile(ctx, AccessProfileRequest.builder()
                .principalId("usr_" + target.getId().orElseThrow())
                .scopes(List.of(ScopeClause.builder().allowedActions(List.of("records:r")).build()))
                .build());

            ScopedKeyResponse delegatorKey = Smoke.live().auth().createScopedKey(CreateScopedKeyRequest.builder()
                .keyName("delegator-java-" + Smoke.uniqueTag()).tenantId(Smoke.env("VECTROS_LIVE_TENANT_ID"))
                .contextId(ctx).userId(delegator.getId().orElseThrow()).build());
            delegatorKeyId = delegatorKey.getKeyId().orElseThrow();
            VectrosApiClient delegatorClient = Smoke.client(delegatorKey.getRawKey().orElseThrow());

            ScopedKeyResponse delegated = delegatorClient.auth().createScopedKey(CreateScopedKeyRequest.builder()
                .keyName("delegated-java-" + Smoke.uniqueTag()).tenantId(Smoke.env("VECTROS_LIVE_TENANT_ID"))
                .contextId(ctx).userId(target.getId().orElseThrow()).build());
            delegatedKeyId = delegated.getKeyId().orElseThrow();
            VectrosApiClient delegatedClient = Smoke.client(delegated.getRawKey().orElseThrow());
            delegatedClient.auth().ping();

            AdminLogsResponse response = pollLogs(delegatedKeyId);
            assertTrue(response.getEntries().stream().anyMatch(e -> e.getDelegationChain().isPresent()));

            // Ordinary comparator: the root credential's own traffic -- unambiguously
            // chain-free (a self-bound delegator mint would itself carry a chain).
            String rootKeyId = Smoke.live().auth().ping().getPrincipalKeyId();
            assertNotNull(rootKeyId);
            AdminLogsResponse ordinary = pollLogs(rootKeyId);
            assertFalse(ordinary.getEntries().stream().anyMatch(e -> e.getDelegationChain().isPresent()));
        } finally {
            if (delegatedKeyId != null) {
                final String id = delegatedKeyId;
                try { Smoke.live().auth().revokeScopedKey(id); } catch (RuntimeException ignored) { }
            }
            if (delegatorKeyId != null) {
                final String id = delegatorKeyId;
                try { Smoke.live().auth().revokeScopedKey(id); } catch (RuntimeException ignored) { }
            }
            try { Smoke.live().auth().deleteAccessProfile(ctx, "usr_" + delegator.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().auth().deleteAccessProfile(ctx, "usr_" + target.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(delegator.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().identity().deleteUser(target.getId().orElseThrow()); } catch (RuntimeException ignored) { }
            try { Smoke.live().auth().deleteAppContext(ctx, DeleteAppContextRequest.builder().confirm(ctx).build()); } catch (RuntimeException ignored) { }
        }
    }
}
