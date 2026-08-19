"""
test_issuers_token_exchange.py — the trusted BYO-IdP issuer registry
(POST/GET/DELETE /v1/auth/issuers) and RFC 8693 token exchange
(POST /v1/auth/token/exchange) — the Python-language analogue of
issuers-token-exchange.spec.ts.

SCOPE NOTE (see that file for the full reasoning): a genuinely SUCCESSFUL
exchange -- and the self-signup/invite-bind paths that depend on one --
needs a subject_token signed by a JWKS whose PRIVATE key this suite
controls, at a PUBLICLY reachable URL (the exchange endpoint fail-closed
rejects loopback/link-local/private-range JWKS hosts, so no local mock
server can stand in). No such fixture is available; standing one up is out
of scope here. This covers the full issuer-registry CRUD contract plus
every exchange() rejection reachable without one, including a real 401
(registered against Google's real, stable public JWKS, presented with a
signature that can never verify against it).
"""
from __future__ import annotations

import base64
import json
import uuid

import pytest
import vectros

import support

GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
JWT_TYPE = "urn:ietf:params:oauth:token-type:jwt"
GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def fake_jwt(iss: str | None = None, aud=None, sub: str | None = None) -> str:
    """header.payload.garbage-signature -- structurally a JWT, never cryptographically verifiable."""
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = {}
    if iss is not None:
        claims["iss"] = iss
    if aud is not None:
        claims["aud"] = aud
    if sub is not None:
        claims["sub"] = sub
    payload = _b64url(json.dumps(claims).encode())
    sig = _b64url(("not-a-real-signature-" + support.unique_tag()).encode())
    return f"{header}.{payload}.{sig}"


def slug(prefix: str) -> str:
    return (prefix + support.unique_tag())[:31]


@pytest.fixture
def ctx_id(client):
    ctx_id = slug("ix")
    client.auth.create_app_context(context_id=ctx_id, name="issuers spec parent")
    yield ctx_id
    try:
        client.auth.delete_app_context(ctx_id, confirm=ctx_id)
    except vectros.core.api_error.ApiError:
        pass


# -----------------------------------------------------------------------
# Issuer registry CRUD
# -----------------------------------------------------------------------

def test_register_issuer_with_ordinary_scoped_token_403(client, ctx_id):
    # Every register/delete elsewhere in this file uses the root client. Writing an issuer
    # registration accepts ONLY a root sk_* key or the CLI bootstrap's dedicated provisioning
    # capability -- a capability that can never be granted to an ordinary role, and that a bare
    # '*' wildcard does not satisfy either. An ordinary scoped token carrying neither must be
    # refused.
    minted = client.auth.mint_token(
        context_id=ctx_id, scope=vectros.ScopeRequest(allowed_actions=["records:r"]),
    )
    scoped = support.make_client(minted.token)
    with pytest.raises(vectros.core.api_error.ApiError) as exc:
        scoped.auth.register_issuer(
            issuer_id=slug("noauth"), issuer=f"https://{support.unique_tag()}.example.com/",
            jwks_uri=GOOGLE_JWKS, audience=f"aud-{support.unique_tag()}", context_id=ctx_id,
        )
    assert support.status_of(exc.value) == 403


def test_delete_issuer_with_ordinary_scoped_token_403(client, ctx_id):
    minted = client.auth.mint_token(
        context_id=ctx_id, scope=vectros.ScopeRequest(allowed_actions=["records:r"]),
    )
    scoped = support.make_client(minted.token)
    # The gate runs before any existence check -- a non-existent issuer_id must still 403, never
    # 404, so this proves the GATE fired, not a coincidental not-found.
    with pytest.raises(vectros.core.api_error.ApiError) as exc:
        scoped.auth.delete_issuer(slug("noauth"))
    assert support.status_of(exc.value) == 403


def test_register_get_list_delete_then_get_404s(client, ctx_id):
    issuer_id = slug("reg")
    issuer = f"https://{support.unique_tag()}.example.com/"
    audience = f"aud-{support.unique_tag()}"
    created = client.auth.register_issuer(
        issuer_id=issuer_id, issuer=issuer, jwks_uri=GOOGLE_JWKS, audience=audience, context_id=ctx_id,
    )
    assert created.created is True
    assert created.issuer_id == issuer_id

    try:
        loaded = client.auth.get_issuer(issuer_id)
        assert loaded.audience == audience

        # DRAIN all pages rather than trusting the default first page to still hold ours --
        # the shared tenant accumulates issuers across runs (including residue from an
        # aborted run's incomplete teardown), which can push a fresh registration off page 1.
        listed_ids = []
        cursor = None
        while True:
            page = client.auth.list_issuers(limit=100, start_from=cursor) if cursor else client.auth.list_issuers(limit=100)
            listed_ids.extend(i.issuer_id for i in (page.data or []))
            cursor = page.next_cursor
            if not cursor:
                break
        assert issuer_id in listed_ids

        client.auth.delete_issuer(issuer_id)
        with pytest.raises(vectros.core.api_error.ApiError) as exc:
            client.auth.get_issuer(issuer_id)
        assert support.status_of(exc.value) == 404
    finally:
        try:
            client.auth.delete_issuer(issuer_id)
        except vectros.core.api_error.ApiError:
            pass


def test_registering_same_issuer_id_twice_is_idempotent(client, ctx_id):
    issuer_id = slug("idem")
    issuer = f"https://{support.unique_tag()}.example.com/"
    audience = f"aud-{support.unique_tag()}"
    try:
        first = client.auth.register_issuer(
            issuer_id=issuer_id, issuer=issuer, jwks_uri=GOOGLE_JWKS, audience=audience, context_id=ctx_id,
        )
        assert first.created is True
        # Second call names DIFFERENT issuer/audience -- idempotency keys on issuer_id alone, so the
        # ORIGINAL values must survive.
        second = client.auth.register_issuer(
            issuer_id=issuer_id, issuer="https://different.example.com/", jwks_uri=GOOGLE_JWKS,
            audience="different-aud", context_id=ctx_id,
        )
        assert second.created is False
        assert second.issuer == issuer
        assert second.audience == audience
    finally:
        try:
            client.auth.delete_issuer(issuer_id)
        except vectros.core.api_error.ApiError:
            pass


def test_second_issuer_id_cannot_claim_an_already_registered_pair(client, ctx_id):
    issuer = f"https://{support.unique_tag()}.example.com/"
    audience = f"aud-{support.unique_tag()}"
    first_id = slug("paira")
    second_id = slug("pairb")
    try:
        client.auth.register_issuer(
            issuer_id=first_id, issuer=issuer, jwks_uri=GOOGLE_JWKS, audience=audience, context_id=ctx_id,
        )
        with pytest.raises(vectros.core.api_error.ApiError) as exc:
            client.auth.register_issuer(
                issuer_id=second_id, issuer=issuer, jwks_uri=GOOGLE_JWKS, audience=audience, context_id=ctx_id,
            )
        assert support.status_of(exc.value) == 400
    finally:
        try:
            client.auth.delete_issuer(first_id)
        except vectros.core.api_error.ApiError:
            pass


def test_self_signup_policy_targeting_an_already_elevated_role_rejected_at_registration(client, ctx_id):
    # 'provisioning:c' can never be granted to any role at all (rejected at role-authoring time,
    # independent of self-signup) -- wildcard '*' is the grantable literal that is also treated
    # as elevated.
    role_id = slug("elev")
    issuer_id = slug("selfup")
    client.auth.create_role(
        ctx_id, role_id=role_id, name="Elevated",
        scopes=[vectros.ScopeClause(allowed_actions=["*"])],
    )
    try:
        with pytest.raises(vectros.core.api_error.ApiError) as exc:
            client.auth.register_issuer(
                issuer_id=issuer_id, issuer=f"https://{support.unique_tag()}.example.com/",
                jwks_uri=GOOGLE_JWKS, audience=f"aud-{support.unique_tag()}", context_id=ctx_id,
                self_signup_policies=[vectros.SelfSignupPolicy(signup_type="member", role_id=role_id)],
            )
        assert support.status_of(exc.value) == 400
    finally:
        try:
            client.auth.delete_role(ctx_id, role_id)
        except vectros.core.api_error.ApiError:
            pass


# -----------------------------------------------------------------------
# Token exchange -- request-shape + routing rejections (no live IdP needed)
# -----------------------------------------------------------------------

def test_exchange_missing_subject_token_400(client):
    with pytest.raises(vectros.core.api_error.ApiError) as exc:
        client.auth.exchange_token(grant_type=GRANT_TYPE, subject_token="", subject_token_type=JWT_TYPE)
    assert support.status_of(exc.value) == 400


def test_exchange_malformed_jwt_400(client):
    with pytest.raises(vectros.core.api_error.ApiError) as exc:
        client.auth.exchange_token(
            grant_type=GRANT_TYPE, subject_token="not-even-jwt-shaped", subject_token_type=JWT_TYPE,
        )
    assert support.status_of(exc.value) == 400


def test_exchange_unregistered_issuer_404(client):
    jwt = fake_jwt(
        iss=f"https://never-registered-{support.unique_tag()}.example.com/",
        aud=f"no-such-audience-{support.unique_tag()}", sub="someone",
    )
    with pytest.raises(vectros.core.api_error.ApiError) as exc:
        client.auth.exchange_token(grant_type=GRANT_TYPE, subject_token=jwt, subject_token_type=JWT_TYPE)
    assert support.status_of(exc.value) == 404


def test_exchange_registered_issuer_unverifiable_signature_401_then_deregistered_404(client, ctx_id):
    issuer_id = slug("verify")
    issuer = "https://accounts.google.com"
    audience = f"aud-{support.unique_tag()}"
    client.auth.register_issuer(
        issuer_id=issuer_id, issuer=issuer, jwks_uri=GOOGLE_JWKS, audience=audience, context_id=ctx_id,
    )
    try:
        jwt = fake_jwt(iss=issuer, aud=audience, sub=f"smoke-{support.unique_tag()}")
        with pytest.raises(vectros.core.api_error.ApiError) as exc:
            client.auth.exchange_token(grant_type=GRANT_TYPE, subject_token=jwt, subject_token_type=JWT_TYPE)
        assert support.status_of(exc.value) == 401

        client.auth.delete_issuer(issuer_id)
        jwt2 = fake_jwt(iss=issuer, aud=audience, sub=f"smoke-{support.unique_tag()}")
        with pytest.raises(vectros.core.api_error.ApiError) as exc:
            client.auth.exchange_token(grant_type=GRANT_TYPE, subject_token=jwt2, subject_token_type=JWT_TYPE)
        assert support.status_of(exc.value) == 404
    finally:
        try:
            client.auth.delete_issuer(issuer_id)
        except vectros.core.api_error.ApiError:
            pass


# -----------------------------------------------------------------------
# Token exchange — OAuth error envelope shape (RFC 6749 §5.2)
# -----------------------------------------------------------------------
# Every rejection test above asserts status_of() only. This proves the BODY
# shape too -- the deliberate deviation from this API's usual {message}
# envelope, since a generic OAuth client (not the vectros SDK) is the
# documented caller. Uses support.raw_post -- the generated SDK's ApiError
# has no typed field for either OAuth key (no response schema is declared
# for the 4xx/401/403/404 cases).
def test_exchange_400_uses_oauth_envelope_not_message():
    r = support.raw_post("/v1/auth/token/exchange", json.dumps({
        "grant_type": GRANT_TYPE, "subject_token": "", "subject_token_type": JWT_TYPE,
    }))
    assert r.status == 400
    assert isinstance(r.parsed.get("error"), str) and r.parsed["error"]
    assert isinstance(r.parsed.get("error_description"), str) and r.parsed["error_description"]
    assert "message" not in r.parsed


def test_exchange_404_uses_oauth_envelope_not_message():
    jwt = fake_jwt(
        iss=f"https://definitely-never-registered-{support.unique_tag()}.example.com/",
        aud=f"no-such-audience-{support.unique_tag()}",
    )
    r = support.raw_post("/v1/auth/token/exchange", json.dumps({
        "grant_type": GRANT_TYPE, "subject_token": jwt, "subject_token_type": JWT_TYPE,
    }))
    assert r.status == 404
    assert isinstance(r.parsed.get("error"), str) and r.parsed["error"]
    assert isinstance(r.parsed.get("error_description"), str) and r.parsed["error_description"]
    assert "message" not in r.parsed


def test_exchange_401_uses_oauth_envelope_not_message(client, ctx_id):
    issuer_id = slug("envl")
    issuer = "https://accounts.google.com"
    audience = f"aud-{support.unique_tag()}"
    client.auth.register_issuer(
        issuer_id=issuer_id, issuer=issuer, jwks_uri=GOOGLE_JWKS, audience=audience, context_id=ctx_id,
    )
    try:
        jwt = fake_jwt(iss=issuer, aud=audience, sub=f"smoke-{support.unique_tag()}")
        r = support.raw_post("/v1/auth/token/exchange", json.dumps({
            "grant_type": GRANT_TYPE, "subject_token": jwt, "subject_token_type": JWT_TYPE,
        }))
        assert r.status == 401
        assert isinstance(r.parsed.get("error"), str) and r.parsed["error"]
        assert isinstance(r.parsed.get("error_description"), str) and r.parsed["error_description"]
        assert "message" not in r.parsed
    finally:
        try:
            client.auth.delete_issuer(issuer_id)
        except vectros.core.api_error.ApiError:
            pass


# -----------------------------------------------------------------------
# GET /v1/users/exists-by-email
# -----------------------------------------------------------------------

def test_exists_by_email_true_for_a_member_false_for_a_stranger(client, ctx_id):
    email = f"{support.unique_tag()}@test.com"
    user = client.identity.create_user(external_id=support.unique_tag(), email=email)
    client.auth.create_access_profile(
        ctx_id, principal_id=f"usr_{user.id}", scopes=[vectros.ScopeClause(allowed_actions=["records:r"])],
    )
    try:
        found = client.identity.user_exists_by_email(email=email, context_id=ctx_id)
        assert found.exists is True
        assert found.user_id == user.id

        not_found = client.identity.user_exists_by_email(
            email=f"{support.unique_tag()}-nobody@test.com", context_id=ctx_id,
        )
        assert not_found.exists is False
    finally:
        try:
            client.auth.delete_access_profile(ctx_id, f"usr_{user.id}")
        except vectros.core.api_error.ApiError:
            pass
        try:
            client.identity.delete_user(user.id)
        except vectros.core.api_error.ApiError:
            pass


# -----------------------------------------------------------------------
# GET /v1/app-contexts/{contextId}/profiles -- batched email resolution
# -----------------------------------------------------------------------
# Only the singular get_access_profile path asserts email resolution elsewhere in this suite.
# The LIST endpoint resolves email via a separate, batched code path -- two distinct
# users/profiles so a mis-keyed batch (rows swapped, or the whole page resolved from one row's
# email) would be caught, not just "email is present somewhere".
def test_list_access_profiles_resolves_email_per_row(client, ctx_id):
    email_a = f"{support.unique_tag()}-a@test.com"
    email_b = f"{support.unique_tag()}-b@test.com"
    user_a = client.identity.create_user(external_id=support.unique_tag(), email=email_a)
    user_b = client.identity.create_user(external_id=support.unique_tag(), email=email_b)
    client.auth.create_access_profile(
        ctx_id, principal_id=f"usr_{user_a.id}", scopes=[vectros.ScopeClause(allowed_actions=["records:r"])],
    )
    client.auth.create_access_profile(
        ctx_id, principal_id=f"usr_{user_b.id}", scopes=[vectros.ScopeClause(allowed_actions=["records:r"])],
    )
    try:
        # Root key holds users:r implicitly -- email present, and correctly per-row.
        page = client.auth.list_access_profiles(ctx_id)
        rows = {p.principal_id: p.email for p in (page.data or [])}
        assert rows.get(f"usr_{user_a.id}") == email_a
        assert rows.get(f"usr_{user_b.id}") == email_b

        # A scoped token holding profiles:r but NOT users:r -- email must be absent on every row.
        minted = client.auth.mint_token(
            context_id=ctx_id, scope=vectros.ScopeRequest(allowed_actions=["profiles:r"]),
        )
        scoped = support.make_client(minted.token)
        scoped_page = scoped.auth.list_access_profiles(ctx_id)
        scoped_rows = list(scoped_page.data or [])
        assert len(scoped_rows) >= 2
        for row in scoped_rows:
            assert row.email is None
    finally:
        for user in (user_a, user_b):
            try:
                client.auth.delete_access_profile(ctx_id, f"usr_{user.id}")
            except vectros.core.api_error.ApiError:
                pass
            try:
                client.identity.delete_user(user.id)
            except vectros.core.api_error.ApiError:
                pass
