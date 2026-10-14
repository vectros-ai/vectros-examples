"""
test_sse_comment_frames.py — the streaming inference routes may interleave SSE
comment lines (a line that starts with a colon) with events. A comment never
dispatches an event, so a reader must yield exactly the same events with and
without them.

This one needs no credentials and no network: it serves a canned event stream
from a local HTTP server and drives the real SDK stream reader against it, with
comment frames before the first event, between events, and right before `done`.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import List

import httpx
import pytest
from vectros import VectrosApi

COMMENT = ": keepalive\n\n"


def _frame(event_type: str, **payload) -> str:
    body = json.dumps({"type": event_type, "event": event_type, **payload})
    return f"event: {event_type}\ndata: {body}\n\n"


EVENT_FRAMES: List[str] = [
    _frame("content_delta", delta="Hello, "),
    _frame("content_delta", delta="world"),
    _frame(
        "done",
        inputTokens=11,
        outputTokens=7,
        model="m",
        platformCreditsCharged=0,
        inferenceBalanceCentsCharged=0,
    ),
]

WITH_COMMENTS: List[str] = [
    COMMENT,
    EVENT_FRAMES[0],
    COMMENT,
    COMMENT,
    EVENT_FRAMES[1],
    COMMENT,
    EVENT_FRAMES[2],
]


@pytest.fixture()
def serve():
    servers: List[ThreadingHTTPServer] = []

    def start(chunks: List[str]) -> str:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - http.server API
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                for chunk in chunks:
                    self.wfile.write(chunk.encode("utf-8"))
                    self.wfile.flush()

            def log_message(self, *args):  # keep test output quiet
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{server.server_address[1]}"

    yield start
    for server in servers:
        server.shutdown()
        server.server_close()


def _events(base_url: str) -> List[dict]:
    client = VectrosApi(base_url=base_url, token="sk_test", max_retries=0)
    stream = client.inference.chat_inference(
        messages=[{"role": "user", "content": "hi"}], max_tokens=16
    )
    return [event.model_dump() for event in stream]


def test_comment_frames_do_not_change_the_event_sequence(serve):
    baseline = _events(serve(EVENT_FRAMES))
    with_comments = _events(serve(WITH_COMMENTS))

    assert [e["type"] for e in baseline] == ["content_delta", "content_delta", "done"]
    assert with_comments == baseline


def test_a_stream_of_comments_then_done_completes(serve):
    events = _events(serve([COMMENT, COMMENT, EVENT_FRAMES[2]]))

    assert [e["type"] for e in events] == ["done"]


class _Pieces(httpx.SyncByteStream):
    """A response body delivered as exactly these reads, so a split lands where the test says."""

    def __init__(self, pieces: List[str]):
        self._pieces = pieces

    def __iter__(self):
        for piece in self._pieces:
            yield piece.encode("utf-8")


def _events_in_pieces(pieces: List[str]) -> List[dict]:
    def respond(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=_Pieces(pieces))

    client = VectrosApi(
        base_url="http://stub.invalid",
        token="sk_test",
        max_retries=0,
        httpx_client=httpx.Client(transport=httpx.MockTransport(respond)),
    )
    stream = client.inference.chat_inference(
        messages=[{"role": "user", "content": "hi"}], max_tokens=16
    )
    return [event.model_dump() for event in stream]


def test_comment_frames_split_across_reads_at_any_byte_are_still_ignored():
    baseline = _events_in_pieces(EVENT_FRAMES)
    wire = "".join(WITH_COMMENTS)
    assert [e["type"] for e in baseline] == ["content_delta", "content_delta", "done"]

    # size 1 puts the colon, the text and each newline of a comment in separate reads;
    # 13 is the comment's own length
    for size in (1, 2, 3, 7, 13):
        pieces = [wire[i:i + size] for i in range(0, len(wire), size)]
        assert _events_in_pieces(pieces) == baseline, f"read size {size}"

    # the blank line that ends a comment arriving on its own, after the comment text
    awkward = [": keepalive\n", "\n", *EVENT_FRAMES[:2], ": keep", "alive\n\n", EVENT_FRAMES[2]]
    assert _events_in_pieces(awkward) == baseline
