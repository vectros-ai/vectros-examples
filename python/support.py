"""
Shared support for the Python SDK smoke suite.

This suite installs the `vectros` PyPI package and drives it against the live
Vectros API, proving the cross-language wire contract that mock-client unit tests
cannot. It provides the building blocks (unique tagging, indexing polls, stream
collection, and the two-app-context isolation fixture) on the Python SDK's
snake_case surface.

AUTH MODEL: the SDK is constructed directly with a Vectros API key (`sk_*`) — that
is how your app uses the SDK. Credentials and the target base URL arrive via
environment variables.
"""
from __future__ import annotations

import os
import time
import json
import random
import string
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Optional

import vectros
from vectros import VectrosApi
from vectros.core.api_error import ApiError


# ---------------------------------------------------------------------------
# Environment / client construction
# ---------------------------------------------------------------------------
def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is required. Set it in your environment (or your CI secret "
            f"store) before running the suite."
        )
    return value


def base_url() -> str:
    return require_env("VECTROS_API_BASE_URL").rstrip("/")


def make_client(token: str) -> VectrosApi:
    """A VectrosApi bound to `token` and the configured base URL."""
    return VectrosApi(base_url=base_url(), token=token)


def live_client() -> VectrosApi:
    """LIVE-tenant client (root sk_* key) — the primary client most tests use."""
    return make_client(require_env("VECTROS_API_KEY"))


def test_tenant_client() -> VectrosApi:
    """Second-tenant client — same account, separate tenant (isolation tests)."""
    return make_client(require_env("VECTROS_TEST_API_KEY"))


# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------
def unique_tag() -> str:
    """A collision-resistant tag for naming test data: smoke-<ms>-<rnd>."""
    rnd = "".join(random.choices(string.ascii_lowercase + string.digits, k=5))
    return f"smoke-{int(time.time() * 1000)}-{rnd}"


def status_of(err: Exception) -> Optional[int]:
    """HTTP status from a Vectros ApiError, else None."""
    return getattr(err, "status_code", None) if isinstance(err, ApiError) else None


def collect_stream(stream: Iterable[Any]) -> list[Any]:
    """Drain a streaming inference response (an iterator of discriminated
    pydantic events) into a list for synchronous assertion."""
    return list(stream)


def poll_until_indexed(
    client: VectrosApi, doc_id: str, timeout_s: float = 60.0
) -> Any:
    """Poll a document until index_status == INDEXED (or raise on FAILED / timeout).

    The processing axis is index_status; status is the ACTIVE/ARCHIVED lifecycle
    and never reaches INDEXED.
    """
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        last = client.documents.get_document(doc_id)
        if last.index_status == "INDEXED":
            return last
        if last.index_status == "FAILED":
            raise AssertionError(f"document {doc_id} reached FAILED during indexing")
        time.sleep(2.0)
    raise AssertionError(
        f"document {doc_id} did not reach INDEXED within {timeout_s}s "
        f"(last index_status: {getattr(last, 'index_status', None)})"
    )


def try_cleanup(label: str, fn: Callable[[], Any]) -> None:
    """Best-effort cleanup — log, never raise (used in teardown)."""
    try:
        fn()
    except Exception as err:  # noqa: BLE001 - cleanup must never mask the real failure
        print(f"[cleanup] {label} failed: {err}")


# ---------------------------------------------------------------------------
# Raw HTTP (error-contract spec — deliberately NOT the SDK)
# ---------------------------------------------------------------------------
@dataclass
class RawResponse:
    status: int
    raw_body: str
    parsed: Any


def raw_post(path: str, body: str) -> RawResponse:
    """POST a raw (possibly malformed) JSON body with the live key. The SDK's
    typed surface would reject these bodies at call time; the API error contract
    must hold against any well-formed HTTP request with a malformed body, so we go
    around the SDK with stdlib urllib."""
    key = require_env("VECTROS_API_KEY")
    req = urllib.request.Request(
        f"{base_url()}{path}",
        data=body.encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req) as resp:  # noqa: S310 - fixed https base
            status, raw = resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read().decode("utf-8")
    # Parse separately: JSON.parse throwing IS the bug class we guard against.
    parsed = json.loads(raw)  # raises -> the test fails loudly, by design
    return RawResponse(status=status, raw_body=raw, parsed=parsed)


# ---------------------------------------------------------------------------
# Two-app-context isolation fixture
# ---------------------------------------------------------------------------
# Broad enough to create + read + delete within a context; the context partition
# (not the scope) is what isolation under test relies on.
_CONTEXT_KEY_ACTIONS = [
    "records:c", "records:r", "records:d",
    "documents:c", "documents:r", "documents:d",
    "folders:c", "folders:r", "folders:d",
    "schemas:c", "schemas:r", "schemas:d",
    "search:r",
]


def _context_id(label: str) -> str:
    """A context id valid under `^[a-z][a-z0-9-]{2,30}$`."""
    rnd = f"{int(time.time() * 1000)}{''.join(random.choices(string.ascii_lowercase + string.digits, k=8))}"
    return f"ctx-{label}-{rnd}"[:31]


@dataclass
class ContextHandle:
    context_id: str = ""
    user_id: str = ""
    key_id: str = ""
    api: Optional[VectrosApi] = None


@dataclass
class TwoContextFixture:
    tenant_id: str
    ctx_a: ContextHandle
    ctx_b: ContextHandle
    _created: list[ContextHandle] = field(default_factory=list)

    def teardown(self, root: VectrosApi) -> None:
        for h in self._created:
            if h.key_id:
                try_cleanup(f"revoke key {h.key_id}", lambda h=h: root.auth.revoke_scoped_key(h.key_id))
            if h.context_id:
                try_cleanup(
                    f"delete context {h.context_id}",
                    lambda h=h: root.auth.delete_app_context(h.context_id, confirm=h.context_id),
                )
            if h.user_id:
                try_cleanup(f"delete user {h.user_id}", lambda h=h: root.identity.delete_user(h.user_id))


def _provision_context(root: VectrosApi, tenant_id: str, label: str, created: list[ContextHandle]) -> ContextHandle:
    h = ContextHandle(api=root)
    created.append(h)

    h.context_id = _context_id(label)
    root.auth.create_app_context(context_id=h.context_id, name=f"cross-context {label}")

    # A real user is required: the key binds to an AccessProfile whose
    # principal_id is `usr_<user_id>`.
    user = root.identity.create_user(external_id=unique_tag())
    h.user_id = user.id

    root.auth.create_access_profile(
        h.context_id,
        principal_id=f"usr_{h.user_id}",
        scopes=[vectros.ScopeClause(allowed_actions=_CONTEXT_KEY_ACTIONS)],
        status="active",
    )

    minted = root.auth.create_scoped_key(
        key_name=f"cross-context-{label}-{unique_tag()}",
        tenant_id=tenant_id,
        context_id=h.context_id,
        user_id=h.user_id,
    )
    if not minted.raw_key:
        raise AssertionError(
            f"Scoped key for context {label} returned no raw_key — cannot build a "
            f"confined client (raw_key is only returned once, on create)."
        )
    h.key_id = minted.key_id
    h.api = make_client(minted.raw_key)
    return h


def provision_two_contexts(root: VectrosApi) -> TwoContextFixture:
    """Two sibling contexts (A, B) in one tenant, each with a confined ssk_*
    client. Write through one client and probe with the other to prove the
    partition. Partial-failure safe: already-created resources are torn down
    before the error propagates."""
    tenant_id = require_env("VECTROS_LIVE_TENANT_ID")
    created: list[ContextHandle] = []
    try:
        ctx_a = _provision_context(root, tenant_id, "a", created)
        ctx_b = _provision_context(root, tenant_id, "b", created)
    except Exception:
        fx = TwoContextFixture(tenant_id=tenant_id, ctx_a=ContextHandle(), ctx_b=ContextHandle(), _created=created)
        fx.teardown(root)
        raise
    return TwoContextFixture(tenant_id=tenant_id, ctx_a=ctx_a, ctx_b=ctx_b, _created=created)
