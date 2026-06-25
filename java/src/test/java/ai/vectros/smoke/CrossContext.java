package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.types.AccessProfileRequest;
import ai.vectros.types.AccessProfileRequestStatus;
import ai.vectros.types.AppContextRequest;
import ai.vectros.types.ScopeClause;
import ai.vectros.types.ScopedKeyResponse;
import ai.vectros.types.UserResponse;
import ai.vectros.resources.auth.requests.CreateAccessProfileRequest;
import ai.vectros.resources.auth.requests.CreateScopedKeyRequest;
import ai.vectros.resources.auth.requests.DeleteAppContextRequest;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Two-app-context isolation fixture. An app context is a fail-closed data
 * partition within ONE tenant: a record/document
 * created while confined to context A must be invisible to a caller confined to
 * context B of the same tenant, on every read path. We provision two contexts,
 * each with a confined ssk_* client, and probe the partition over the real wire.
 */
final class CrossContext {
    private CrossContext() {}

    // Broad enough to create + read + delete within a context; the context
    // partition (not the scope) is what isolation under test relies on.
    static final List<String> ACTIONS = List.of(
        "records:c", "records:r", "records:d",
        "documents:c", "documents:r", "documents:d",
        "folders:c", "folders:r", "folders:d",
        "schemas:c", "schemas:r", "schemas:d",
        "search:r");

    static final class Handle {
        String contextId = "", userId = "", keyId = "";
        VectrosApiClient api;
    }

    static final class Fixture {
        final String tenantId;
        final Handle a, b;
        final List<Handle> created;
        Fixture(String tenantId, Handle a, Handle b, List<Handle> created) {
            this.tenantId = tenantId; this.a = a; this.b = b; this.created = created;
        }
        /** Best-effort teardown: revoke keys, cascade-delete contexts, delete users. */
        void teardown(VectrosApiClient root) {
            for (Handle h : created) {
                if (!h.keyId.isEmpty()) try { root.auth().revokeScopedKey(h.keyId); } catch (Exception ignore) {}
                if (!h.contextId.isEmpty()) try {
                    root.auth().deleteAppContext(h.contextId, DeleteAppContextRequest.builder().confirm(h.contextId).build());
                } catch (Exception ignore) {}
                if (!h.userId.isEmpty()) try { root.identity().deleteUser(h.userId); } catch (Exception ignore) {}
            }
        }
    }

    /** A context id valid under `^[a-z][a-z0-9-]{2,30}$`. */
    private static String contextId(String label) {
        String rnd = (System.currentTimeMillis() + Long.toString(Math.abs(ThreadLocalRandom.current().nextLong()), 36))
            .replaceAll("[^a-z0-9]", "");
        String id = "ctx-" + label + "-" + rnd;
        return id.length() > 31 ? id.substring(0, 31) : id;
    }

    private static Handle provision(VectrosApiClient root, String tenantId, String label, List<Handle> created) {
        Handle h = new Handle();
        h.api = root;
        created.add(h);

        h.contextId = contextId(label);
        root.auth().createAppContext(AppContextRequest.builder().contextId(h.contextId).name("cross-context " + label).build());

        UserResponse user = root.identity().createUser(ai.vectros.types.UserRequest.builder().externalId(Smoke.uniqueTag()).build());
        h.userId = user.getId().orElseThrow();

        root.auth().createAccessProfile(h.contextId, CreateAccessProfileRequest.builder().body(
            AccessProfileRequest.builder()
                .principalId("usr_" + h.userId)
                .scopes(List.of(ScopeClause.builder().allowedActions(ACTIONS).build()))
                .status(AccessProfileRequestStatus.ACTIVE)
                .build()).build());

        ScopedKeyResponse minted = root.auth().createScopedKey(CreateScopedKeyRequest.builder()
            .keyName("cross-context-" + label + "-" + Smoke.uniqueTag())
            .tenantId(tenantId).contextId(h.contextId).userId(h.userId).build());
        String raw = minted.getRawKey().orElseThrow(
            () -> new IllegalStateException("scoped key for context " + label + " returned no rawKey"));
        h.keyId = minted.getKeyId().orElse("");
        h.api = Smoke.client(raw);
        return h;
    }

    /** Two sibling contexts (A, B) in one tenant, each with a confined client. */
    static Fixture provisionTwo(VectrosApiClient root) {
        String tenantId = Smoke.env("VECTROS_LIVE_TENANT_ID");
        List<Handle> created = new ArrayList<>();
        try {
            Handle a = provision(root, tenantId, "a", created);
            Handle b = provision(root, tenantId, "b", created);
            return new Fixture(tenantId, a, b, created);
        } catch (RuntimeException e) {
            new Fixture(tenantId, null, null, created).teardown(root);
            throw e;
        }
    }
}
