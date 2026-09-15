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

# Which of correlate_ids' KEY_PATTERNS could plausibly carry an identifier of a
# given shape. likely_key_names previously returned every key regardless of
# kind: ASYNC_KEYS is a strict SUBSET of KEY_PATTERNS, so both arms of the
# is_async conditional produced the identical list and the field was never
# "likely" — a UUID was told it might appear under `x-datadog-trace-id`
# (decimal only) or `traceparent` (a fixed `00-<32hex>-<16hex>-<2hex>` string).
# This is the headline output of the bare-identifier entry point, so a wrong
# hint buys a wasted vendor query.
#
# The generic request/correlation keys carry any opaque token and so appear for
# every kind; the vendor-format-specific keys appear only where the identifier —
# or one of its equivalent_forms, per normalize_identifier — can actually be
# written that way.
_GENERIC_KEYS = {"x-request-id", "request_id", "correlation_id"}
_ASYNC_ONLY_KEYS = {"message_id", "job_id"}
LIKELY_KEYS_BY_KIND: dict[str, set[str]] = {
    # Dashed 8-4-4-4-12 hex: a generic token. No vendor trace format is spelled
    # this way, and span_id is 16 hex, not a dashed UUID.
    "uuid": _GENERIC_KEYS | {"trace_id"},
    # 32 hex: the W3C trace-id, embedded in traceparent and convertible to
    # Datadog's decimal spelling.
    "w3c_trace": _GENERIC_KEYS | {"trace_id", "traceparent", "x-datadog-trace-id", "span_id"},
    # Decimal: Datadog's own spelling, hex-convertible to the W3C forms.
    "datadog_decimal_trace": _GENERIC_KEYS | {"trace_id", "traceparent", "x-datadog-trace-id", "span_id"},
    # 1-<8hex>-<24hex>: only AWS writes this.
    "aws_xray": _GENERIC_KEYS | {"trace_id", "x-amzn-trace-id"},
    # Shape tells us nothing, so narrowing here would be a guess dressed as fact.
    "opaque": set(KEY_PATTERNS.keys()),
}


def _likely_key_names(kind: str, is_async: bool) -> list[str]:
    keys = set(LIKELY_KEYS_BY_KIND.get(kind) or KEY_PATTERNS.keys())
    if is_async:
        keys |= ASYNC_KEYS
    else:
        keys -= _ASYNC_ONLY_KEYS
    # Intersect so this can never name a key correlate_ids cannot extract.
    return sorted(keys & set(KEY_PATTERNS.keys()))


SYNC_WINDOW_HINT = "+/- 2 minutes around the identifier's first sighting"
ASYNC_WINDOW_HINT = (
    "first sighting - 5 minutes to first sighting + 60 minutes (forward-widened: "
    "a lagging consumer's log trails the producer's, and a tight window reads as "
    "'never consumed' when the truth is 'not consumed yet')"
)


# NOTE: _W3C_TRACE is checked before _DECIMAL, but that ordering is currently
# inert for this pair: _DECIMAL is bounded to {6,20} digits while _W3C_TRACE
# requires exactly 32 hex chars, so no input can match both. The order is kept
# as defence in case _DECIMAL's upper bound is ever widened toward 32 — at
# that point the ordering would become the only thing preventing a 32-digit
# decimal trace id from being misclassified as datadog_decimal_trace.
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


def _build_sources(
    adapters: list[AdapterConfig], topology: TopologyFile
) -> list[SourceCandidate]:
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
    return sources


def _build_next_steps(
    environment: str | None, sources: list[SourceCandidate], is_async: bool
) -> list[str]:
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
    return next_steps


def plan_investigation(
    identifier: str,
    environment: str | None,
    adapters: list[AdapterConfig],
    topology: TopologyFile,
) -> IdentifierPlan:
    kind = _classify(identifier)
    is_async = _is_async_shaped(identifier)
    sources = _build_sources(adapters, topology)
    next_steps = _build_next_steps(environment, sources, is_async)

    return IdentifierPlan(
        identifier=identifier,
        identifier_kind=kind,
        equivalent_forms=normalize_identifier(identifier),
        likely_key_names=_likely_key_names(kind, is_async),
        is_async_shaped=is_async,
        suggested_window_hint=ASYNC_WINDOW_HINT if is_async else SYNC_WINDOW_HINT,
        queryable_sources=sources,
        unknown_coverage=not sources,
        next_steps=next_steps,
    )
