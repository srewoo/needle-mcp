from __future__ import annotations
import re
from rcanalyst.config import AdapterConfig, TopologyFile
from rcanalyst.models import IdentifierPlan, SourceCandidate
from rcanalyst.tools.correlate_ids import ASYNC_KEYS, KEY_PATTERNS, normalize_identifier

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_W3C_TRACE = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)
_AWS_XRAY = re.compile(r"^1-[0-9a-f]{8}-[0-9a-f]{24}$", re.IGNORECASE)
_DECIMAL = re.compile(r"^\d{6,20}$")

# Substrings that mark an identifier as belonging to an async/queued flow, where
# the consumer's log can trail the producer's by tens of minutes.
_ASYNC_MARKERS = ("msg", "message", "job", "task", "event", "batch", "delivery")

SYNC_WINDOW_HINT = "+/- 2 minutes around the identifier's first sighting"
ASYNC_WINDOW_HINT = (
    "first sighting - 5 minutes to first sighting + 60 minutes (forward-widened: "
    "a lagging consumer's log trails the producer's, and a tight window reads as "
    "'never consumed' when the truth is 'not consumed yet')"
)


def _classify(identifier: str) -> str:
    if _UUID.match(identifier):
        return "uuid"
    if _AWS_XRAY.match(identifier):
        return "aws_xray"
    if _W3C_TRACE.match(identifier):
        return "w3c_trace"
    if _DECIMAL.match(identifier):
        return "datadog_decimal_trace"
    return "opaque"


def _is_async_shaped(identifier: str) -> bool:
    lowered = identifier.lower()
    return any(marker in lowered for marker in _ASYNC_MARKERS)


def plan_investigation(
    identifier: str,
    environment: str | None,
    adapters: list[AdapterConfig],
    topology: TopologyFile,
) -> IdentifierPlan:
    kind = _classify(identifier)
    is_async = _is_async_shaped(identifier)

    sources: list[SourceCandidate] = [
        SourceCandidate(
            name=a.name, kind="configured_adapter", covers=a.covers,
            note="query via query_generic_source",
        )
        for a in adapters
    ]
    for name, surface in topology.surfaces.items():
        sources.append(SourceCandidate(
            name=name, kind="coverage_surface", covers=surface.covers,
            note=surface.coverage_note,
        ))

    next_steps: list[str] = []
    if environment:
        next_steps.append(
            f"Scope every query to environment '{environment}' — a wrong-environment "
            "hit produces a confident, silently wrong RCA."
        )
    else:
        next_steps.append(
            "Confirm the environment (prod/staging/...) before querying — ask the user "
            "if it is not stated. Do not let a vendor tool's default org decide it."
        )

    if not sources:
        next_steps.append(
            "No configured sources and no topology entries: query whatever vendor MCP "
            "tools this session has connected, and treat any empty result as unknown "
            "coverage rather than as absence."
        )
    else:
        next_steps.append(
            "Query the sources above for this identifier and each of its "
            "equivalent_forms — vendors spell the same id differently."
        )

    next_steps.append(
        "Feed the log snippets you get back into correlate_ids to find which "
        "identifiers actually co-occur across services, then follow those."
    )
    if is_async:
        next_steps.append(
            "This id looks async: if the consumer side comes back empty, widen the "
            "window before concluding the message was never processed."
        )

    return IdentifierPlan(
        identifier=identifier,
        identifier_kind=kind,
        equivalent_forms=normalize_identifier(identifier),
        likely_key_names=sorted(KEY_PATTERNS.keys()) if not is_async
        else sorted(set(KEY_PATTERNS.keys()) | ASYNC_KEYS),
        is_async_shaped=is_async,
        suggested_window_hint=ASYNC_WINDOW_HINT if is_async else SYNC_WINDOW_HINT,
        queryable_sources=sources,
        unknown_coverage=not sources,
        next_steps=next_steps,
    )
