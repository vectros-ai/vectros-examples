"""
pytest fixtures for the Python SDK smoke suite.

Credentials + target env arrive via environment variables:

  VECTROS_API_KEY        live-tenant sk_* (root) key
  VECTROS_TEST_API_KEY   second-tenant sk_* key (optional; isolation tests skip)
  VECTROS_LIVE_TENANT_ID tenant id the scoped-key mint operates on (cross-context)
  VECTROS_API_BASE_URL   https://api.vectros.ai
"""
from __future__ import annotations

import os
import pytest

import support


@pytest.fixture(scope="session")
def client():
    """LIVE-tenant root client — shared across the session (read-mostly)."""
    return support.live_client()


@pytest.fixture(scope="session")
def test_client():
    """Second-tenant client; skips the test if no second-tenant key is provisioned."""
    if not os.environ.get("VECTROS_TEST_API_KEY"):
        pytest.skip("VECTROS_TEST_API_KEY not provisioned in this environment")
    return support.test_tenant_client()


@pytest.fixture(scope="module")
def two_contexts(client):
    """Two confined sibling app-contexts in one tenant; torn down after the module."""
    if not os.environ.get("VECTROS_LIVE_TENANT_ID"):
        pytest.skip("VECTROS_LIVE_TENANT_ID not set — cross-context isolation needs it")
    fx = support.provision_two_contexts(client)
    yield fx
    fx.teardown(client)
