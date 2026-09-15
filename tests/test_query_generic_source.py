import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import pytest
from rcanalyst.config import AdapterConfig
from rcanalyst.models import TimeRange
from rcanalyst.tools.query_generic_source import query_generic_source, list_generic_sources


class _MockHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if "cursor=page2" in self.path:
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
