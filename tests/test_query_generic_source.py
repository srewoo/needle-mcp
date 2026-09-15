import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import pytest
from rcanalyst.config import AdapterConfig
from rcanalyst.models import TimeRange
from rcanalyst.tools.query_generic_source import query_generic_source, list_generic_sources, resolve_adapter


class _MockHandler(BaseHTTPRequestHandler):
    requested_paths: list[str] = []
    redirect_target_hit_count = 0

    def do_GET(self):
        type(self).requested_paths.append(self.path)
        if self.path.startswith("/redirect-target"):
            # Should never be reached — the redirect target is off-allowlist
            # ("localhost" != "127.0.0.1") and must be blocked before contact.
            type(self).redirect_target_hit_count += 1
            body = json.dumps({"rows": [{"line": "should-not-be-reached"}]})
        elif self.path.startswith("/redirect"):
            self.send_response(302)
            port = self.server.server_address[1]
            self.send_header("Location", f"http://localhost:{port}/redirect-target")
            self.end_headers()
            return
        elif "/scalar" in self.path:
            body = json.dumps("just-a-string")
        elif "cursor=page2" in self.path:
            body = json.dumps({"rows": [{"line": "row-page-2"}]})
        elif "/big" in self.path:
            body = json.dumps({"rows": [{"line": f"row-{i}"} for i in range(50)]})
        else:
            body = json.dumps({"rows": [{"line": "row-1"}], "next_cursor": "page2"})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, format, *args):
        pass


@pytest.fixture(scope="module")
def mock_server():
    server = HTTPServer(("127.0.0.1", 0), _MockHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()


def _adapter_for(mock_server, **overrides) -> AdapterConfig:
    port = mock_server.server_address[1]
    defaults = dict(
        name="test-source",
        base_url=f"http://127.0.0.1:{port}",
        auth_mode="none",
        query_template="/search?q={query}&start={start}&end={end}",
        response_path="rows",
        pagination_cursor_field="next_cursor",
        pagination_cursor_param="cursor",
        max_rows_per_call=200,
    )
    defaults.update(overrides)
    return AdapterConfig(**defaults)


def test_query_generic_source_returns_rows(mock_server):
    adapter = _adapter_for(mock_server)
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.error is None
    assert result.rows == [{"line": "row-1"}]
    assert result.next_cursor == "page2"


def test_query_generic_source_flags_truncated_when_cursor_present(mock_server):
    adapter = _adapter_for(mock_server)
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.truncated is True


def test_query_generic_source_rejects_disallowed_host(mock_server):
    adapter = _adapter_for(mock_server)
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["some-other-host.internal"],
    )
    assert result.error is not None
    assert "not in the configured allowlist" in result.error


def test_query_generic_source_accepts_url_valued_query(mock_server):
    """Searching logs FOR a URL must work — the param is encoded, and structural
    safety is enforced on the built URL, not by banning substrings."""
    adapter = _adapter_for(mock_server)
    result = query_generic_source(
        adapter=adapter, params={"query": "https://api.example.com/checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.error is None
    assert result.rows == [{"line": "row-1"}]


def test_query_generic_source_reports_missing_template_placeholder(mock_server):
    adapter = _adapter_for(mock_server, query_template="/search?q={query}&team={team}")
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},  # 'team' not supplied
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.error is not None
    assert "placeholder not satisfied" in result.error


def test_query_generic_source_respects_max_rows_per_call(mock_server):
    adapter = _adapter_for(mock_server, query_template="/big?q={query}", max_rows_per_call=10)
    result = query_generic_source(
        adapter=adapter, params={"query": "x"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.returned_count == 10
    assert result.truncated is True


def test_list_generic_sources_shape(mock_server):
    adapter = _adapter_for(mock_server, covers=["k8s_pod"])
    out = list_generic_sources([adapter])
    assert out[0]["name"] == "test-source"
    assert out[0]["covers"] == ["k8s_pod"]
    assert "auth_mode" in out[0]


def test_query_generic_source_encodes_start_end_against_injection(mock_server):
    """start/end are model-supplied, exactly as untrusted as params. An
    unencoded '&admin=true' suffix must not inject an extra query parameter
    into the request actually sent."""
    adapter = _adapter_for(mock_server)
    injected_start = "2026-09-15T00:00:00Z&admin=true"
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start=injected_start, end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.error is None
    last_path = _MockHandler.requested_paths[-1]
    assert "&admin=true" not in last_path
    assert "%26admin%3Dtrue" in last_path


def test_query_generic_source_next_cursor_none_on_final_page(mock_server):
    adapter = _adapter_for(mock_server)
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
        cursor="page2",
    )
    assert result.error is None
    assert result.next_cursor is None


def test_query_generic_source_blocks_off_allowlist_redirect_before_contact(mock_server):
    """The redirect target host is 'localhost', which is not in allowed_hosts
    (only the literal '127.0.0.1' is). This must be rejected by
    _AllowlistRedirectHandler.redirect_request BEFORE the redirect target is
    ever contacted — proven here by asserting its hit counter stays at 0."""
    adapter = _adapter_for(mock_server, query_template="/redirect?q={query}&start={start}&end={end}")
    _MockHandler.redirect_target_hit_count = 0
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.error is not None
    assert "localhost" in result.error
    assert _MockHandler.redirect_target_hit_count == 0


def test_resolve_adapter_finds_matching_name(mock_server):
    adapter = _adapter_for(mock_server, name="my-source")
    other = _adapter_for(mock_server, name="other-source")
    assert resolve_adapter("my-source", [other, adapter]) is adapter


def test_resolve_adapter_returns_none_on_miss(mock_server):
    adapter = _adapter_for(mock_server, name="my-source")
    assert resolve_adapter("nonexistent", [adapter]) is None


def test_query_generic_source_scalar_payload_does_not_crash(mock_server):
    """A backend returning a bare JSON scalar (valid JSON, not dict/list) must
    not raise AttributeError from .get() calls — it must come back as a clean
    structured result with no rows and no cursor."""
    adapter = _adapter_for(mock_server, query_template="/scalar?q={query}&start={start}&end={end}")
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.error is None
    assert result.rows == []
    assert result.next_cursor is None
