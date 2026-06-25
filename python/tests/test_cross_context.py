"""
test_cross_context.py — end-to-end proof that an app context is a fail-closed
data partition within a single tenant.

Highest-value isolation seam: both contexts live in ONE tenant, so the only thing
keeping their data apart is the context partition itself, exercised over the real
wire. Each test is SYMMETRIC — each confined caller sees ONLY its own object and
gets a uniform 404 for the sibling's (no existence probe) — so a
silently-broken/over-confined caller can't make the negative pass vacuously.

Cross-context get-by-id / delete return 404 (the partition), NOT 403 (which is
scope denial — covered in test_auth.py). Coverage here = records (incl. lookup +
list) and documents (incl. search); the same partition seam holds for folders and
schemas.
"""
from __future__ import annotations

import time

import pytest
import vectros

import support


def _expect_status(fn, status: int):
    with pytest.raises(vectros.core.api_error.ApiError) as exc:
        fn()
    assert support.status_of(exc.value) == status


def _create_record(ctx, type_name: str, mrn: str) -> str:
    schema = ctx.api.schemas.create_schema(
        type_name=type_name,
        display_name="Cross-context Record Schema",
        index_mode="NONE",
        allowed_surfaces=["record"],
        fields=[vectros.FieldDef(field_id="mrn", field_type="string", required=True)],
        lookup_fields=[vectros.LookupDef(field_name="mrn", unique=True)],
    )
    rec = ctx.api.records.create_record(type_name=type_name, schema_id=schema.id, payload={"mrn": mrn})
    return rec.id


def _lookup_record_ids(ctx, type_name, field, value) -> list[str]:
    res = ctx.api.records.lookup_records(type=type_name, field=field, value=value)
    return [r.id for r in (res.data or []) if r.id]


def _list_record_ids(ctx, type_name) -> list[str]:
    res = ctx.api.records.list_records(type=type_name, limit=100)
    return [r.id for r in (res.data or []) if r.id]


def test_records_each_context_sees_only_its_own(two_contexts):
    a, b = two_contexts.ctx_a, two_contexts.ctx_b
    type_name = f"xctx_rec_{support.unique_tag()}".replace("-", "_")
    mrn_a, mrn_b = f"MRN-A-{support.unique_tag()}", f"MRN-B-{support.unique_tag()}"

    rec_a = _create_record(a, type_name, mrn_a)
    rec_b = _create_record(b, type_name, mrn_b)

    # ctxA sees A, never B.
    assert a.api.records.get_record(rec_a).id == rec_a
    _expect_status(lambda: a.api.records.get_record(rec_b), 404)
    assert _lookup_record_ids(a, type_name, "mrn", mrn_a) == [rec_a]
    assert _lookup_record_ids(a, type_name, "mrn", mrn_b) == []
    assert rec_a in _list_record_ids(a, type_name)
    assert rec_b not in _list_record_ids(a, type_name)

    # ctxB sees B, never A.
    assert b.api.records.get_record(rec_b).id == rec_b
    _expect_status(lambda: b.api.records.get_record(rec_a), 404)
    assert _lookup_record_ids(b, type_name, "mrn", mrn_b) == [rec_b]
    assert _lookup_record_ids(b, type_name, "mrn", mrn_a) == []

    # Mutate isolation: neither can DELETE the other's record (confined keys hold
    # records:d, so a 404 here is the partition, not a missing scope).
    _expect_status(lambda: b.api.records.delete_record(rec_a), 404)
    _expect_status(lambda: a.api.records.delete_record(rec_b), 404)
    assert a.api.records.get_record(rec_a).id == rec_a
    assert b.api.records.get_record(rec_b).id == rec_b
    # ...and each context CAN delete its OWN (proves both delete routes live).
    a.api.records.delete_record(rec_a)
    _expect_status(lambda: a.api.records.get_record(rec_a), 404)
    b.api.records.delete_record(rec_b)
    _expect_status(lambda: b.api.records.get_record(rec_b), 404)


def _create_doc(ctx, type_name, po, marker) -> str:
    schema = ctx.api.schemas.create_schema(
        type_name=type_name,
        display_name="Cross-context Document Schema",
        index_mode="TEXT",
        allowed_surfaces=["document"],
        fields=[vectros.FieldDef(field_id="po_number", field_type="string")],
        lookup_fields=[vectros.LookupDef(field_name="po_number", unique=False)],
    )
    doc = ctx.api.documents.ingest_document(
        title=f"Cross-context Doc {po}",
        schema_id=schema.id,
        text=f"Confidential note {marker} for purchase order {po}.",
        index_mode="TEXT",
        store_text=True,
        payload={"po_number": po},
    )
    return doc.id


def _search_doc_ids(ctx, query, created_after) -> list[str]:
    res = ctx.api.search.content(query=query, mode="TEXT", limit=100, created_after=created_after)
    return [r.document_id for r in (res.results or []) if r.document_id]


def test_documents_each_context_sees_only_its_own_incl_search(two_contexts):
    a, b = two_contexts.ctx_a, two_contexts.ctx_b
    type_name = f"xctx_doc_{support.unique_tag()}".replace("-", "_")
    po_a, po_b = f"PO-A-{support.unique_tag()}", f"PO-B-{support.unique_tag()}"
    marker_a = f"XCTXMARKERA_{support.unique_tag()}".replace("-", "_")
    marker_b = f"XCTXMARKERB_{support.unique_tag()}".replace("-", "_")
    started_at = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())

    doc_a = _create_doc(a, type_name, po_a, marker_a)
    doc_b = _create_doc(b, type_name, po_b, marker_b)
    support.poll_until_indexed(a.api, doc_a)
    support.poll_until_indexed(b.api, doc_b)

    # by-id.
    assert a.api.documents.get_document(doc_a).id == doc_a
    _expect_status(lambda: a.api.documents.get_document(doc_b), 404)
    assert b.api.documents.get_document(doc_b).id == doc_b
    _expect_status(lambda: b.api.documents.get_document(doc_a), 404)

    # search — each context finds its own marker; the partition keeps the
    # sibling's document out of the result set (positive control proves search
    # is live for both callers).
    assert doc_a in _search_doc_ids(a, marker_a, started_at)
    assert doc_b not in _search_doc_ids(a, marker_b, started_at)
    assert doc_b in _search_doc_ids(b, marker_b, started_at)
    assert doc_a not in _search_doc_ids(b, marker_a, started_at)

    # Mutate isolation, then each deletes its own.
    _expect_status(lambda: b.api.documents.delete_document(doc_a), 404)
    _expect_status(lambda: a.api.documents.delete_document(doc_b), 404)
    a.api.documents.delete_document(doc_a)
    _expect_status(lambda: a.api.documents.get_document(doc_a), 404)
    b.api.documents.delete_document(doc_b)
    _expect_status(lambda: b.api.documents.get_document(doc_b), 404)
