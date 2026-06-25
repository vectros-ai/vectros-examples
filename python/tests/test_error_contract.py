"""
test_error_contract.py — the Vectros API error response contract.

A malformed request body must come back as a clean 4xx with a JSON error envelope
(message + requestId), never a 5xx whose body is non-JSON or leaks server
internals. These tests go around the SDK (raw urllib via support.raw_post) — the
SDK's typed surface would reject the deliberately malformed bodies at call time,
but the API contract must hold against any well-formed HTTP request with a
malformed JSON body.
"""
from __future__ import annotations

import json

import support


# A malformed schema body: lookupFields should be [{field_name, unique}], not a
# bare string array. The API must reject it with a clean 4xx error envelope.
_MALFORMED_SCHEMA_BODY = json.dumps(
    {"recordType": "task", "displayName": "Task", "lookupFields": ["externalId"]}
)


def test_malformed_body_is_4xx_never_5xx():
    r = support.raw_post("/v1/schemas", _MALFORMED_SCHEMA_BODY)
    assert 400 <= r.status < 500, f"expected 4xx, got {r.status}"
    assert isinstance(r.parsed.get("message"), str)
    assert len(r.parsed["message"]) > 0


def test_response_body_parses_without_control_chars():
    r = support.raw_post("/v1/schemas", _MALFORMED_SCHEMA_BODY)
    # support.raw_post already json.loads()'d it (would have raised otherwise);
    # re-assert parseability + scan the wire bytes for raw control chars.
    json.loads(r.raw_body)
    assert all(ord(ch) >= 0x20 or ch in "\t\n\r" for ch in r.raw_body)


def test_error_body_carries_message_and_request_id():
    r = support.raw_post("/v1/schemas", _MALFORMED_SCHEMA_BODY)
    assert isinstance(r.parsed.get("message"), str)
    # requestId is your hook to ask support to look up logs — present on any real
    # live request.
    assert r.parsed.get("requestId"), "expected a non-empty requestId"


def test_error_body_does_not_leak_server_internals():
    r = support.raw_post("/v1/schemas", _MALFORMED_SCHEMA_BODY)
    for marker in ("com.fasterxml", "MismatchedInput", "JsonMappingException", "[Source:"):
        assert marker not in r.raw_body, f"error body leaked internal marker: {marker}"


def test_completely_broken_json_still_clean_4xx():
    r = support.raw_post("/v1/schemas", "{this is not even close to valid JSON")
    assert 400 <= r.status < 500, f"expected 4xx, got {r.status}"
    assert isinstance(r.parsed.get("message"), str)
