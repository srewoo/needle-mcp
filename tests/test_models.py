import pytest
from pydantic import ValidationError

from needle_mcp.models import (
    TimeRange, CorrelationCandidate, CorrelationResult, HarEntry,
    VisualEvidenceResult, GenericQueryResult, SourceInfo, CoverageResult,
    SourceCandidate, IdentifierPlan, ValidationGap, ValidationResult,
)


def test_time_range_roundtrip():
    tr = TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z")
    assert tr.model_dump() == {"start": "2026-09-15T00:00:00Z", "end": "2026-09-15T01:00:00Z"}


def test_correlation_candidate_defaults():
    c = CorrelationCandidate(
        value="abc123", key_name="x-request-id", seen_in_snippets=[0],
        confidence="high", why_ranked="test",
    )
    assert c.equivalent_forms == []
    assert c.source_systems == []
    assert c.suggested_window is None


def test_correlation_result_holds_candidates():
    c = CorrelationCandidate(
        value="abc123", key_name="x-request-id", seen_in_snippets=[0],
        confidence="high", why_ranked="test",
    )
    result = CorrelationResult(candidates=[c])
    assert len(result.candidates) == 1


def test_har_entry_and_visual_evidence_result():
    entry = HarEntry(method="GET", url="https://x/y", status=500, time_ms=1200.0)
    result = VisualEvidenceResult(har_entries=[entry], har_dropped_count=3)
    assert result.har_entries[0].status == 500
    assert result.image_passthrough is None


def test_generic_query_result_error_shape():
    result = GenericQueryResult(rows=[], truncated=False, returned_count=0, error="boom")
    assert result.error == "boom"


def test_source_info_rejects_an_unknown_auth_mode():
    """SourceInfo is the shape list_generic_sources returns; its auth_mode enum
    is the part worth pinning, since an adapter file is user-authored."""
    assert SourceInfo(
        name="loki", base_url_host="loki.example.internal", auth_mode="static_header"
    ).covers == []
    with pytest.raises(ValidationError):
        SourceInfo(name="loki", base_url_host="loki.example.internal", auth_mode="oauth")


def test_coverage_result():
    cov = CoverageResult(covering_surfaces=["cloudwatch"], blind_surfaces=["loki"], unknown_coverage=False)
    assert cov.unknown_coverage is False


def test_identifier_plan_defaults():
    plan = IdentifierPlan(
        identifier="abc-123", identifier_kind="opaque",
        suggested_window_hint="+/- 2 minutes around first sighting",
    )
    assert plan.equivalent_forms == []
    assert plan.is_async_shaped is False
    assert plan.queryable_sources == []


def test_source_candidate():
    sc = SourceCandidate(name="loki", kind="coverage_surface", covers=["k8s_pod"])
    assert sc.note is None


def test_validation_result_default_gaps_empty():
    result = ValidationResult(approved=True)
    assert result.gaps == []
    assert result.required_action is None


def test_validation_gap_severity_enum():
    """The name promised an enum check the body never performed. validate_rca
    and the Stop hook both filter gaps on severity == "blocking", so a typo'd
    severity would silently drop a gap out of the hook's blocking reason."""
    for severity in ("blocking", "warning"):
        assert ValidationGap(name="format-violation", severity=severity, detail="d").severity == severity
    with pytest.raises(ValidationError):
        ValidationGap(name="format-violation", severity="critical", detail="d")
