"""
test_access_profiles.py -- 0.40.0: the profiles:c/u/d principal-qualifier
axis (literal usr_<id> or the `self` sentinel). The Python-language analogue
of the "profiles:c/u/d qualifier" describe block in access-profiles.spec.ts.
Ports the core positive (`profiles:u:self`) and negative (an unqualifiable
resource rejected at authoring time) pair -- proving the cross-language wire
contract, not every literal/qualifier combination TS already covers.
"""
from __future__ import annotations

import pytest
import vectros

import support


def _real_principal(client):
    user = client.identity.create_user(external_id=support.unique_tag())
    return f"usr_{user.id}", user.id


@pytest.fixture
def ctx(client):
    ctx_id = support.unique_tag()[:31]
    client.auth.create_app_context(context_id=ctx_id, name="access-profiles spec parent (python)")
    yield ctx_id
    support.try_cleanup("context", lambda: client.auth.delete_app_context(ctx_id, confirm=ctx_id))


def test_profiles_u_self_updates_own_profile_but_not_anothers(client, ctx):
    own_principal, own_user_id = _real_principal(client)
    other_principal, other_user_id = _real_principal(client)
    client.auth.create_access_profile(ctx, principal_id=own_principal, scopes=[vectros.ScopeClause(allowed_actions=["records:r"])])
    client.auth.create_access_profile(ctx, principal_id=other_principal, scopes=[vectros.ScopeClause(allowed_actions=["records:r"])])
    try:
        # Superset-of-caller: the minted scope also carries records:r/search:r,
        # the actions this test writes. scope.identity.userId (distinct from the
        # top-level mint user_id) is what `self` resolves against.
        minted = client.auth.mint_token(
            user_id=own_user_id, context_id=ctx,
            scope=vectros.ScopeRequest(
                allowed_actions=["profiles:u:self", "records:r", "search:r"],
                identity={"userId": own_user_id},
            ),
        )
        scoped = support.make_client(minted.token)

        updated = scoped.auth.update_access_profile(
            ctx, own_principal, principal_id=own_principal,
            scopes=[vectros.ScopeClause(allowed_actions=["records:r", "search:r"])],
        )
        assert "search:r" in (updated.scopes[0].allowed_actions or [])

        with pytest.raises(vectros.core.api_error.ApiError) as exc:
            scoped.auth.update_access_profile(
                ctx, other_principal, principal_id=other_principal,
                scopes=[vectros.ScopeClause(allowed_actions=["search:r"])],
            )
        assert support.status_of(exc.value) == 403
    finally:
        support.try_cleanup("own profile", lambda: client.auth.delete_access_profile(ctx, own_principal))
        support.try_cleanup("other profile", lambda: client.auth.delete_access_profile(ctx, other_principal))
        support.try_cleanup("own user", lambda: client.identity.delete_user(own_user_id))
        support.try_cleanup("other user", lambda: client.identity.delete_user(other_user_id))


def test_profiles_r_does_not_accept_a_qualifier(client, ctx):
    principal_id, user_id = _real_principal(client)
    try:
        with pytest.raises(vectros.core.api_error.ApiError) as exc:
            client.auth.create_access_profile(
                ctx, principal_id=principal_id, scopes=[vectros.ScopeClause(allowed_actions=["profiles:r:self"])],
            )
        assert support.status_of(exc.value) == 400
    finally:
        support.try_cleanup("user", lambda: client.identity.delete_user(user_id))
