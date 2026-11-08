"""
test_stream_tolerance.py — what the SDK's stream decoder does with an event or field it does not know.

The API adds event types and fields over time, and a client written today must keep working when the
stream carries one it has never seen. This replays raw server-sent-event streams
(fixtures/sse-tolerance/scenarios.json, shared with the TypeScript and Java SDK suites) through the
REAL generated decoder of the installed SDK and pins the outcome: which events are delivered,
whether an unknown field survives on a known event, how many warnings the SDK logs, and whether the
call raises. The decoder is generated code, so a generator or SDK upgrade can change this silently; a
change here is a change customers will see.

Offline: a loopback server stands in for the API, so it needs no credentials and no network.

To re-measure after an intended change, run with TOLERANCE_RECORD=1: it prints the actual outcome of
every scenario as JSON instead of asserting, and the result is pasted into the fixture file's
`expect.python` entries.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest
import vectros

# The shared fixtures live beside this suite in the repository. A checkout that carries only this
# directory (the published examples) has none: the suite then skips, saying so. Inside the repository
# (recognised by the example assembler beside the smoke tests) a missing fixture is a failure.
_HERE = Path(__file__).resolve()
_FIXTURE_FILE = _HERE.parents[2] / "fixtures" / "sse-tolerance" / "scenarios.json"
_IN_REPOSITORY = (_HERE.parents[3] / "pipelines" / "examples-assemble.sh").exists()
FIXTURES = json.loads(_FIXTURE_FILE.read_text(encoding="utf-8")) if _FIXTURE_FILE.exists() else {"scenarios": []}
RECORD = os.environ.get("TOLERANCE_RECORD") == "1"
ROUTES = {"chat": "/v1/chat", "rag": "/v1/rag", "document-ask": "/v1/documents/doc-1/ask"}
_recorded: dict = {}


def _handler_for(scenario: dict):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):  # keep test output quiet
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            if self.path != ROUTES[scenario["route"]]:
                body = b'{"message":"unexpected route"}'
                self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            raw = "".join(scenario["chunks"]).encode("utf-8")
            size = scenario.get("chunkBytes")
            pieces = (
                [raw[i : i + size] for i in range(0, len(raw), size)]
                if size
                else [c.encode("utf-8") for c in scenario["chunks"]]
            )
            for piece in pieces:
                self.wfile.write(b"%x\r\n" % len(piece) + piece + b"\r\n")
                self.wfile.flush()
                time.sleep(0.002)
            if scenario["close"] == "abrupt":
                self.close_connection = True
                self.connection.close()  # no terminating chunk: the response is cut
            else:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()

    return Handler


def _splits_inside_character(raw: bytes, size: int) -> bool:
    """Whether any write boundary falls inside a multi-byte UTF-8 character (on a continuation byte)."""
    return any((raw[i] & 0xC0) == 0x80 for i in range(size, len(raw), size))


class _Warnings(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.count = 0

    def emit(self, record):
        self.count += 1


def _open(client, route: str):
    if route == "chat":
        return client.inference.chat_inference(messages=[vectros.ChatMessage(role="user", content="hi")])
    if route == "rag":
        return client.inference.rag_inference(query="q")
    return client.inference.document_ask("doc-1", prompt="q")


def _probe(events: list, extras: list, probe: dict):
    """True or False for whether the field survived on that delivered event; None when none was delivered."""
    hits = [i for i, e in enumerate(events) if getattr(e, "type", None) == probe["event"]]
    return probe["field"] in extras[hits[probe["nth"]]] if len(hits) > probe["nth"] else None


def _run(scenario: dict) -> dict:
    if scenario.get("splitsMultiByte"):
        # The scenario exists to cut a character across writes: fail loudly if its chunking does not.
        raw = "".join(scenario["chunks"]).encode("utf-8")
        assert _splits_inside_character(raw, scenario.get("chunkBytes") or len(raw))
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_for(scenario))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    warnings = _Warnings()
    root = logging.getLogger()
    root.addHandler(warnings)
    events: list = []
    error = None
    # trust_env=False: a proxy named in the environment must not stand between the test and loopback.
    http = httpx.Client(trust_env=False)
    try:
        client = vectros.VectrosApi(
            base_url=f"http://127.0.0.1:{server.server_address[1]}", token="unused", httpx_client=http
        )
        for ev in _open(client, scenario["route"]):
            events.append(ev)
    except Exception as e:  # noqa: BLE001 - the class of whatever the SDK raises is the observation
        error = type(e).__name__
    finally:
        http.close()
        root.removeHandler(warnings)
        server.shutdown()
        server.server_close()
    extras = [set(getattr(e, "model_extra", None) or {}) for e in events]
    return {
        "delivered": [str(getattr(e, "type", None)) for e in events],
        "text": "".join(getattr(e, "delta", None) or "" for e in events if getattr(e, "type", None) == "content_delta"),
        "probes": [_probe(events, extras, p) for p in scenario.get("probes", [])],
        "warnings": warnings.count,
        "error": error,
    }


def test_fixtures_are_present():
    if _FIXTURE_FILE.exists():
        return
    if _IN_REPOSITORY:
        pytest.fail(f"the shared stream fixtures are missing from this repository checkout: {_FIXTURE_FILE}")
    pytest.skip("the shared stream fixtures are not part of this checkout, so there is nothing to replay")


@pytest.mark.parametrize("scenario", FIXTURES["scenarios"], ids=lambda s: s["id"])
def test_stream_tolerance(scenario):
    actual = _run(scenario)
    if RECORD:
        _recorded[scenario["id"]] = actual
        return
    assert scenario["expect"]["python"] is not None, "no pinned outcome: record one with TOLERANCE_RECORD=1"
    assert actual == scenario["expect"]["python"]


@pytest.fixture(scope="module", autouse=True)
def _print_recording():
    yield
    if RECORD:
        print("TOLERANCE_RECORD python " + json.dumps(_recorded))
