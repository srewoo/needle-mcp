from __future__ import annotations
import json
import os
from rcanalyst.models import HarEntry, VisualEvidenceResult
from rcanalyst.security import redact_headers, redact_url

SLOW_THRESHOLD_MS_DEFAULT = 1000
# Spec §4 anticipates 5-50MB HAR exports arriving by path (which is exactly why
# har_path exists). The cap sits at the top of that documented range: above it,
# json.load would hold the whole parsed document in the server's memory with no
# benefit, since the tool discards all but the failed/slow entries anyway.
MAX_HAR_FILE_BYTES = 50 * 1024 * 1024
CORRELATION_HEADER_NAMES = {
    "x-request-id", "traceparent", "x-amzn-trace-id",
    "x-datadog-trace-id", "x-correlation-id", "request-id",
}


def _load_har(har_json: str | None, har_path: str | None) -> tuple[dict | None, str | None]:
    """Return (har, error_note). Never raises: a mistyped path, an oversized
    export, or a truncated/invalid JSON body is described in the returned note
    and surfaced through VisualEvidenceResult.notes. Every other tool in this
    server returns a structured result on failure; this one used to be the sole
    exception, letting OSError/JSONDecodeError escape as a raw MCP tool error."""
    if har_path:
        try:
            size = os.path.getsize(har_path)
        except OSError as e:
            return None, f"Could not read har_path '{har_path}': {e}"
        if size > MAX_HAR_FILE_BYTES:
            return None, (
                f"har_path '{har_path}' is {size} bytes, over the "
                f"{MAX_HAR_FILE_BYTES} byte cap. Trim the export in your browser's "
                "network tab (filter to the failing requests) and retry."
            )
        try:
            with open(har_path) as f:
                return json.load(f), None
        except OSError as e:
            return None, f"Could not read har_path '{har_path}': {e}"
        except json.JSONDecodeError as e:
            return None, f"har_path '{har_path}' is not valid JSON: {e}"
    if har_json:
        try:
            return json.loads(har_json), None
        except json.JSONDecodeError as e:
            return None, f"har_json is not valid JSON: {e}"
    return None, None


def _parse_har_entries(har: dict, slow_threshold_ms: float) -> tuple[list[HarEntry], int]:
    entries = har.get("log", {}).get("entries", [])
    kept: list[HarEntry] = []
    dropped = 0
    for entry in entries:
        request = entry.get("request") or {}
        response = entry.get("response") or {}
        try:
            status = int(response.get("status") or 0)
        except (TypeError, ValueError):
            status = 0
        try:
            time_ms = float(entry.get("time") or 0)
        except (TypeError, ValueError):
            time_ms = 0
        if not (status >= 400 or time_ms >= slow_threshold_ms):
            dropped += 1
            continue
        raw_headers = {
            h["name"]: h.get("value", "")
            for h in request.get("headers", [])
            if h.get("name")
        }
        corr_headers = redact_headers(raw_headers, allowlist=CORRELATION_HEADER_NAMES)
        corr_headers = {k.lower(): v for k, v in corr_headers.items()}
        # Defensive, matching this parser's posture elsewhere: a malformed HAR
        # can carry a non-string or absent startedDateTime, and a missing
        # wall-clock anchor is better than a fabricated one.
        started = entry.get("startedDateTime")
        timestamp = started if isinstance(started, str) and started else None
        kept.append(HarEntry(
            method=request.get("method", "?"),
            url=redact_url(request.get("url", "")),
            status=status,
            time_ms=time_ms,
            timestamp=timestamp,
            correlation_headers=corr_headers,
        ))
    return kept, dropped


def analyze_visual_evidence(
    # Never read by this tool — it exists so the caller can state what it is
    # looking at. Defaulted because SKILL.md and README both document calls that
    # omit it, and a required-but-unused parameter turns those documented calls
    # into errors.
    context: str = "",
    image_base64: str | None = None,
    har_json: str | None = None,
    har_path: str | None = None,
    slow_threshold_ms: float = SLOW_THRESHOLD_MS_DEFAULT,
) -> VisualEvidenceResult:
    notes: list[str] = []
    har_entries: list[HarEntry] = []
    dropped = 0

    har, har_error = _load_har(har_json, har_path)
    if har_error:
        notes.append(har_error)
    elif har is not None and not isinstance(har, dict):
        notes.append(
            f"HAR input parsed as {type(har).__name__}, not a HAR document "
            "(expected an object with a 'log.entries' array); no entries extracted."
        )
    elif har is not None:
        har_entries, dropped = _parse_har_entries(har, slow_threshold_ms)
        notes.append(
            "Request/response bodies are never returned by this tool, to "
            "avoid leaking auth tokens or PII into the model context."
        )

    passthrough = None
    if image_base64:
        passthrough = image_base64
        notes.append(
            "Raw image passed through unmodified for your own multimodal "
            "reasoning; this tool does not run its own vision model. Large "
            "screenshots may approach the ~1MB single-message size limit."
        )

    return VisualEvidenceResult(
        har_entries=har_entries, har_dropped_count=dropped,
        image_passthrough=passthrough, notes=notes,
    )
