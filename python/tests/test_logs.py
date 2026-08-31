"""
test_logs.py -- 0.40.0: `delegationChain` on GET /v1/admin/logs entries --
present on traffic from a delegate-minted key, null on ordinary traffic. The
Python-language analogue of the single `delegationChain` test in
logs.spec.ts (the rest of that file's filter/pagination coverage is not
ported here -- this file exists specifically to close the 0.40.0
Python-parity gap for the delegationChain field, not to duplicate the full
admin-logs suite).
"""
from __future__ import annotations

import time

import vectros

import support

POLL_DEADLINE_S = 90.0


def _poll_logs(client, key_id: str):
    """Poll GET /v1/admin/logs for `key_id` until at least one entry appears,
    or the deadline elapses. Ingestion has a short (~5-60s) lag."""
    deadline = time.time() + POLL_DEADLINE_S
    last = None
    while time.time() < deadline:
        window_start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 3600))
        last = client.auth.get_admin_logs(start_time=window_start, key_id=key_id, limit=20)
        if last.entries:
            return last
        time.sleep(3.0)
    raise AssertionError(f"no log entries for key {key_id} within {POLL_DEADLINE_S}s")


def test_delegation_chain_present_on_delegated_traffic_null_on_ordinary(client):
    ctx = ("dchainpy" + support.unique_tag())[:31]
    client.auth.create_app_context(context_id=ctx, name="delegationChain spec (python)")
    delegator = client.identity.create_user(external_id=support.unique_tag())
    target = client.identity.create_user(external_id=support.unique_tag())
    delegated_key_id = None
    delegator_key_id = None
    try:
        # delegate-mint only relaxes WHO the credential may be bound to -- the
        # delegator must independently hold a scope that's a superset of the
        # target profile's own scope (records:r below).
        client.auth.create_access_profile(
            ctx, principal_id=f"usr_{delegator.id}",
            scopes=[vectros.ScopeClause(allowed_actions=["keys:c", "records:r"], granted_capabilities=["delegate-mint"])],
        )
        client.auth.create_access_profile(
            ctx, principal_id=f"usr_{target.id}", scopes=[vectros.ScopeClause(allowed_actions=["records:r"])],
        )
        delegator_key = client.auth.create_scoped_key(
            key_name="delegator-py-" + support.unique_tag(), tenant_id=support.require_env("VECTROS_LIVE_TENANT_ID"), context_id=ctx, user_id=delegator.id,
        )
        delegator_key_id = delegator_key.key_id
        delegator_client = support.make_client(delegator_key.raw_key)

        delegated = delegator_client.auth.create_scoped_key(
            key_name="delegated-py-" + support.unique_tag(), tenant_id=support.require_env("VECTROS_LIVE_TENANT_ID"), context_id=ctx, user_id=target.id,
        )
        delegated_key_id = delegated.key_id
        delegated_client = support.make_client(delegated.raw_key)
        delegated_client.auth.ping()

        response = _poll_logs(client, delegated_key_id)
        assert any(e.delegation_chain for e in response.entries)

        # Ordinary comparator: the root credential's own traffic -- unambiguously
        # chain-free (a self-bound delegator mint would itself carry a chain).
        root_ping = client.auth.ping()
        root_key_id = root_ping.principal_key_id
        assert root_key_id
        ordinary = _poll_logs(client, root_key_id)
        assert not any(e.delegation_chain for e in ordinary.entries)
    finally:
        if delegated_key_id:
            support.try_cleanup("delegated key", lambda: client.auth.revoke_scoped_key(delegated_key_id))
        if delegator_key_id:
            support.try_cleanup("delegator key", lambda: client.auth.revoke_scoped_key(delegator_key_id))
        support.try_cleanup("delegator profile", lambda: client.auth.delete_access_profile(ctx, f"usr_{delegator.id}"))
        support.try_cleanup("target profile", lambda: client.auth.delete_access_profile(ctx, f"usr_{target.id}"))
        support.try_cleanup("delegator user", lambda: client.identity.delete_user(delegator.id))
        support.try_cleanup("target user", lambda: client.identity.delete_user(target.id))
        support.try_cleanup("context", lambda: client.auth.delete_app_context(ctx, confirm=ctx))
