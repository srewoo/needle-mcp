import asyncio
import json
import textwrap
from pathlib import Path

from rcanalyst import server
from rcanalyst.server import METHODOLOGY_URI, mcp

REPO_ROOT = Path(__file__).resolve().parent.parent


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


def test_server_instructions_state_the_load_bearing_guidance():
    """The old assertion was `"vendor MCP" in x or "vendor" in x.lower()` — the
    second clause subsumes the first, so it passed on any text containing the
    word "vendor" anywhere. These are the four things INSTRUCTIONS has to carry
    on a host that reads nothing else: prefer a sibling vendor MCP, the two
    entry points, and both envelope sentinels."""
    text = mcp.instructions
    assert "query_generic_source" in text and "ONLY when no such vendor MCP" in text
    assert "plan_investigation" in text and "correlate_ids" in text
    assert "validate_rca" in text
    assert "BEGIN_RCANALYST_RESULT_JSON" in text and "END_RCANALYST_RESULT_JSON" in text


# --- Methodology delivery on non-Claude-Code hosts (spec §3) ------------------
#
# Claude Code loads skills/rca-methodology/SKILL.md through the plugin. Every
# other host (Claude Desktop, claude.ai) can only receive the methodology as an
# MCP prompt or resource; the ~11-line `instructions` string names the sentinels
# but carries neither the envelope schema nor the five rules, so without these
# registrations such a session cannot emit a valid envelope at all.


def test_methodology_prompt_is_listed():
    prompts = asyncio.run(mcp.list_prompts())
    assert "rca_methodology" in {p.name for p in prompts}


def test_methodology_resource_is_listed():
    resources = asyncio.run(mcp.list_resources())
    assert METHODOLOGY_URI in {str(r.uri) for r in resources}


def test_methodology_resource_body_carries_the_envelope_contract():
    contents = asyncio.run(mcp.read_resource(METHODOLOGY_URI))
    body = "".join(c.content for c in contents)
    assert "BEGIN_RCANALYST_RESULT_JSON" in body
    assert "END_RCANALYST_RESULT_JSON" in body


def test_methodology_prompt_and_resource_share_one_source_of_truth():
    prompt_result = asyncio.run(mcp.get_prompt("rca_methodology", {}))
    prompt_body = "".join(
        m.content.text for m in prompt_result.messages if hasattr(m.content, "text")
    )
    resource_body = "".join(c.content for c in asyncio.run(mcp.read_resource(METHODOLOGY_URI)))
    assert prompt_body == resource_body
    assert prompt_body == (REPO_ROOT / "skills" / "rca-methodology" / "SKILL.md").read_text()


def test_methodology_text_degrades_when_the_skill_file_is_missing(monkeypatch, tmp_path):
    """A missing skill file must not crash the server on a prompt/resource read."""
    monkeypatch.setattr(server, "METHODOLOGY_CANDIDATES", (tmp_path / "nope" / "SKILL.md",))
    text = server._methodology_text()
    assert "BEGIN_RCANALYST_RESULT_JSON" in text


def test_methodology_path_does_not_depend_on_cwd(monkeypatch, tmp_path):
    """An MCP server inherits an unpredictable cwd; resolution must not use it."""
    monkeypatch.chdir(tmp_path)
    assert "BEGIN_RCANALYST_RESULT_JSON" in server._methodology_text()


# --- Arguments as they arrive over the wire ----------------------------------
#
# FastMCP's func_metadata pre-parses a string argument whose contents parse as
# JSON, so by the time pydantic validates, a HAR passed as text is already a
# dict. Every other test for this tool calls the pure function in-process and
# so never sees that coercion; only a call through mcp.call_tool does.

_WIRE_HAR = {
    "log": {
        "entries": [
            {
                "request": {
                    "method": "GET",
                    "url": "https://api.example.com/checkout",
                    "headers": [{"name": "x-request-id", "value": "req-wire-1"}],
                },
                "response": {"status": 503},
                "time": 42,
                "startedDateTime": "2026-09-15T10:00:00Z",
            }
        ]
    }
}


def test_analyze_visual_evidence_accepts_har_json_as_text_over_the_wire():
    parsed = _call("analyze_visual_evidence", {"context": "", "har_json": json.dumps(_WIRE_HAR)})
    assert len(parsed["har_entries"]) == 1
    assert parsed["har_entries"][0]["status"] == 503
    assert parsed["har_entries"][0]["timestamp"] == "2026-09-15T10:00:00Z"
    assert parsed["har_entries"][0]["correlation_headers"]["x-request-id"] == "req-wire-1"


def test_analyze_visual_evidence_accepts_har_json_as_an_object_over_the_wire():
    parsed = _call("analyze_visual_evidence", {"context": "", "har_json": _WIRE_HAR})
    assert parsed["har_entries"][0]["status"] == 503


def test_analyze_visual_evidence_har_path_still_works_over_the_wire(tmp_path):
    har_file = tmp_path / "wire.har"
    har_file.write_text(json.dumps(_WIRE_HAR))
    parsed = _call("analyze_visual_evidence", {"context": "", "har_path": str(har_file)})
    assert parsed["har_entries"][0]["status"] == 503


def test_validate_rca_accepts_a_structured_claim_over_the_wire():
    """claim_json is dict-typed, so FastMCP's pre-parse is harmless here — but
    verified by an actual dispatch rather than by reasoning about it."""
    parsed = _call("validate_rca", {"claim_json": {
        "confidence": "inconclusive", "status": "inconclusive",
        "root_cause": "no cause established", "affected_services": ["checkout"],
        "environment": "prod",
        "alert_window": {"start": "2026-09-15T10:00:00Z", "end": "2026-09-15T10:10:00Z"},
        "evidence": [],
    }})
    assert parsed["approved"] is True


def test_query_generic_source_accepts_dict_params_over_the_wire(monkeypatch, tmp_path):
    """params is dict-typed; confirm the unknown-source path is reached rather
    than an argument-validation error."""
    monkeypatch.setenv("RCANALYST_CONFIG_DIR", str(tmp_path))
    parsed = _call("query_generic_source", {
        "source": "nope", "params": {"query": "checkout"},
        "start": "2026-09-15T10:00:00Z", "end": "2026-09-15T10:10:00Z",
    })
    assert "Unknown source" in parsed["error"]
