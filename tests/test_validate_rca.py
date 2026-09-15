from needle_mcp.models import ValidationResult
from needle_mcp.tools.validate_rca import validate_rca


def _valid_claim(**overrides) -> dict:
    base = {
        "confidence": "strong_evidence",
        "status": "success",
        "root_cause": "payment-service timed out calling its own DB",
        "affected_services": ["checkout", "payment-service"],
        "environment": "prod",
        "alert_window": {"start": "2026-09-15T10:00:00Z", "end": "2026-09-15T10:10:00Z"},
        "evidence": [
            {"timestamp": "2026-09-15T10:05:00Z", "text": "DB connection pool exhausted", "source_ref": "payment_service/db.go:42", "environment": "prod"},
            {"timestamp": "2026-09-15T10:05:01Z", "text": "500 from payment-service", "source_ref": "checkout/clients/payment_client.go:88", "environment": "prod"},
        ],
        "hop_trace": {"hop_count": 2, "stop_reason": "terminal"},
    }
    base.update(overrides)
    return base


def test_valid_claim_is_approved():
    result = validate_rca(_valid_claim(), [])
    assert result.approved is True
    assert result.gaps == []


def test_missing_required_field_rejected():
    claim = _valid_claim()
    del claim["environment"]
    result = validate_rca(claim, [])
    assert result.approved is False
    assert any(g.name == "format-violation" for g in result.gaps)


def test_invalid_confidence_enum_rejected():
    claim = _valid_claim(confidence="pretty_sure")
    result = validate_rca(claim, [])
    assert any(g.name == "format-violation" for g in result.gaps)


def test_evidence_outside_alert_window_rejected():
    claim = _valid_claim()
    claim["evidence"][0]["timestamp"] = "2026-09-15T09:00:00Z"
    result = validate_rca(claim, [])
    assert any(g.name == "evidence-outside-alert-window" for g in result.gaps)


def test_single_symptom_strong_evidence_rejected():
    claim = _valid_claim()
    claim["evidence"] = [claim["evidence"][0]]
    result = validate_rca(claim, [])
    assert any(g.name == "single-symptom-strong-evidence" for g in result.gaps)


def test_forwarded_error_as_terminal_rejected():
    claim = _valid_claim(
        root_cause="checkout failed",
        evidence=[
            {"timestamp": "2026-09-15T10:05:00Z", "text": "rpc error: DeadlineExceeded", "source_ref": "checkout/clients/payment_client.go:88", "environment": "prod"},
            {"timestamp": "2026-09-15T10:05:01Z", "text": "500 returned to user", "source_ref": "checkout/handler.go:12", "environment": "prod"},
        ],
        hop_trace={"hop_count": 1, "stop_reason": "terminal"},
    )
    result = validate_rca(claim, [])
    assert any(g.name == "forwarded-error-as-terminal" for g in result.gaps)


def test_forwarded_error_allowed_when_stop_reason_is_vendor_boundary():
    claim = _valid_claim(
        evidence=[
            {"timestamp": "2026-09-15T10:05:00Z", "text": "rpc error: Unavailable", "source_ref": "checkout/clients/payment_client.go:88", "environment": "prod"},
            {"timestamp": "2026-09-15T10:05:01Z", "text": "confirmed vendor outage", "source_ref": "vendor status page", "environment": "prod"},
        ],
        hop_trace={"hop_count": 3, "stop_reason": "vendor_boundary"},
    )
    result = validate_rca(claim, [])
    assert not any(g.name == "forwarded-error-as-terminal" for g in result.gaps)


def test_cache_miss_as_rca_rejected():
    claim = _valid_claim(root_cause="cache miss caused slow response", evidence=[_valid_claim()["evidence"][0]])
    result = validate_rca(claim, [])
    assert any(g.name == "cache-miss-as-rca" for g in result.gaps)


def test_strong_evidence_on_unresolved_rejected():
    claim = _valid_claim(monitored_resource={"unresolved": True})
    result = validate_rca(claim, [])
    assert any(g.name == "strong-evidence-on-unresolved" for g in result.gaps)


def test_hop_cap_exceeded_rejected():
    claim = _valid_claim(hop_trace={"hop_count": 15, "stop_reason": "hop_cap_reached"})
    result = validate_rca(claim, [])
    assert any(g.name == "hop-cap-exceeded" for g in result.gaps)


def test_metric_claim_without_decomposition_rejected():
    claim = _valid_claim(alert_metric={"name": "error_rate", "object_class": "service"})
    result = validate_rca(claim, [])
    assert any(g.name == "alert-metric-not-decomposed" for g in result.gaps)


def test_metric_claim_with_decomposition_passes():
    claim = _valid_claim(alert_metric={"name": "error_rate"}, decomposed_by="tenant_id")
    result = validate_rca(claim, [])
    assert not any(g.name == "alert-metric-not-decomposed" for g in result.gaps)


def test_mixed_environment_evidence_rejected():
    claim = _valid_claim()
    claim["evidence"][1]["environment"] = "staging"
    result = validate_rca(claim, [])
    assert any(g.name == "mixed-environment-evidence" for g in result.gaps)


def test_required_action_surfaces_first_gap_detail():
    # Two independent gaps in a known order: the missing 'environment' field is
    # detected in the required-field loop (which runs first), the invalid
    # 'confidence' enum value is detected afterwards. required_action must
    # reflect gaps[0] specifically, not just "any" gap or a hardcoded string.
    claim = _valid_claim(confidence="pretty_sure")
    del claim["environment"]
    result = validate_rca(claim, [])
    assert len(result.gaps) >= 2
    assert result.required_action == result.gaps[0].detail
    assert "environment" in result.required_action.lower()
    assert "confidence" not in result.required_action.lower()


def test_evidence_with_non_dict_rows_does_not_raise():
    claim = _valid_claim(evidence=["not a dict"])
    result = validate_rca(claim, [])
    assert isinstance(result, ValidationResult)
    assert result.approved is False


def test_evidence_null_does_not_raise():
    claim = _valid_claim(evidence=None)
    result = validate_rca(claim, [])
    assert isinstance(result, ValidationResult)
    assert result.approved is False


def test_root_cause_non_string_does_not_raise():
    claim = _valid_claim(root_cause=12345)
    result = validate_rca(claim, [])
    assert isinstance(result, ValidationResult)
    assert result.approved is False


def test_hop_trace_wrong_type_does_not_raise():
    claim = _valid_claim(hop_trace=["not", "a", "dict"])
    result = validate_rca(claim, [])
    assert isinstance(result, ValidationResult)
    assert result.approved is False


def test_monitored_resource_wrong_type_does_not_raise():
    claim = _valid_claim(monitored_resource=["not", "a", "dict"])
    result = validate_rca(claim, [])
    assert isinstance(result, ValidationResult)
    assert result.approved is False


def test_malformed_alert_window_reports_format_violation():
    claim = _valid_claim(alert_window={"start": "not-a-timestamp", "end": "also-not"})
    result = validate_rca(claim, [])
    assert isinstance(result, ValidationResult)
    assert any(g.name == "format-violation" for g in result.gaps)
    assert result.approved is False


# --- The narration-only envelope (I5) ----------------------------------------
#
# 'evidence' was not in REQUIRED_FIELD_TYPES, and _alert_window_gaps returned
# early on a falsy alert_window, so an envelope with the five required scalars,
# zero evidence rows and no window was APPROVED — precisely the narration the
# Stop hook exists to block (spec §3).

_NARRATION_ONLY = {
    "confidence": "partial_evidence",
    "status": "partial",
    "root_cause": "the checkout service was probably overloaded",
    "affected_services": ["checkout"],
    "environment": "prod",
}


def test_evidence_free_envelope_is_rejected():
    result = validate_rca(dict(_NARRATION_ONLY), [])
    assert result.approved is False
    names = {g.name for g in result.gaps}
    assert "no-evidence-cited" in names
    assert "alert-window-missing" in names


def test_missing_alert_window_is_rejected_even_with_evidence():
    claim = _valid_claim()
    del claim["alert_window"]
    result = validate_rca(claim, [])
    assert result.approved is False
    assert {g.name for g in result.gaps} == {"alert-window-missing"}


def test_empty_evidence_list_is_rejected():
    result = validate_rca(_valid_claim(evidence=[]), [])
    assert result.approved is False
    assert any(g.name == "no-evidence-cited" for g in result.gaps)


def test_inconclusive_confidence_may_cite_no_evidence():
    """'I found nothing' is the honest answer, and has nothing to cite."""
    claim = _valid_claim(confidence="inconclusive", status="inconclusive", evidence=[])
    result = validate_rca(claim, [])
    assert result.approved is True, result.gaps


def test_inconclusive_still_requires_an_alert_window():
    claim = _valid_claim(confidence="inconclusive", status="inconclusive", evidence=[])
    del claim["alert_window"]
    result = validate_rca(claim, [])
    assert result.approved is False
    assert any(g.name == "alert-window-missing" for g in result.gaps)


def test_new_gap_names_follow_the_existing_kebab_case_style():
    result = validate_rca(dict(_NARRATION_ONLY), [])
    for gap in result.gaps:
        assert gap.name == gap.name.lower()
        assert " " not in gap.name and "_" not in gap.name
