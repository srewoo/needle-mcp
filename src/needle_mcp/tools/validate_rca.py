from __future__ import annotations
import re
from datetime import datetime
from needle_mcp.models import ValidationGap, ValidationResult

FORWARDED_ERROR_PATTERN = re.compile(
    r"unavailable|deadlineexceeded|i/o timeout|context deadline exceeded", re.IGNORECASE
)
BOUNDARY_PATH_PATTERN = re.compile(r"external/|clients/|adapters/|_client\.|stub\.", re.IGNORECASE)
VALID_CONFIDENCE = {"strong_evidence", "partial_evidence", "inconclusive"}
REQUIRED_FIELD_TYPES = {
    "confidence": str, "status": str, "root_cause": str,
    "affected_services": list, "environment": str,
}


def _parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _gap(name: str, detail: str) -> ValidationGap:
    return ValidationGap(name=name, severity="blocking", detail=detail)


def _normalize_evidence(claim_json: dict) -> tuple[list[dict], list[ValidationGap]]:
    """Return (clean evidence rows, gaps). Never raises: non-list/non-dict
    inputs are coerced to an empty/filtered list with a diagnostic gap rather
    than being passed on to crash a downstream predicate."""
    raw = claim_json.get("evidence")
    if raw is None:
        return [], []
    if not isinstance(raw, list):
        return [], [_gap("format-violation", f"'evidence' must be a list, got {type(raw).__name__}.")]
    clean = [row for row in raw if isinstance(row, dict)]
    malformed = len(raw) - len(clean)
    gaps = []
    if malformed:
        gaps.append(_gap(
            "format-violation",
            f"{malformed} evidence row(s) are not objects and were ignored.",
        ))
    return clean, gaps


def _normalize_dict_field(claim_json: dict, field_name: str) -> tuple[dict, list[ValidationGap]]:
    raw = claim_json.get(field_name)
    if raw is None:
        return {}, []
    if not isinstance(raw, dict):
        return {}, [_gap("format-violation", f"'{field_name}' must be an object, got {type(raw).__name__}.")]
    return raw, []


def _required_field_gaps(claim_json: dict) -> list[ValidationGap]:
    gaps: list[ValidationGap] = []
    for field, expected_type in REQUIRED_FIELD_TYPES.items():
        value = claim_json.get(field)
        if not value:
            gaps.append(_gap("format-violation", f"Required envelope field '{field}' is missing or empty."))
        elif not isinstance(value, expected_type):
            gaps.append(_gap(
                "format-violation",
                f"Required envelope field '{field}' must be of type {expected_type.__name__}, "
                f"got {type(value).__name__}.",
            ))
    return gaps


def _confidence_enum_gaps(claim_json: dict) -> list[ValidationGap]:
    confidence = claim_json.get("confidence")
    if isinstance(confidence, str) and confidence not in VALID_CONFIDENCE:
        return [_gap(
            "format-violation",
            f"'confidence' value '{confidence}' is not one of {sorted(VALID_CONFIDENCE)}.",
        )]
    return []


def _alert_window_required_gaps(claim_json: dict) -> list[ValidationGap]:
    """An absent alert_window silently disabled the evidence-window check below,
    which returned early on a falsy window — so an envelope simply omitting it
    skipped the check entirely. Scoping every evidence row to the alert's own
    window is the point of that check, so the window itself is required. Named
    separately from 'evidence-outside-alert-window' so the two failures stay
    distinguishable in the hook's blocking reason."""
    if not claim_json.get("alert_window"):
        return [_gap(
            "alert-window-missing",
            "No alert_window declared. Without it, evidence cannot be scoped to the "
            "incident's own time range and every timestamp check is vacuous. State the "
            "window the alert or report actually covers.",
        )]
    return []


def _evidence_present_gaps(claim_json: dict, evidence: list[dict]) -> list[ValidationGap]:
    """An envelope with zero evidence rows is narration wearing a JSON hat, and
    blocking exactly that is the Stop hook's stated purpose (spec §3). The one
    honest exception is confidence: inconclusive, where "I found nothing" IS the
    finding and there is by definition nothing to cite."""
    if evidence:
        return []
    if claim_json.get("confidence") == "inconclusive":
        return []
    return [_gap(
        "no-evidence-cited",
        "The envelope cites zero evidence rows. A root cause asserted without a "
        "single timestamped, sourced observation is narration, not an RCA. Cite the "
        "evidence, or set confidence to 'inconclusive'.",
    )]


def _alert_window_gaps(claim_json: dict, evidence: list[dict]) -> list[ValidationGap]:
    alert_window = claim_json.get("alert_window")
    if not alert_window or not evidence:
        return []
    gaps: list[ValidationGap] = []
    try:
        win_start = _parse_ts(alert_window["start"])
        win_end = _parse_ts(alert_window["end"])
        for row in evidence:
            ts = row.get("timestamp")
            if not ts:
                continue
            if not (win_start <= _parse_ts(ts) <= win_end):
                gaps.append(_gap(
                    "evidence-outside-alert-window",
                    f"Evidence row timestamp {ts} falls outside alert_window {alert_window}.",
                ))
    except (KeyError, ValueError, TypeError):
        gaps.append(_gap(
            "format-violation",
            f"'alert_window' ({alert_window!r}) is malformed and could not be compared "
            "against evidence timestamps.",
        ))
    return gaps


def _single_symptom_gaps(claim_json: dict, evidence: list[dict]) -> list[ValidationGap]:
    if claim_json.get("confidence") == "strong_evidence" and len(evidence) <= 1:
        return [_gap(
            "single-symptom-strong-evidence",
            "strong_evidence claimed with a single evidence row; a single symptom is not a traced chain.",
        )]
    return []


def _forwarded_error_gaps(hop_trace: dict, evidence: list[dict]) -> list[ValidationGap]:
    stop_reason = hop_trace.get("stop_reason")
    gaps: list[ValidationGap] = []
    for row in evidence:
        row_text = str(row.get("text", ""))
        location = str(row.get("source_ref", ""))
        if FORWARDED_ERROR_PATTERN.search(row_text) and BOUNDARY_PATH_PATTERN.search(location):
            if stop_reason != "vendor_boundary":
                gaps.append(_gap(
                    "forwarded-error-as-terminal",
                    f"Evidence cites '{row_text}' at boundary location '{location}' but "
                    "stop_reason is not vendor_boundary — this looks like an RPC-forwarded "
                    "error, not the originating cause. Query the named downstream's own logs.",
                ))
    return gaps


def _cache_miss_gaps(claim_json: dict, evidence: list[dict]) -> list[ValidationGap]:
    root_cause_text = str(claim_json.get("root_cause") or "")
    if "cache miss" in root_cause_text.lower() and len(evidence) < 2:
        return [_gap(
            "cache-miss-as-rca",
            "Root cause names a cache miss with no second evidence row explaining why the "
            "fallback was slow/errored.",
        )]
    return []


def _unresolved_strong_evidence_gaps(claim_json: dict, monitored_resource: dict) -> list[ValidationGap]:
    if monitored_resource.get("unresolved") and claim_json.get("confidence") == "strong_evidence":
        return [_gap(
            "strong-evidence-on-unresolved",
            "monitored_resource.unresolved is true but confidence is strong_evidence.",
        )]
    return []


def _hop_cap_gaps(hop_trace: dict) -> list[ValidationGap]:
    hop_count = hop_trace.get("hop_count")
    if isinstance(hop_count, int) and hop_count > 10:
        return [_gap(
            "hop-cap-exceeded",
            f"hop_trace.hop_count is {hop_count}, exceeding the 10-hop soft cap.",
        )]
    return []


def _metric_decomposition_gaps(claim_json: dict) -> list[ValidationGap]:
    if claim_json.get("alert_metric") and not claim_json.get("decomposed_by"):
        return [_gap(
            "alert-metric-not-decomposed",
            "A metric-anchored claim (alert_metric present) has no decomposed_by field — "
            "the series was not broken down by dimension.",
        )]
    return []


def _mixed_environment_gaps(evidence: list[dict]) -> list[ValidationGap]:
    environments_seen = {row.get("environment") for row in evidence if row.get("environment")}
    if len(environments_seen) > 1:
        return [_gap(
            "mixed-environment-evidence",
            f"Evidence rows span multiple environments: {sorted(environments_seen)}.",
        )]
    return []


def _run_checks(claim_json: dict) -> list[ValidationGap]:
    evidence, evidence_gaps = _normalize_evidence(claim_json)
    hop_trace, hop_trace_gaps = _normalize_dict_field(claim_json, "hop_trace")
    monitored_resource, monitored_resource_gaps = _normalize_dict_field(claim_json, "monitored_resource")

    gaps: list[ValidationGap] = []
    gaps.extend(_required_field_gaps(claim_json))
    gaps.extend(_confidence_enum_gaps(claim_json))
    gaps.extend(evidence_gaps)
    gaps.extend(hop_trace_gaps)
    gaps.extend(monitored_resource_gaps)
    gaps.extend(_alert_window_required_gaps(claim_json))
    gaps.extend(_evidence_present_gaps(claim_json, evidence))
    gaps.extend(_alert_window_gaps(claim_json, evidence))
    gaps.extend(_single_symptom_gaps(claim_json, evidence))
    gaps.extend(_forwarded_error_gaps(hop_trace, evidence))
    gaps.extend(_cache_miss_gaps(claim_json, evidence))
    gaps.extend(_unresolved_strong_evidence_gaps(claim_json, monitored_resource))
    gaps.extend(_hop_cap_gaps(hop_trace))
    gaps.extend(_metric_decomposition_gaps(claim_json))
    gaps.extend(_mixed_environment_gaps(evidence))
    return gaps


def validate_rca(claim_json: dict, investigation_log: list[dict] | None = None) -> ValidationResult:
    """Deterministic linter over a model-produced RCA claim. Never raises:
    malformed input (wrong types, missing keys, non-dict rows) is reported as
    format-violation gaps by the per-field checks in _run_checks; the
    try/except below is a backstop for any shape neither of us anticipated."""
    try:
        if not isinstance(claim_json, dict):
            gap = _gap("format-violation", f"claim_json must be an object, got {type(claim_json).__name__}.")
            return ValidationResult(approved=False, gaps=[gap], required_action=gap.detail)

        gaps = _run_checks(claim_json)
        approved = not any(g.severity == "blocking" for g in gaps)
        required_action = None if approved else gaps[0].detail
        return ValidationResult(approved=approved, gaps=gaps, required_action=required_action)
    except Exception as exc:  # noqa: BLE001 - deliberate backstop, see docstring
        gap = _gap(
            "format-violation",
            f"validate_rca could not evaluate the claim due to an unexpected error: {exc}",
        )
        return ValidationResult(approved=False, gaps=[gap], required_action=gap.detail)
