import asyncio
import json
import textwrap
from rcanalyst.server import mcp


def _call(tool_name: str, arguments: dict):
    """Invoke a registered tool through FastMCP dispatch and return its
    payload as plain Python data, exactly as a real MCP client would receive
    it. FastMCP returns either a bare list of TextContent blocks (dict-typed
    tool returns) or a (content_blocks, structured_dict) tuple (list-typed
    tool returns, which get an output schema) -- handle both."""
    result = asyncio.run(mcp.call_tool(tool_name, arguments))
    if isinstance(result, tuple):
        _content, structured = result
        return structured.get("result", structured)
    return json.loads(result[0].text)


def test_all_expected_tools_are_registered():
    tools = asyncio.run(mcp.list_tools())
    names = {t.name for t in tools}
    assert names == {
        "correlate_ids", "analyze_visual_evidence", "query_generic_source",
        "list_generic_sources", "get_coverage", "validate_rca",
        "plan_investigation",
    }


def test_correlate_ids_tool_returns_plain_dict():
    result = asyncio.run(mcp.call_tool("correlate_ids", {"evidence_snippets": ["x-request-id=req-1"]}))
    # FastMCP wraps tool results in content blocks; assert it ran without error.
    assert result is not None


def test_correlate_ids_wrapper_surfaces_the_known_id():
    parsed = _call("correlate_ids", {"evidence_snippets": ["x-request-id=req-12345"]})
    assert parsed["candidates"][0]["value"] == "req-12345"


def test_get_coverage_wrapper_flags_unknown_resource_type(monkeypatch, tmp_path):
    # No topology.yaml at all under this config dir -> load_topology returns an
    # empty TopologyFile -> every resource type is unknown_coverage=True.
    monkeypatch.setenv("RCANALYST_CONFIG_DIR", str(tmp_path))
    parsed = _call("get_coverage", {"resource_type": "airflow_task"})
    assert parsed["unknown_coverage"] is True


def test_validate_rca_wrapper_rejects_an_empty_claim():
    parsed = _call("validate_rca", {"claim_json": {}})
    assert parsed["approved"] is False
    assert parsed["gaps"][0]["name"] == "format-violation"


def test_plan_investigation_wrapper_classifies_a_uuid(monkeypatch, tmp_path):
    monkeypatch.setenv("RCANALYST_CONFIG_DIR", str(tmp_path))
    parsed = _call("plan_investigation", {"identifier": "550e8400-e29b-41d4-a716-446655440000"})
    assert parsed["identifier_kind"] == "uuid"


def test_analyze_visual_evidence_wrapper_returns_empty_entries_on_empty_input():
    parsed = _call("analyze_visual_evidence", {"context": "no evidence supplied"})
    assert parsed["har_entries"] == []


def test_list_generic_sources_wrapper_returns_a_list(monkeypatch, tmp_path):
    monkeypatch.setenv("RCANALYST_CONFIG_DIR", str(tmp_path))
    parsed = _call("list_generic_sources", {})
    assert isinstance(parsed, list)
    assert parsed == []


def test_query_generic_source_wrapper_reports_unknown_source(monkeypatch, tmp_path):
    monkeypatch.setenv("RCANALYST_CONFIG_DIR", str(tmp_path))
    parsed = _call("query_generic_source", {
        "source": "nonexistent-source", "params": {},
        "start": "2026-09-15T00:00:00Z", "end": "2026-09-15T01:00:00Z",
    })
    assert "Unknown source 'nonexistent-source'" in parsed["error"]


def test_config_dir_resolves_adapters_path_under_env_var(monkeypatch, tmp_path):
    """RCANALYST_CONFIG_DIR is safety-critical: an MCP server launched as a
    subprocess inherits an unpredictable cwd, so this must actually be honored
    at call time, not baked in at import time."""
    monkeypatch.setenv("RCANALYST_CONFIG_DIR", str(tmp_path))
    (tmp_path / "adapters.yaml").write_text(textwrap.dedent("""\
        sources:
          - name: my-source
            base_url: http://example.internal
            query_template: /search?q={query}
    """))
    parsed = _call("list_generic_sources", {})
    assert parsed == [{
        "name": "my-source",
        "base_url_host": "example.internal",
        "auth_mode": "none",
        "covers": [],
    }]


def test_server_has_instructions_mentioning_sibling_mcps():
    assert "vendor MCP" in mcp.instructions or "vendor" in mcp.instructions.lower()
