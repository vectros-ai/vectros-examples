"""
test_chat.py — POST /v1/chat streaming inference plus a RAG round-trip.

Verifies the streamed event sequence (content_delta+ then exactly one done),
the split-billing fields on the done payload, and scope enforcement before the
stream opens. The Python SDK exposes streaming endpoints as iterators of
discriminated-union events; support.collect_stream drains them for assertion.
"""
from __future__ import annotations

import pytest
import vectros

import support


def _join_deltas(events) -> str:
    return "".join(e.delta or "" for e in events if e.event == "content_delta")


# ANCHOR — streaming chat returns deltas then a done event with billing fields.
def test_chat_stream_deltas_then_done_with_billing(client):
    stream = client.inference.chat_inference(
        messages=[vectros.ChatMessage(role="user", content='Say "hello smoke test" exactly, no more.')],
        max_tokens=32,
    )
    events = support.collect_stream(stream)

    deltas = [e for e in events if e.event == "content_delta"]
    dones = [e for e in events if e.event == "done"]
    errors = [e for e in events if e.event == "error"]

    assert len(deltas) > 0
    assert len(dones) == 1
    assert len(errors) == 0

    done = dones[0]
    assert done.input_tokens > 0
    assert done.output_tokens > 0
    assert done.model
    assert done.platform_credits_charged > 0
    assert done.inference_balance_cents_charged >= 0


def test_chat_system_message_is_honored(client):
    marker = "SMOKE_SYS_PROBE"
    stream = client.inference.chat_inference(
        messages=[
            vectros.ChatMessage(role="system", content=f'Always begin your response with the literal string "{marker}".'),
            vectros.ChatMessage(role="user", content="Briefly state today is a good day."),
        ],
        max_tokens=60,
    )
    events = support.collect_stream(stream)
    assert len([e for e in events if e.event == "done"]) == 1
    assert marker in _join_deltas(events)


def test_chat_explicit_model_routes(client):
    model = "claude-haiku-4-5"  # known-available on the free plan
    stream = client.inference.chat_inference(
        messages=[vectros.ChatMessage(role="user", content="Reply with one word: ok")],
        model=model,
        max_tokens=8,
    )
    events = support.collect_stream(stream)
    dones = [e for e in events if e.event == "done"]
    assert len(dones) == 1
    # done.model is the resolved model — should reflect the requested alias.
    assert "haiku" in dones[0].model


def test_chat_without_inference_scope_is_403(client):
    minted = client.auth.mint_token(scope=vectros.ScopeRequest(allowed_actions=["records:r"]))
    scoped = support.make_client(minted.token)
    with pytest.raises(vectros.core.api_error.ApiError) as exc:
        # The 403 is raised when the stream is opened (the iterator is created).
        list(scoped.inference.chat_inference(
            messages=[vectros.ChatMessage(role="user", content="hi")],
            max_tokens=8,
        ))
    assert support.status_of(exc.value) == 403


def test_rag_round_trip(client):
    """A real RAG round-trip: search_results (optional) → content_delta+ → done.
    Asserts the streamed RAG envelope holds end-to-end over the wire."""
    stream = client.inference.rag_inference(
        query="What is a smoke test?",
        search=vectros.RagSearch(mode="HYBRID", limit=3),
        max_tokens=48,
    )
    events = support.collect_stream(stream)
    dones = [e for e in events if e.event == "done"]
    errors = [e for e in events if e.event == "error"]
    assert len(errors) == 0
    assert len(dones) == 1
