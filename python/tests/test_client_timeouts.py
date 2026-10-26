"""
make_client gives every request an explicit read and connect timeout.

Offline: nothing here opens a socket. A smoke that waited on httpx's default (5 s per phase, which the
SDK also adopts as its per-request timeout when it is handed a client of its own) could neither wait
long enough for a slow call nor fail fast on an unreachable host.
"""
import httpx
import pytest

import support


@pytest.fixture
def captured(monkeypatch):
    monkeypatch.setenv("VECTROS_API_BASE_URL", "https://api.example.invalid")
    seen = {}

    def fake_api(**kwargs):
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(support, "VectrosApi", fake_api)
    support.make_client("sk_test")
    return seen


def test_the_sdk_is_given_an_explicit_request_timeout(captured):
    assert captured["timeout"] == 60.0 == support.READ_TIMEOUT_S


def test_the_http_client_has_explicit_read_and_connect_timeouts(captured):
    t = captured["httpx_client"].timeout
    assert (t.read, t.connect) == (60.0, 10.0)
    assert t.write == 60.0 and t.pool == 60.0


def test_the_client_uses_the_rate_limit_aware_transport(captured):
    assert captured["max_retries"] == 0
    assert isinstance(captured["httpx_client"]._transport, support._RateLimitAwareTransport)


@pytest.mark.parametrize(
    "sdk_value, expected_connect",
    [
        ({"connect": 60.0, "read": 60.0, "write": 60.0, "pool": 60.0}, 10.0),  # what the SDK sends: one float for every phase
        ({"connect": 3.0, "read": 60.0, "write": 60.0, "pool": 60.0}, 3.0),   # a tighter caller value is kept
        ({"read": 60.0}, 10.0),                                                  # no connect at all
        (None, 10.0),                                                            # no timeout extension at all
    ],
)
def test_connect_is_bounded_whatever_the_sdk_sends(sdk_value, expected_connect):
    request = httpx.Request("GET", "https://api.example.invalid/x")
    if sdk_value is not None:
        request.extensions["timeout"] = sdk_value
    support._bound_connect_timeout(request)
    got = request.extensions["timeout"]
    assert got["connect"] == expected_connect
    if sdk_value and "read" in sdk_value:
        assert got["read"] == 60.0


def test_the_transport_applies_the_connect_bound_before_sending(monkeypatch):
    sent = {}

    def fake_send(self, request):
        sent["connect"] = request.extensions["timeout"]["connect"]
        return httpx.Response(200, request=request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_send)
    request = httpx.Request("GET", "https://api.example.invalid/x")
    request.extensions["timeout"] = {"connect": 60.0, "read": 60.0, "write": 60.0, "pool": 60.0}
    support._RateLimitAwareTransport().handle_request(request)
    assert sent["connect"] == 10.0


def test_raw_post_has_a_timeout(monkeypatch):
    """The raw urllib path carries an explicit timeout instead of waiting forever on an unresponsive API."""
    monkeypatch.setenv("VECTROS_API_BASE_URL", "https://api.example.invalid")
    monkeypatch.setenv("VECTROS_API_KEY", "sk_test")
    seen = {}

    class _Resp:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"{}"

    def fake_urlopen(req, *args, **kwargs):
        seen["args"], seen["kwargs"] = args, kwargs
        return _Resp()

    monkeypatch.setattr(support.urllib.request, "urlopen", fake_urlopen)
    support.raw_post("/v1/x", "{}")
    assert seen["kwargs"].get("timeout") == support.READ_TIMEOUT_S


def test_no_smoke_calls_urlopen_without_a_timeout():
    """A census, so no urllib call can hang a smoke: every call to urlopen in this suite names its timeout."""
    import pathlib
    import re

    root = pathlib.Path(__file__).resolve().parent.parent
    offenders = []
    for f in sorted(root.rglob("*.py")):
        if f.name == pathlib.Path(__file__).name or ".venv" in f.parts or "node_modules" in f.parts:
            continue
        text = f.read_text(encoding="utf-8")
        for m in re.finditer(r"urlopen[(]", text):
            end = text.find(chr(10), m.start())
            call = text[m.start(): end if end >= 0 else len(text)]
            if "timeout=" not in call:
                offenders.append(f"{f.relative_to(root)}: {call.strip()}")
    assert not offenders, offenders


def test_the_real_generated_client_carries_the_timeouts(monkeypatch):
    """The cases above stub VectrosApi: this one builds the REAL generated client and reads the timeouts off it, so a change in how the SDK
    takes a timeout (a renamed argument, a client wrapper that stops reading the httpx client's) fails here instead of going unnoticed."""
    monkeypatch.setenv("VECTROS_API_BASE_URL", "https://api.example.invalid")
    client = support.make_client("sk_test")
    wrapper = client._client_wrapper
    assert wrapper.get_timeout() == 60.0
    t = wrapper.httpx_client.httpx_client.timeout
    assert (t.read, t.connect) == (60.0, 10.0)
