from __future__ import annotations
import re
from datetime import datetime
from rcanalyst.models import ValidationGap, ValidationResult

FORWARDED_ERROR_PATTERN = re.compile(
    r"unavailable|deadlineexceeded|i/o timeout|context deadline exceeded", re.IGNORECASE
)
BOUNDARY_PATH_PATTERN = re.compile(r"external/|clients/|adapters/|_client\.|stub\.", re.IGNORECASE)
VALID_CONFIDENCE = {"strong_evidence", "partial_evidence", "inconclusive"}


def _parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def validate_rca(claim_json: dict, investigation_log: list[dict] | None = None) -> ValidationResult:
    gaps: list[ValidationGap] = []

    for field in ("confidence", "status", "root_cause", "affected_services", "environment"):
        if not claim_json.get(field):
            gaps.append(ValidationGap(
                name="format-violation", severity="blocking",
                detail=f"Required envelope field '{field}' is missing or empty.",
            ))

    confidence = claim_json.get("confidence")
    if confidence is not None and confidence not in VALID_CONFIDENCE:
        gaps.append(ValidationGap(
            name="format-violation", severity="blocking",
            detail=f"'confidence' value '{confidence}' is not one of {sorted(VALID_CONFIDENCE)}.",
        ))

    evidence = claim_json.get("evidence", [])
    alert_window = claim_json.get("alert_window")
    if alert_window and evidence:
        try:
            win_start = _parse_ts(alert_window["start"])
            win_end = _parse_ts(alert_window["end"])
            for row in evidence:
                ts = row.get("timestamp")
                if not ts:
                    continue
                if not (win_start <= _parse_ts(ts) <= win_end):
                    gaps.append(ValidationGap(
                        name="evidence-outside-alert-window", severity="blocking",
                        detail=f"Evidence row timestamp {ts} falls outside alert_window {alert_window}.",
                    ))
        except (KeyError, ValueError):
            pass

    if confidence == "strong_evidence" and len(evidence) <= 1:
        gaps.append(ValidationGap(
            name="single-symptom-strong-evidence", severity="blocking",
            detail="strong_evidence claimed with a single evidence row; a single symptom is not a traced chain.",
        ))

    hop_trace = claim_json.get("hop_trace") or {}
    stop_reason = hop_trace.get("stop_reason")
    for row in evidence:
        row_text = str(row.get("text", ""))
        location = str(row.get("source_ref", ""))
        if FORWARDED_ERROR_PATTERN.search(row_text) and BOUNDARY_PATH_PATTERN.search(location):
            if stop_reason != "vendor_boundary":
                gaps.append(ValidationGap(
                    name="forwarded-error-as-terminal", severity="blocking",
                    detail=(
                        f"Evidence cites '{row_text}' at boundary location '{location}' but "
                        "stop_reason is not vendor_boundary — this looks like an RPC-forwarded "
                        "error, not the originating cause. Query the named downstream's own logs."
                    ),
                ))

    root_cause_text = (claim_json.get("root_cause") or "")
    if "cache miss" in root_cause_text.lower() and len(evidence) < 2:
        gaps.append(ValidationGap(
            name="cache-miss-as-rca", severity="blocking",
            detail="Root cause names a cache miss with no second evidence row explaining why the fallback was slow/errored.",
        ))

    monitored_resource = claim_json.get("monitored_resource") or {}
    if monitored_resource.get("unresolved") and confidence == "strong_evidence":
        gaps.append(ValidationGap(
            name="strong-evidence-on-unresolved", severity="blocking",
            detail="monitored_resource.unresolved is true but confidence is strong_evidence.",
        ))

    hop_count = hop_trace.get("hop_count")
    if isinstance(hop_count, int) and hop_count > 10:
        gaps.append(ValidationGap(
            name="hop-cap-exceeded", severity="blocking",
            detail=f"hop_trace.hop_count is {hop_count}, exceeding the 10-hop soft cap.",
        ))

    if claim_json.get("alert_metric") and not claim_json.get("decomposed_by"):
        gaps.append(ValidationGap(
            name="alert-metric-not-decomposed", severity="blocking",
            detail="A metric-anchored claim (alert_metric present) has no decomposed_by field — the series was not broken down by dimension.",
        ))

    environments_seen = {row.get("environment") for row in evidence if row.get("environment")}
    if len(environments_seen) > 1:
        gaps.append(ValidationGap(
            name="mixed-environment-evidence", severity="blocking",
            detail=f"Evidence rows span multiple environments: {sorted(environments_seen)}.",
        ))

    approved = not any(g.severity == "blocking" for g in gaps)
    required_action = None if approved else gaps[0].detail
    return ValidationResult(approved=approved, gaps=gaps, required_action=required_action)
