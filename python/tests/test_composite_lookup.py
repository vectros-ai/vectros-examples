"""
test_composite_lookup.py — the SDK's composite lookup (`field_names` in
place of `field_name`, and the array-typed `values` parameter) — the
Python-language analogue of composite-lookup.spec.ts's
"a comma-bearing value survives as one leg" case.

The guarantee under test (arrays serialize as a REPEATED query parameter,
`?values=a&values=b`, never comma-joined `?values=a,b`) has zero signal from
the OpenAPI spec, the type system, or any other test in this suite -- it's
enforced entirely by each Fern generator's array-serialization default,
which can vary or regress independently per language.
"""
from __future__ import annotations

import pytest
import vectros

import support


@pytest.fixture
def composite_lookup_records(client):
    record_type = ("smoke_ticket_" + support.unique_tag()).replace("-", "_")
    schema = client.schemas.create_schema(
        type_name=record_type,
        display_name="Composite Lookup Smoke (Python)",
        index_mode="NONE",
        # A lookup over several fields cannot set unique/range_enabled, and its schema
        # must list 'record' as its only allowed_surfaces entry.
        allowed_surfaces=["record"],
        fields=[
            vectros.FieldDef(field_id="status", field_type="string", required=True, filterable=True),
            vectros.FieldDef(field_id="area", field_type="string", required=True, filterable=True),
        ],
        # Declare with field_names in place of field_name.
        lookup_fields=[vectros.LookupDef(field_names=["status", "area"])],
    )
    schema_id = schema.id

    rec_open_billing = client.records.create_record(
        type_name=record_type, schema_id=schema_id, payload={"status": "open", "area": "billing"},
    ).id
    # The comma-bearing value -- the one case that would silently regress with zero
    # signal from the type system if the client comma-joined `values` instead of
    # repeating the query parameter.
    rec_open_comma_value = client.records.create_record(
        type_name=record_type, schema_id=schema_id,
        payload={"status": "open", "area": "billing,enterprise"},
    ).id

    yield record_type, rec_open_billing, rec_open_comma_value

    try:
        client.records.delete_record(rec_open_billing)
    except vectros.core.api_error.ApiError:
        pass
    try:
        client.records.delete_record(rec_open_comma_value)
    except vectros.core.api_error.ApiError:
        pass
    try:
        client.schemas.delete_schema(schema_id)
    except vectros.core.api_error.ApiError:
        pass


def test_full_tuple_matches_exactly_one_record(client, composite_lookup_records):
    record_type, rec_open_billing, _ = composite_lookup_records
    page = client.records.lookup_records(type=record_type, field="status,area", values=["open", "billing"])
    ids = [r.id for r in (page.data or [])]
    assert ids == [rec_open_billing]  # exactly one match -- not merely "contains"


def test_comma_bearing_value_survives_as_one_leg_not_split(client, composite_lookup_records):
    """If the wire serialization comma-joined `values` instead of repeating the query
    parameter, values=["open", "billing,enterprise"] would arrive at the server looking
    like THREE legs (open, billing, enterprise) rather than two -- either rejected
    outright or simply not matching this record -- so this assertion fails one way or
    another if the encoding regresses."""
    record_type, rec_open_billing, rec_open_comma_value = composite_lookup_records
    page = client.records.lookup_records(
        type=record_type, field="status,area", values=["open", "billing,enterprise"],
    )
    ids = [r.id for r in (page.data or [])]
    assert rec_open_comma_value in ids, (
        "comma-bearing value must survive as one leg -- if this fails, the Python client "
        "is comma-joining `values` instead of repeating the query parameter"
    )
    assert rec_open_billing not in ids  # "billing" != "billing,enterprise"
