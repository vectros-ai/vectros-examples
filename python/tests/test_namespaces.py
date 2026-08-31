"""
test_namespaces.py -- 0.40.0: namespace placement and namespace membership.
The Python-language analogue of namespaces.spec.ts (see that file for the
full mechanism). Ports one representative test per axis (tenant-wide
placement CRUD; the membership-follows-the-record + immediate-revocation
proof) rather than every edge case TS already covers exhaustively -- the
point of this file is proving the cross-language wire contract.
"""
from __future__ import annotations

import pytest
import vectros

import support


def _ns_name(prefix: str) -> str:
    raw = (prefix + support.unique_tag()).lower()
    return "".join(c for c in raw if c.isalnum() or c in "_-")[:32]


def _unique_rank() -> int:
    import random
    return 10_000 + random.randint(0, 900_000)


# -----------------------------------------------------------------------
# Placement
# -----------------------------------------------------------------------

def test_tenant_wide_registration_register_get_list_update_delete(client):
    namespace = _ns_name("tw")
    rank = _unique_rank()
    created = client.identity.register_namespace(namespace=namespace, specificity_rank=rank)
    assert created.namespace == namespace
    assert created.context_id is None

    try:
        loaded = client.identity.get_namespace(namespace)
        assert loaded.context_id is None
        assert loaded.specificity_rank == rank

        updated = client.identity.update_namespace(namespace, namespace=namespace, specificity_rank=rank + 1)
        assert updated.specificity_rank == rank + 1

        listed = client.identity.list_namespaces()
        names = [n.namespace for n in (listed.data or [])]
        assert namespace in names
    finally:
        client.identity.delete_namespace(namespace)

    with pytest.raises(vectros.core.api_error.ApiError) as exc:
        client.identity.get_namespace(namespace)
    assert support.status_of(exc.value) == 404


def test_context_owned_registration_entities_invisible_from_sibling_context(client):
    ctx_a = ("nsa" + support.unique_tag())[:31]
    ctx_b = ("nsb" + support.unique_tag())[:31]
    namespace = _ns_name("co")
    client.auth.create_app_context(context_id=ctx_a, name="namespace ctx A (python)")
    client.auth.create_app_context(context_id=ctx_b, name="namespace ctx B (python)")

    created = client.identity.register_namespace(
        namespace=namespace, specificity_rank=500, context_id=ctx_a, entity_backed=True,
    )
    assert created.context_id == ctx_a

    entity_id = None
    try:
        loaded = client.identity.get_namespace(namespace, context_id=ctx_a)
        assert loaded.context_id == ctx_a
        with pytest.raises(vectros.core.api_error.ApiError) as exc:
            client.identity.get_namespace(namespace, context_id=ctx_b)
        assert support.status_of(exc.value) == 404

        entity = client.identity.create_entity(
            namespace, external_id="ent-" + support.unique_tag(), context_id=ctx_a, name="A-owned",
        )
        entity_id = entity.id

        with pytest.raises(vectros.core.api_error.ApiError) as exc:
            client.identity.get_entity(namespace, entity_id, context_id=ctx_b)
        assert support.status_of(exc.value) == 404

        reloaded = client.identity.get_entity(namespace, entity_id, context_id=ctx_a)
        assert reloaded.id == entity_id
    finally:
        if entity_id:
            support.try_cleanup("entity", lambda: client.identity.delete_entity(namespace, entity_id, context_id=ctx_a))
        support.try_cleanup("namespace", lambda: client.identity.delete_namespace(namespace, context_id=ctx_a))
        support.try_cleanup("ctx A", lambda: client.auth.delete_app_context(ctx_a, confirm=ctx_a))
        support.try_cleanup("ctx B", lambda: client.auth.delete_app_context(ctx_b, confirm=ctx_b))


# -----------------------------------------------------------------------
# Membership -- ${{ member.scope.<ns> }} resolves fresh on every request
# -----------------------------------------------------------------------

@pytest.fixture(scope="module")
def membership_schema(client):
    record_type = f"smoke_member_py_{support.unique_tag()}"
    schema = client.schemas.create_schema(
        type_name=record_type, display_name="Membership Grant Schema (python)",
        index_mode="NONE", allowed_surfaces=["record"],
        fields=[
            vectros.FieldDef(field_id="granteeUserId", field_type="string", required=True, searchable=False),
        ],
        # REQUIRED: membership_target_field must be a declared lookup field, or
        # resolution refuses to resolve anyone for this namespace at all.
        lookup_fields=[vectros.LookupDef(field_name="granteeUserId")],
    )
    yield record_type, schema.id
    support.try_cleanup("schema", lambda: client.schemas.delete_schema(schema.id))


def test_bare_member_scope_grant_follows_the_record_and_revokes_immediately(client, membership_schema):
    record_type, schema_id = membership_schema
    namespace = _ns_name("m")
    value = "team-" + support.unique_tag()
    # membership_context_id='default': a record created with a root API key has
    # no way to target a non-default context, so the grant record and the mint
    # below must agree on 'default' or the membership placeholder resolves to
    # nothing.
    client.identity.register_namespace(
        namespace=namespace, specificity_rank=_unique_rank(),
        membership_record_type=record_type, membership_target_field="granteeUserId",
        membership_context_id="default",
    )
    user = client.identity.create_user(external_id=support.unique_tag())
    grant_id = None
    try:
        grant = client.records.create_record(
            type_name=record_type, schema_id=schema_id,
            payload={"granteeUserId": user.id}, scopes=[f"{namespace}:{value}"],
        )
        grant_id = grant.id
        # Not polling for INDEXED: index_mode NONE (store-only) -- reads go
        # through list_records (the primary store), not search.

        # scope.identity.userId is REQUIRED and distinct from the top-level
        # userId -- membership resolution looks up the caller's own identity
        # from scope.identity.
        minted = client.auth.mint_token(
            user_id=user.id,
            scope=vectros.ScopeRequest(
                allowed_actions=["records:r"],
                identity={"userId": user.id},
                data_scope={f"scope:{namespace}": [f"${{{{ member.scope.{namespace} }}}}"]},
            ),
        )
        scoped = support.make_client(minted.token)

        seen = scoped.records.list_records(type=record_type, scope=f"{namespace}:{value}")
        assert grant_id in [r.id for r in (seen.data or [])]

        # Revoke -- delete the grant record -- then immediately re-query with
        # the SAME (unexpired, not re-minted) token. Resolution is per-request.
        client.records.delete_record(grant_id)
        grant_id = None
        with pytest.raises(vectros.core.api_error.ApiError) as exc:
            scoped.records.list_records(type=record_type, scope=f"{namespace}:{value}")
        assert support.status_of(exc.value) == 403
    finally:
        if grant_id:
            support.try_cleanup("grant record", lambda: client.records.delete_record(grant_id))
        support.try_cleanup("user", lambda: client.identity.delete_user(user.id))
        support.try_cleanup("namespace", lambda: client.identity.delete_namespace(namespace))
