import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import pytest
from needle_mcp.config import AdapterConfig
from urllib.parse import urlparse

from needle_mcp.models import SourceInfo, TimeRange
from needle_mcp.tools.query_generic_source import query_generic_source, list_generic_sources, resolve_adapter


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


def test_redirect_to_a_different_configured_adapters_host_is_refused(mock_server, monkeypatch):
    """Credentials must not cross adapters on a redirect.

    Here 'localhost' IS in allowed_hosts — it stands for a second configured
    adapter, exactly as server._allowed_hosts() builds the union of every
    adapter's host. urllib carries request headers across redirects, so with a
    union-scoped redirect allowlist this request would follow the redirect and
    hand adapter A's Authorization header to adapter B's host. The redirect
    allowlist is therefore scoped to the single adapter being queried.
    """
    monkeypatch.setenv("SOURCE_A_TOKEN", "Bearer source-a-secret")
    adapter = _adapter_for(
        mock_server,
        name="source-a",
        auth_mode="static_header",
        auth_env_var="SOURCE_A_TOKEN",
        query_template="/redirect?q={query}&start={start}&end={end}",
    )
    _MockHandler.redirect_target_hit_count = 0
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        # The FULL allowlist, as server.py computes it: both adapters' hosts.
        allowed_hosts=["127.0.0.1", "localhost"],
    )
    assert result.error is not None
    assert "localhost" in result.error
    assert _MockHandler.redirect_target_hit_count == 0, (
        "adapter A's credentialed request reached adapter B's host"
    )


def test_pre_request_host_check_still_uses_the_full_allowlist(mock_server):
    """Scoping the REDIRECT allowlist must not narrow the pre-request check —
    an adapter whose own host is in the configured union still queries fine."""
    adapter = _adapter_for(mock_server)
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1", "localhost", "logs.other.internal"],
    )
    assert result.error is None
    assert result.returned_count == 1


# --- Credential handling (I4) -------------------------------------------------


def test_basic_auth_with_unset_env_vars_reports_the_env_var_not_an_empty_credential(mock_server, monkeypatch):
    """Sending Basic base64(":") gets a 401 from the vendor and leaves the
    operator debugging their query instead of their environment."""
    monkeypatch.delenv("NEEDLE_MCP_TEST_BASIC_USER", raising=False)
    monkeypatch.delenv("NEEDLE_MCP_TEST_BASIC_PASS", raising=False)
    adapter = _adapter_for(
        mock_server, auth_mode="basic",
        basic_user_env_var="NEEDLE_MCP_TEST_BASIC_USER",
        basic_pass_env_var="NEEDLE_MCP_TEST_BASIC_PASS",
    )
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.rows == []
    assert result.error is not None
    assert "NEEDLE_MCP_TEST_BASIC_USER" in result.error
    assert "Rejected param" not in result.error


def test_basic_auth_without_configured_env_var_names_the_missing_field(mock_server):
    adapter = _adapter_for(mock_server, auth_mode="basic")
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert "basic_user_env_var" in (result.error or "")


def test_basic_auth_succeeds_when_both_env_vars_are_set(mock_server, monkeypatch):
    monkeypatch.setenv("NEEDLE_MCP_TEST_BASIC_USER", "svc")
    monkeypatch.setenv("NEEDLE_MCP_TEST_BASIC_PASS", "hunter2")
    adapter = _adapter_for(
        mock_server, auth_mode="basic",
        basic_user_env_var="NEEDLE_MCP_TEST_BASIC_USER",
        basic_pass_env_var="NEEDLE_MCP_TEST_BASIC_PASS",
    )
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.error is None
    assert result.returned_count == 1


def test_static_header_missing_credential_is_not_reported_as_a_rejected_param(mock_server, monkeypatch):
    """The static_header path already failed loudly; it just failed with the
    wrong words — 'Rejected param' points at the query, not the environment."""
    monkeypatch.delenv("NEEDLE_MCP_TEST_TOKEN", raising=False)
    adapter = _adapter_for(mock_server, auth_mode="static_header", auth_env_var="NEEDLE_MCP_TEST_TOKEN")
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert "Rejected param" not in (result.error or "")
    assert "NEEDLE_MCP_TEST_TOKEN" in (result.error or "")
    assert "credential" in (result.error or "").lower()


def test_a_genuinely_rejected_param_still_says_rejected_param(mock_server):
    """The generic ValueError clause must keep its own, accurate message."""
    adapter = _adapter_for(mock_server)
    result = query_generic_source(
        adapter=adapter, params={"query": "//evil.example.com"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.error is not None and result.error.startswith("Rejected param")


def test_list_generic_sources_host_matches_the_allowlisted_host(mock_server):
    """list_generic_sources used to derive the host with
    base_url.split("://")[-1].split("/")[0], which KEEPS the port, while
    server._allowed_hosts uses urlparse().hostname, which drops it. The two
    disagreed for every adapter on a non-default port — the mock server here is
    exactly that case."""
    adapter = _adapter_for(mock_server)
    listed = list_generic_sources([adapter])[0]
    assert listed["base_url_host"] == urlparse(adapter.base_url).hostname == "127.0.0.1"
    assert ":" not in listed["base_url_host"]


def test_list_generic_sources_returns_the_source_info_shape(mock_server):
    adapter = _adapter_for(mock_server, covers=["k8s_pod"])
    listed = list_generic_sources([adapter])[0]
    assert listed == SourceInfo(**listed).model_dump()
    assert set(listed) == set(SourceInfo.model_fields)
