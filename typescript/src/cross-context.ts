/**
 * Reusable two-app-context fixture for cross-CONTEXT data-isolation smokes.
 *
 * An app context is a fail-closed data partition within a single tenant: a
 * record/document/folder/schema created while operating in context A must be
 * invisible to a caller operating in context B of the SAME tenant, on every
 * read path. Cross-TENANT isolation is exercised elsewhere (a TEST-tenant key
 * cannot see LIVE-tenant content); this is the cross-CONTEXT analogue, the
 * higher-value seam because both contexts share one tenant — the only thing
 * keeping their data apart is the context partition itself.
 *
 * How a caller is CONFINED to a context over the wire
 * ----------------------------------------------------
 * A root server key operates cross-context (it can see every context's data),
 * so it cannot demonstrate confinement. A scoped server key (`ssk_*`) is bound
 * to an AccessProfile inside ONE context; the platform derives the caller's
 * context from that binding and applies it as a mandatory partition on every
 * finder. So to get a "context-B-confined caller" we:
 *
 *   1. create context B (root key),
 *   2. create a user + an AccessProfile for that user inside context B,
 *   3. mint an `ssk_*` key bound to that profile.
 *
 * The resulting key is a real, confined caller — exactly what you would
 * issue to a per-context workload. {@link provisionTwoContexts} builds two of
 * them (A and B) in one tenant and hands back a confined client for each.
 *
 * The fixture provisions only synthetic data and is self-cleaning. It is
 * deliberately self-contained so the resulting specs read as a standalone
 * proof of tenant/context isolation.
 */
import { VectrosClient } from '@vectros-ai/sdk';
import { client, getScopedClient } from './client';
import { uniqueTag, tryCleanup } from './helpers';

/**
 * The scope granted to each context's confined key. Broad enough to create and
 * read records/documents/folders/schemas and run search WITHIN the context;
 * the context partition — not the scope — is what isolation under test relies
 * on. No `dataScope` is declared, so the key sees all owners inside its own
 * context (and nothing outside it).
 */
const CONTEXT_KEY_SCOPES = [
    {
        allowed_actions: [
            'records:c', 'records:r', 'records:d',
            'documents:c', 'documents:r', 'documents:d',
            'folders:c', 'folders:r', 'folders:d',
            'schemas:c', 'schemas:r', 'schemas:d',
            'search:r',
        ],
    },
];

/** A single provisioned app context plus a client confined to it. */
export interface ContextHandle {
    /** The app-context id (the partition axis under test). */
    contextId: string;
    /** A real user in the tenant; the confined key binds to it. */
    userId: string;
    /** The minted `ssk_*` key's id — used to revoke it on teardown. */
    keyId: string;
    /** A VectrosClient whose every call is confined to {@link contextId}. */
    api: VectrosClient;
}

/** Two sibling contexts (A, B) in one tenant, each with a confined client. */
export interface TwoContextFixture {
    tenantId: string;
    ctxA: ContextHandle;
    ctxB: ContextHandle;
    /** Best-effort teardown: revoke keys, delete users, cascade-delete contexts. */
    teardown: () => Promise<void>;
}

/**
 * A context id valid under the platform's contextId rule
 * (`^[a-z][a-z0-9-]{2,30}$`): starts with a lowercase letter, lowercase
 * alphanumerics + hyphens, <= 31 chars. Purpose-built so it does not depend on
 * uniqueTag()'s incidental format staying within those bounds.
 */
function contextId(label: string): string {
    const rnd = `${Date.now()}${Math.random().toString(36).slice(2)}`.replace(/[^a-z0-9]/g, '');
    return `ctx-${label}-${rnd}`.slice(0, 31);
}

function requireTenantId(): string {
    const t = process.env.VECTROS_LIVE_TENANT_ID;
    if (!t) {
        throw new Error(
            'VECTROS_LIVE_TENANT_ID is required for cross-context isolation specs ' +
            '(the scoped-key mint endpoint needs the tenant the key will operate on). ' +
            'Set it in a .env file for local dev; in CI it is a pipeline variable.'
        );
    }
    return t;
}

/**
 * Tears down whatever a context handle created — revoke key, cascade-delete the
 * context (drains its records/documents/folders/schemas/profiles), delete the
 * (tenant-level) user. Best-effort: never throws.
 */
async function teardownHandle(h: ContextHandle): Promise<void> {
    if (h.keyId) {
        await tryCleanup(`revoke key ${h.keyId}`, () => client.auth.revokeScopedKey({ keyId: h.keyId }));
    }
    if (h.contextId) {
        // Confirm token must equal the contextId.
        await tryCleanup(`delete context ${h.contextId}`, () =>
            client.auth.deleteAppContext({ contextId: h.contextId, confirm: h.contextId }));
    }
    if (h.userId) {
        await tryCleanup(`delete user ${h.userId}`, () => client.identity.deleteUser({ id: h.userId }));
    }
}

/**
 * Provisions one context + a confined `ssk_*` client bound to it. Each created
 * resource is registered on `created` as it is created, so a failure partway
 * through can still be torn down by the caller (no orphaned context/user/key on
 * the shared tenant).
 */
async function provisionContext(tenantId: string, label: string, created: ContextHandle[]): Promise<ContextHandle> {
    const handle: ContextHandle = { contextId: '', userId: '', keyId: '', api: client };
    created.push(handle);

    handle.contextId = contextId(label);
    await client.auth.createAppContext({ body: { contextId: handle.contextId, name: `cross-context ${label}` } });

    // A real user is required: the key binds to an AccessProfile whose
    // principalId is `usr_<userId>` for this exact user.
    const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
    handle.userId = user.id!;

    await client.auth.createAccessProfile({
        contextId: handle.contextId,
        body: { principalId: `usr_${handle.userId}`, scopes: CONTEXT_KEY_SCOPES, status: 'active' },
    });

    const minted = await client.auth.createScopedKey({
        keyName: `cross-context-${label}-${uniqueTag()}`,
        tenantId,
        contextId: handle.contextId,
        userId: handle.userId,
    });
    if (!minted.rawKey) {
        throw new Error(
            `Scoped key for context ${label} returned no rawKey — cannot build a ` +
            `confined client. (rawKey is only returned once, on create.)`
        );
    }
    handle.keyId = minted.keyId!;
    handle.api = getScopedClient(minted.rawKey);
    return handle;
}

/**
 * Provisions TWO sibling contexts (A, B) in one tenant, each with its own
 * confined `ssk_*` client. Caller writes via one client and probes via the
 * other to prove the partition holds. Always pair with `teardown()` in an
 * afterAll. If provisioning fails partway, any already-created resources are
 * torn down before the error propagates — nothing orphans on the shared tenant.
 */
export async function provisionTwoContexts(): Promise<TwoContextFixture> {
    const tenantId = requireTenantId();
    const created: ContextHandle[] = [];
    let ctxA: ContextHandle;
    let ctxB: ContextHandle;
    try {
        ctxA = await provisionContext(tenantId, 'a', created);
        ctxB = await provisionContext(tenantId, 'b', created);
    } catch (err) {
        for (const h of created) await teardownHandle(h);
        throw err;
    }

    const teardown = async (): Promise<void> => {
        for (const h of created) await teardownHandle(h);
    };

    return { tenantId, ctxA, ctxB, teardown };
}
