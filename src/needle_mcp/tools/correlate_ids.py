from __future__ import annotations
import re
from datetime import datetime, timedelta
from needle_mcp.models import CorrelationCandidate, CorrelationResult

KEY_PATTERNS: dict[str, re.Pattern] = {
    "x-request-id": re.compile(r"x-request-id[=:]\s*\"?([A-Za-z0-9\-]{6,})\"?", re.IGNORECASE),
    "request_id": re.compile(r"(?<!x-)request_id[=:]\s*\"?([A-Za-z0-9\-]{6,})\"?", re.IGNORECASE),
    "trace_id": re.compile(r"(?<!datadog-)(?<!x-)trace_id[=:]\s*\"?([A-Za-z0-9\-]{6,})\"?", re.IGNORECASE),
    "traceparent": re.compile(r"traceparent[=:]\s*\"?([0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2})\"?", re.IGNORECASE),
    "x-datadog-trace-id": re.compile(r"x-datadog-trace-id[=:]\s*\"?(\d{1,20})\"?", re.IGNORECASE),
    "x-amzn-trace-id": re.compile(r"x-amzn-trace-id[=:]\s*\"?([A-Za-z0-9=;\-]{6,})\"?", re.IGNORECASE),
    "correlation_id": re.compile(r"correlation_id[=:]\s*\"?([A-Za-z0-9\-]{6,})\"?", re.IGNORECASE),
    "message_id": re.compile(r"message[_-]?id[=:]\s*\"?([A-Za-z0-9\-]{6,})\"?", re.IGNORECASE),
    "job_id": re.compile(r"job[_-]?id[=:]\s*\"?([A-Za-z0-9\-]{6,})\"?", re.IGNORECASE),
    "span_id": re.compile(r"span_id[=:]\s*\"?([0-9a-f]{6,32})\"?", re.IGNORECASE),
}

ASYNC_KEYS = {"message_id", "job_id", "correlation_id"}
DENYLIST = {"0", "-", "null", "unknown", "n/a", "na", "00000000-0000-0000-0000-000000000000"}
_TS_PATTERN = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)")


def _extract_ts(snippet: str) -> str | None:
    m = _TS_PATTERN.search(snippet)
    return m.group(1) if m else None


def normalize_identifier(value: str) -> list[str]:
    """Return every spelling this identifier may appear under across vendors:
    dash-stripped, lowercased, and decimal<->hex for numeric/hex trace ids.
    Public because plan_investigation (Task 9A) reuses it in the other direction."""
    forms = {value, value.lower(), value.replace("-", "").lower()}
    stripped = value.replace("-", "")
    if stripped.isdigit():
        try:
            as_int = int(stripped)
            forms.add(format(as_int, "x"))
            forms.add(format(as_int, "032x"))
        except ValueError:
            pass
    elif re.fullmatch(r"[0-9a-fA-F]+", stripped) and not stripped.isdigit():
        try:
            as_int = int(stripped, 16)
            forms.add(str(as_int))
        except ValueError:
            pass
    return sorted(forms)


def _to_dt(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def correlate_ids(evidence_snippets: list[str]) -> CorrelationResult:
    found: dict[str, CorrelationCandidate] = {}

    for idx, snippet in enumerate(evidence_snippets):
        ts = _extract_ts(snippet)
        for key_name, pattern in KEY_PATTERNS.items():
            for match in pattern.finditer(snippet):
                value = match.group(1)
                if value.lower() in DENYLIST:
                    continue
                dedupe_key = value.lower().replace("-", "")
                candidate = found.get(dedupe_key)
                if candidate is None:
                    candidate = CorrelationCandidate(
                        value=value, key_name=key_name,
                        equivalent_forms=normalize_identifier(value),
                        seen_in_snippets=[], source_systems=[],
                        confidence="low", why_ranked="",
                    )
                    found[dedupe_key] = candidate
                if idx not in candidate.seen_in_snippets:
                    candidate.seen_in_snippets.append(idx)
                if ts:
                    if candidate.first_seen_ts is None or ts < candidate.first_seen_ts:
                        candidate.first_seen_ts = ts
                    if candidate.last_seen_ts is None or ts > candidate.last_seen_ts:
                        candidate.last_seen_ts = ts

    candidates = list(found.values())
    for c in candidates:
        cross_source_count = len(set(c.seen_in_snippets))
        if cross_source_count >= 2:
            c.confidence = "high"
            c.why_ranked = f"named key '{c.key_name}' co-occurred across {cross_source_count} snippets"
        else:
            c.confidence = "medium"
            c.why_ranked = f"named key '{c.key_name}' matched once"

        if c.first_seen_ts:
            base = _to_dt(c.first_seen_ts)
            if c.key_name in ASYNC_KEYS:
                start = base - timedelta(minutes=5)
                end = base + timedelta(minutes=60)
            else:
                start = base - timedelta(minutes=2)
                end = base + timedelta(minutes=2)
            c.suggested_window = [start.isoformat(), end.isoformat()]

    candidates.sort(key=lambda c: (len(set(c.seen_in_snippets)), c.confidence == "high"), reverse=True)
    return CorrelationResult(candidates=candidates)
