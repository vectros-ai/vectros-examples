"""
test_auth.py — API-key auth, health check, and the scoped-token mint/enforce
cycle.

The ping test is the single most important smoke check: if it fails, the API key
is invalid or the API is unreachable.
"""
from __future__ import annotations

import time

import pytest
import vectros

import support


# ANCHOR — most important test in the suite.
def test_ping_ok_with_valid_key(client):
    resp = client.auth.ping()
    assert resp is not None
    # ping returns the authenticated principal's identity; environment must be set.
    assert resp.environment is not None


def test_root_key_principal_key_id_is_stable_across_calls(client):
    """principalKeyId for a root sk_* key identifies the KEY, not the call --
    unlike an st_* token's per-mint jti (see
    test_scoped_token_principal_key_id_is_unique_per_mint), two pings with the
    SAME key must report the SAME value. Asserting only "is a string" would
    not catch a regression that started minting a fresh id per call."""
    body1 = client.auth.ping()
    body2 = client.auth.ping()
    assert body1.principal_key_id
    assert body1.principal_key_id == body2.principal_key_id


def test_ping_403_with_invalid_key():
    bad = support.make_client("sk_live_invalid_for_smoke_test")
    with pytest.raises(vectros.core.api_error.ApiError) as exc:
        bad.auth.ping()
    # Invalid keys surface as 403 (denied before any handler runs), not 401.
    assert support.status_of(exc.value) == 403


def test_get_usage_deserializes(client):
    """Auth-bearing GET + clean pydantic deserialization of the usage report."""
    assert client.auth.get_usage() is not None


def test_mint_scoped_token_returns_token_and_expiry(client):
    minted = client.auth.mint_token(scope=vectros.ScopeRequest(allowed_actions=["records:r"]))
    assert minted.token.startswith("st_")
    assert minted.expires_at > time.time()


def test_scoped_token_principal_key_id_is_unique_per_mint(client):
    """principalKeyId for an st_* token is the token's own jti (unique per
    mint), not the bound identity — two tokens minted for the same scope must
    report different values on ping. Asserting only "is a string" would not
    catch a regression back to the old (pre-0.39.0) behavior, which echoed the
    bound user/key id and would be IDENTICAL across mints."""
    scope = vectros.ScopeRequest(allowed_actions=["records:r"])
    minted1 = client.auth.mint_token(scope=scope)
    minted2 = client.auth.mint_token(scope=scope)

    body1 = support.make_client(minted1.token).auth.ping()
    body2 = support.make_client(minted2.token).auth.ping()
    assert body1.principal_type == "token"
    assert body1.principal_key_id != body2.principal_key_id


def test_mint_token_rejects_expires_in_seconds_above_the_1hour_cap(client):
    """0.39.0 lowered the max from 86400 (24h) to 3600 (1h). Assert both
    sides of the exact boundary: 3600 still succeeds (it's also the
    default), 3601 is rejected."""
    scope = vectros.ScopeRequest(allowed_actions=["records:r"])
    at_cap = client.auth.mint_token(scope=scope, expires_in_seconds=3600)
    assert at_cap.token.startswith("st_")

    with pytest.raises(vectros.core.api_error.ApiError) as exc:
        client.auth.mint_token(scope=scope, expires_in_seconds=3601)
    assert support.status_of(exc.value) == 400


def test_scoped_token_records_r_allows_list_blocks_create(client):
    """Action-letter enforcement: 'r' allows GET/list, blocks create with a
    uniform 403 (the API does not reveal which scope check failed)."""
    minted = client.auth.mint_token(scope=vectros.ScopeRequest(allowed_actions=["records:r"]))
    scoped = support.make_client(minted.token)

    # list is a read — allowed.
    assert scoped.records.list_records(type="any") is not None

    # create is a write — must be rejected with a uniform 403.
    with pytest.raises(vectros.core.api_error.ApiError) as exc:
        scoped.records.create_record(
            type_name="smoke_unauthorized_" + support.unique_tag(),
            schema_id="irrelevant-blocked-by-scope",
            payload={},
        )
    assert support.status_of(exc.value) == 403
