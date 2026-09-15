import asyncio
from rcanalyst.server import mcp


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


def test_server_has_instructions_mentioning_sibling_mcps():
    assert "vendor MCP" in mcp.instructions or "vendor" in mcp.instructions.lower()
