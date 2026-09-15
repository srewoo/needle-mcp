from __future__ import annotations
import logging
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

logging.basicConfig(stream=sys.stderr, level=logging.INFO)
logger = logging.getLogger("rcanalyst")

from mcp.server.fastmcp import FastMCP  # noqa: E402

from rcanalyst.config import load_adapters, load_topology, AdaptersFile  # noqa: E402
from rcanalyst.models import GenericQueryResult, TimeRange  # noqa: E402
from rcanalyst.tools.correlate_ids import correlate_ids as _correlate_ids  # noqa: E402
from rcanalyst.tools.analyze_visual_evidence import analyze_visual_evidence as _analyze_visual_evidence  # noqa: E402
from rcanalyst.tools.query_generic_source import (  # noqa: E402
    query_generic_source as _query_generic_source,
    list_generic_sources as _list_generic_sources,
    resolve_adapter as _resolve_adapter,
)
from rcanalyst.tools.get_coverage import get_coverage as _get_coverage  # noqa: E402
from rcanalyst.tools.plan_investigation import plan_investigation as _plan_investigation  # noqa: E402
from rcanalyst.tools.validate_rca import validate_rca as _validate_rca  # noqa: E402

INSTRUCTIONS = (
    "rcAnalyst provides RCA building-block tools for a Claude session "
    "investigating an incident. It has no orchestration logic of its own — "
    "read the rca-methodology skill/prompt before using these tools. Prefer "
    "your own already-connected vendor MCP (Datadog, Splunk, GitLab, "
    "Sourcegraph, etc.) for logs, metrics, and code; use query_generic_source "
    "ONLY when no such vendor MCP covers the source in question. "
    "Starting from a bare identifier (session/request/trace id) with no logs "
    "yet? Call plan_investigation first. Already holding log snippets? Use "
    "correlate_ids. Finish by calling validate_rca, and emit the envelope "
    "fenced between BEGIN_RCANALYST_RESULT_JSON and END_RCANALYST_RESULT_JSON."
)

# An MCP server launched as a subprocess by Claude Desktop/Code inherits an
# unpredictable cwd (often "/"), so cwd-relative config would silently never
# resolve. RCANALYST_CONFIG_DIR is the documented knob; CLAUDE_PROJECT_DIR is
# injected by Claude Code and is the sensible default for plugin installs.
#
# Resolved at CALL time, not import time: env vars (RCANALYST_CONFIG_DIR in
# particular) can legitimately differ between calls in tests, and the project's
# config loaders (load_adapters/load_topology) already re-read from disk on
# every call by the same stateless design.
def _config_dir() -> Path:
    return Path(
        os.environ.get("RCANALYST_CONFIG_DIR")
        or os.environ.get("CLAUDE_PROJECT_DIR")
        or Path.cwd()
    )


def _adapters_path() -> Path:
    return _config_dir() / "adapters.yaml"


def _topology_path() -> Path:
    return _config_dir() / "topology.yaml"


mcp = FastMCP("rcanalyst", instructions=INSTRUCTIONS)


def _adapters() -> AdaptersFile:
    return load_adapters(_adapters_path())


def _allowed_hosts(adapters: AdaptersFile) -> list[str]:
    return [urlparse(a.base_url).hostname for a in adapters.sources if urlparse(a.base_url).hostname]


@mcp.tool()
def correlate_ids(evidence_snippets: list[str]) -> dict:
    """Extract and rank correlation IDs (request/trace/span/message/job) shared
    across log snippets you've already collected elsewhere. Use this to carry
    an identifier forward across a sync-to-async hop (e.g. an HTTP request
    into a Kafka consumer)."""
    return _correlate_ids(evidence_snippets).model_dump()


@mcp.tool()
def plan_investigation(identifier: str, environment: str | None = None) -> dict:
    """START HERE when the user hands you a bare identifier — a session id,
    request id, trace id, or correlation id — with no logs yet. Classifies the
    identifier's shape, returns every vendor spelling it may appear under, names
    which configured sources and coverage surfaces can answer for it, and
    suggests a time window (widened when the id looks async). Use correlate_ids
    instead once you already have log snippets in hand."""
    return _plan_investigation(
        identifier=identifier, environment=environment,
        adapters=_adapters().sources, topology=load_topology(_topology_path()),
    ).model_dump()


@mcp.tool()
def analyze_visual_evidence(
    context: str,
    image_base64: str | None = None,
    har_json: str | None = None,
    har_path: str | None = None,
    slow_threshold_ms: float = 1000,
) -> dict:
    """Extract structured evidence from a HAR / browser network-tab export:
    failed and slow requests, with correlation headers, redacted.

    If you already have a screenshot in your own context, reason about it
    directly — do NOT pass it here. The image_base64 parameter returns the image
    unchanged (this tool runs no vision model), so round-tripping one you can
    already see just puts a second copy in your context. Pass it only if you
    need the image echoed back alongside HAR findings."""
    return _analyze_visual_evidence(
        context=context, image_base64=image_base64, har_json=har_json,
        har_path=har_path, slow_threshold_ms=slow_threshold_ms,
    ).model_dump()


@mcp.tool()
def query_generic_source(source: str, params: dict[str, Any], start: str, end: str, cursor: str | None = None) -> dict:
    """Query a source declared in adapters.yaml via a config-templated REST
    call. Use ONLY when no vendor MCP (Datadog/Splunk/Loki/etc.) already
    covers this source — prefer your own connected MCPs first."""
    adapters = _adapters()
    match = _resolve_adapter(source, adapters.sources)
    if match is None:
        return GenericQueryResult(
            rows=[], truncated=False, returned_count=0,
            error=f"Unknown source '{source}'. Call list_generic_sources first.",
        ).model_dump()
    result = _query_generic_source(
        adapter=match, params=params, time_range=TimeRange(start=start, end=end),
        allowed_hosts=_allowed_hosts(adapters), cursor=cursor,
    )
    return result.model_dump()


@mcp.tool()
def list_generic_sources() -> list[dict]:
    """List the sources declared in adapters.yaml for this deployment."""
    return _list_generic_sources(_adapters().sources)


@mcp.tool()
def get_coverage(resource_type: str) -> dict:
    """Look up which observability surfaces cover (or are blind to) a resource
    type, from topology.yaml. If unknown_coverage is true, you may NOT
    conclude absence from an empty query result for this resource type."""
    return _get_coverage(resource_type, load_topology(_topology_path())).model_dump()


@mcp.tool()
def validate_rca(claim_json: dict[str, Any], investigation_log: list[dict[str, Any]] | None = None) -> dict:
    """Deterministically lint a draft RCA's structured claim before you post it.
    Call this before finalizing any RCA, and emit the envelope fenced between
    BEGIN_RCANALYST_RESULT_JSON and END_RCANALYST_RESULT_JSON — on Claude Code a
    Stop hook re-runs this check against that block regardless."""
    return _validate_rca(claim_json, investigation_log or []).model_dump()


def main() -> None:
    transport = "streamable-http" if len(sys.argv) > 1 and sys.argv[1] == "--http" else "stdio"
    logger.info("Starting rcanalyst MCP server (transport=%s)", transport)
    mcp.run(transport=transport)


if __name__ == "__main__":
    main()
