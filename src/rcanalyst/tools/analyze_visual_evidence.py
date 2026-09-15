from __future__ import annotations
import json
from rcanalyst.models import HarEntry, VisualEvidenceResult
from rcanalyst.security import redact_headers, redact_url

SLOW_THRESHOLD_MS_DEFAULT = 1000
CORRELATION_HEADER_NAMES = {
    "x-request-id", "traceparent", "x-amzn-trace-id",
    "x-datadog-trace-id", "x-correlation-id", "request-id",
}


def _load_har(har_json: str | None, har_path: str | None) -> dict | None:
    if har_path:
        with open(har_path) as f:
            return json.load(f)
    if har_json:
        return json.loads(har_json)
    return None


def _parse_har_entries(har: dict, slow_threshold_ms: float) -> tuple[list[HarEntry], int]:
    entries = har.get("log", {}).get("entries", [])
    kept: list[HarEntry] = []
    dropped = 0
    for entry in entries:
        request = entry.get("request") or {}
        response = entry.get("response") or {}
        status = response.get("status", 0) or 0
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
        kept.append(HarEntry(
            method=request.get("method", "?"),
            url=redact_url(request.get("url", "")),
            status=status,
            time_ms=time_ms,
            correlation_headers=corr_headers,
        ))
    return kept, dropped


def analyze_visual_evidence(
    context: str,
    image_base64: str | None = None,
    har_json: str | None = None,
    har_path: str | None = None,
    slow_threshold_ms: float = SLOW_THRESHOLD_MS_DEFAULT,
) -> VisualEvidenceResult:
    notes: list[str] = []
    har_entries: list[HarEntry] = []
    dropped = 0

    har = _load_har(har_json, har_path)
    if har is not None:
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
