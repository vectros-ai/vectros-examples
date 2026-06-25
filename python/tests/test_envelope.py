"""
test_envelope.py — the paginated list envelope `{data, next_cursor}`.

This is a wire-contract guard: a list endpoint that regresses to a bare array (or
wraps/renames the envelope) crashes every consumer that unwraps `.data` / pages on
`.next_cursor`. The Python SDK deserializes each list response into a typed *Page
model — so a contract drift surfaces here as a deserialization error or a missing
attribute, on the real wire.
"""
from __future__ import annotations


def _assert_page(page):
    # `data` is always a list (possibly empty); `next_cursor` is an optional
    # opaque continuation token (None on the last page).
    assert hasattr(page, "data")
    assert isinstance(page.data, list)
    assert hasattr(page, "next_cursor")


def test_app_contexts_list_envelope(client):
    _assert_page(client.auth.list_app_contexts(limit=5))


def test_scoped_keys_list_envelope(client):
    _assert_page(client.auth.list_scoped_keys())


def test_records_list_envelope(client):
    _assert_page(client.records.list_records(type="any", limit=5))


def test_access_profiles_list_envelope(client):
    # access profiles are listed per-context; the default context always exists.
    _assert_page(client.auth.list_access_profiles("default", limit=5))


def test_next_cursor_paginates_when_present(client):
    """If a first page returns a next_cursor, feeding it back yields a valid
    next page (the envelope's continuation contract end-to-end)."""
    first = client.auth.list_app_contexts(limit=1)
    if first.next_cursor:
        second = client.auth.list_app_contexts(limit=1, start_from=first.next_cursor)
        assert isinstance(second.data, list)
