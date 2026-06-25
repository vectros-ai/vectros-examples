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
