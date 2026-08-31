"""
test_capabilities.py -- 0.40.0: `granted_capabilities` on a scope clause (role
or access profile) -- named platform capabilities that reach across a
partition boundary, which `allowed_actions` cannot express. The Python-
language analogue of capabilities.spec.ts (see that file for the full
rationale; this ports one representative positive+negative pair per
capability rather than every edge case TS already covers exhaustively --
the point of this file is proving the cross-language wire contract, not
re-deriving behavior TS already pins).

Every capability-bearing credential here is a real ssk_* scoped key, minted
via an access profile carrying granted_capabilities + create_scoped_key --
NOT mint_token, whose ScopeRequest has no granted_capabilities field at all
(confirmed: capability grants are authored only through a role or access
profile's ScopeClause).

A capability only relaxes WHO an effect may target, never WHAT scope the
resulting credential may carry -- the pre-existing subset-of-caller rule
still applies on top, so every caller below also holds the scope it's about
to confer/read, or a 403 would be ambiguous between the two rules.
"""
from __future__ import annotations

import pytest
import vectros

import support


def _mint_capable_key(root: vectros.VectrosApi, ctx_id: str, user_id: str, allowed_actions, granted_capabilities=None):
    principal_id = f"usr_{user_id}"
    # upsert=True: mirrors capabilities.spec.ts -- create_access_profile is
    # idempotent-by-principal_id, so a later call must upsert or its
    # allowed_actions/granted_capabilities silently never take effect.
    root.auth.create_access_profile(
        ctx_id, principal_id=principal_id, upsert=True,
        scopes=[vectros.ScopeClause(allowed_actions=allowed_actions, granted_capabilities=granted_capabilities)],
    )
    key = root.auth.create_scoped_key(
        key_name="cap-" + support.unique_tag(), tenant_id=support.require_env("VECTROS_LIVE_TENANT_ID"),
        context_id=ctx_id, user_id=user_id,
    )
    assert key.raw_key, "create_scoped_key returned no raw_key"
    return support.make_client(key.raw_key), key.key_id


@pytest.fixture
def ctx(client):
    ctx_id = ("cap" + support.unique_tag())[:31]
    client.auth.create_app_context(context_id=ctx_id, name="capabilities spec (python)")
    yield ctx_id
    support.try_cleanup("context", lambda: client.auth.delete_app_context(ctx_id, confirm=ctx_id))


# -----------------------------------------------------------------------
# The three fail-closed rules
# -----------------------------------------------------------------------

def test_unrecognized_capability_denies_the_whole_clause(client, ctx):
    user = client.identity.create_user(external_id=support.unique_tag())
    try:
        # The clause also grants an ordinary, otherwise-unconditional records:r --
        # if the unrecognized name only denied ITSELF, this read would still work.
        with pytest.raises(vectros.core.api_error.ApiError) as exc:
            _mint_capable_key(client, ctx, user.id, ["records:r"], ["not-a-real-capability"])
        assert support.status_of(exc.value) == 400
    finally:
        support.try_cleanup("profile", lambda: client.auth.delete_access_profile(ctx, f"usr_{user.id}"))
        support.try_cleanup("user", lambda: client.identity.delete_user(user.id))


def test_wildcard_allowed_actions_confers_zero_capabilities(client, ctx):
    # '*' would ordinarily satisfy almost any allowed_actions check; delegate-mint
    # is the cheapest capability to probe (binding a scoped key to a DIFFERENT
    # principal). A '*'-only credential must still be refused it.
    user = client.identity.create_user(external_id=support.unique_tag())
    other = client.identity.create_user(external_id=support.unique_tag())
    client.auth.create_access_profile(
        ctx, principal_id=f"usr_{other.id}", scopes=[vectros.ScopeClause(allowed_actions=["records:r"])],
    )
    try:
        scoped, key_id = _mint_capable_key(client, ctx, user.id, ["*"])
        try:
            with pytest.raises(vectros.core.api_error.ApiError) as exc:
                scoped.auth.create_scoped_key(
                    key_name="wc-" + support.unique_tag(), tenant_id=support.require_env("VECTROS_LIVE_TENANT_ID"),
                    context_id=ctx, user_id=other.id,
                )
            assert support.status_of(exc.value) == 403
        finally:
            support.try_cleanup("probe key", lambda: client.auth.revoke_scoped_key(key_id))
    finally:
        support.try_cleanup("other profile", lambda: client.auth.delete_access_profile(ctx, f"usr_{other.id}"))
        support.try_cleanup("other user", lambda: client.identity.delete_user(other.id))
        support.try_cleanup("user", lambda: client.identity.delete_user(user.id))


# -----------------------------------------------------------------------
# member-lifecycle -- elevates a bare profiles:c grant to also create the
# tenant-wide identity via an invite, not just the in-context profile.
# -----------------------------------------------------------------------

def test_member_lifecycle_gates_invite_creating_a_brand_new_member(client, ctx):
    # Negative: bare profiles:c WITHOUT member-lifecycle cannot invite. records:r
    # matches the invite's own accessProfile scope so the 403 can only be
    # attributed to the missing capability, not the pre-existing subset rule.
    user = client.identity.create_user(external_id=support.unique_tag())
    try:
        scoped, key_id = _mint_capable_key(client, ctx, user.id, ["profiles:c", "records:r"])
        try:
            with pytest.raises(vectros.core.api_error.ApiError) as exc:
                scoped.auth.create_invite(
                    email=f"{support.unique_tag()}@test.com", context_id=ctx, send_email=False,
                    access_profile=vectros.AccessProfileSpec(scopes=[vectros.ScopeClause(allowed_actions=["records:r"])]),
                )
            assert support.status_of(exc.value) == 403
        finally:
            support.try_cleanup("probe key", lambda: client.auth.revoke_scoped_key(key_id))
    finally:
        support.try_cleanup("profile", lambda: client.auth.delete_access_profile(ctx, f"usr_{user.id}"))
        support.try_cleanup("user", lambda: client.identity.delete_user(user.id))


def test_member_lifecycle_permits_invite_creating_a_brand_new_member(client, ctx):
    user = client.identity.create_user(external_id=support.unique_tag())
    try:
        scoped, key_id = _mint_capable_key(client, ctx, user.id, ["profiles:c", "records:r"], ["member-lifecycle"])
        try:
            invite = scoped.auth.create_invite(
                email=f"{support.unique_tag()}@test.com", context_id=ctx, send_email=False,
                access_profile=vectros.AccessProfileSpec(scopes=[vectros.ScopeClause(allowed_actions=["records:r"])]),
            )
            assert invite.user_id
            support.try_cleanup("invited user", lambda: client.identity.delete_user(invite.user_id))
        finally:
            support.try_cleanup("probe key", lambda: client.auth.revoke_scoped_key(key_id))
    finally:
        support.try_cleanup("profile", lambda: client.auth.delete_access_profile(ctx, f"usr_{user.id}"))
        support.try_cleanup("user", lambda: client.identity.delete_user(user.id))


# -----------------------------------------------------------------------
# delegate-mint -- POST /v1/admin/keys/scoped bound to a DIFFERENT principal
# -----------------------------------------------------------------------

def test_delegate_mint_gates_minting_a_key_for_another_principal(client, ctx):
    user = client.identity.create_user(external_id=support.unique_tag())
    other = client.identity.create_user(external_id=support.unique_tag())
    client.auth.create_access_profile(
        ctx, principal_id=f"usr_{other.id}", scopes=[vectros.ScopeClause(allowed_actions=["records:r"])],
    )
    try:
        # Negative: keys:c alone cannot mint bound to a DIFFERENT principal.
        scoped, key_id = _mint_capable_key(client, ctx, user.id, ["keys:c", "records:r"])
        try:
            with pytest.raises(vectros.core.api_error.ApiError) as exc:
                scoped.auth.create_scoped_key(
                    key_name="delegate-" + support.unique_tag(), tenant_id=support.require_env("VECTROS_LIVE_TENANT_ID"),
                    context_id=ctx, user_id=other.id,
                )
            assert support.status_of(exc.value) == 403
        finally:
            support.try_cleanup("probe key", lambda: client.auth.revoke_scoped_key(key_id))

        # Positive: keys:c + delegate-mint CAN. Re-mints against the SAME user
        # rather than a third principal -- create_access_profile(upsert=True)
        # inside _mint_capable_key re-authors the same profile's capabilities.
        scoped2, key_id2 = _mint_capable_key(client, ctx, user.id, ["keys:c", "records:r"], ["delegate-mint"])
        try:
            delegated = scoped2.auth.create_scoped_key(
                key_name="delegate-ok-" + support.unique_tag(), tenant_id=support.require_env("VECTROS_LIVE_TENANT_ID"),
                context_id=ctx, user_id=other.id,
            )
            assert delegated.raw_key and delegated.raw_key.startswith("ssk_")
            support.try_cleanup("delegated key", lambda: client.auth.revoke_scoped_key(delegated.key_id))
        finally:
            support.try_cleanup("probe key 2", lambda: client.auth.revoke_scoped_key(key_id2))
    finally:
        support.try_cleanup("profile", lambda: client.auth.delete_access_profile(ctx, f"usr_{user.id}"))
        support.try_cleanup("user", lambda: client.identity.delete_user(user.id))
        support.try_cleanup("other profile", lambda: client.auth.delete_access_profile(ctx, f"usr_{other.id}"))
        support.try_cleanup("other user", lambda: client.identity.delete_user(other.id))


# -----------------------------------------------------------------------
# forensic-read -- GET /v1/admin/access-log's callerKeyId (tenant-wide,
# cross-context) forensic axis
# -----------------------------------------------------------------------

def test_forensic_read_gates_the_tenant_wide_caller_key_id_axis(client, ctx):
    user = client.identity.create_user(external_id=support.unique_tag())
    try:
        scoped, key_id = _mint_capable_key(client, ctx, user.id, ["access-log:r"])
        try:
            with pytest.raises(vectros.core.api_error.ApiError) as exc:
                scoped.auth.get_access_log(caller_key_id=key_id, limit=5)
            assert support.status_of(exc.value) == 403
        finally:
            support.try_cleanup("probe key", lambda: client.auth.revoke_scoped_key(key_id))

        scoped2, key_id2 = _mint_capable_key(client, ctx, user.id, ["access-log:r"], ["forensic-read"])
        try:
            page = scoped2.auth.get_access_log(caller_key_id=key_id2, limit=5)
            assert isinstance(page.data, list)
        finally:
            support.try_cleanup("probe key 2", lambda: client.auth.revoke_scoped_key(key_id2))
    finally:
        support.try_cleanup("profile", lambda: client.auth.delete_access_profile(ctx, f"usr_{user.id}"))
        support.try_cleanup("user", lambda: client.identity.delete_user(user.id))


# -----------------------------------------------------------------------
# context-directory-read -- GET /v1/principals/{id}/profiles's cross-context
# reach for a principal OTHER than the caller's own
# -----------------------------------------------------------------------

def test_context_directory_read_gates_cross_context_principal_lookup(client, ctx):
    caller = client.identity.create_user(external_id=support.unique_tag())
    ctx_b = ("capb" + support.unique_tag())[:31]
    client.auth.create_app_context(context_id=ctx_b, name="context-directory-read B (python)")
    other = client.identity.create_user(external_id=support.unique_tag())
    client.auth.create_access_profile(ctx, principal_id=f"usr_{other.id}", scopes=[vectros.ScopeClause(allowed_actions=["records:r"])])
    client.auth.create_access_profile(ctx_b, principal_id=f"usr_{other.id}", scopes=[vectros.ScopeClause(allowed_actions=["records:r"])])
    try:
        # Negative: profiles:r alone sees the OWN context only.
        scoped, key_id = _mint_capable_key(client, ctx, caller.id, ["profiles:r"])
        try:
            seen = scoped.auth.list_profiles_for_principal(f"usr_{other.id}")
            seen_contexts = [p.context_id for p in (seen.data or [])]
            assert ctx in seen_contexts
            assert ctx_b not in seen_contexts
        finally:
            support.try_cleanup("probe key", lambda: client.auth.revoke_scoped_key(key_id))

        # Positive: + context-directory-read sees EVERY context.
        scoped2, key_id2 = _mint_capable_key(client, ctx, caller.id, ["profiles:r"], ["context-directory-read"])
        try:
            seen2 = scoped2.auth.list_profiles_for_principal(f"usr_{other.id}")
            seen_contexts2 = [p.context_id for p in (seen2.data or [])]
            assert ctx in seen_contexts2
            assert ctx_b in seen_contexts2
        finally:
            support.try_cleanup("probe key 2", lambda: client.auth.revoke_scoped_key(key_id2))
    finally:
        support.try_cleanup("caller profile", lambda: client.auth.delete_access_profile(ctx, f"usr_{caller.id}"))
        support.try_cleanup("caller user", lambda: client.identity.delete_user(caller.id))
        support.try_cleanup("other profile A", lambda: client.auth.delete_access_profile(ctx, f"usr_{other.id}"))
        support.try_cleanup("other profile B", lambda: client.auth.delete_access_profile(ctx_b, f"usr_{other.id}"))
        support.try_cleanup("other user", lambda: client.identity.delete_user(other.id))
        support.try_cleanup("context B", lambda: client.auth.delete_app_context(ctx_b, confirm=ctx_b))
