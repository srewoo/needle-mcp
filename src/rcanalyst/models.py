from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, Field


class TimeRange(BaseModel):
    start: str  # ISO8601
    end: str    # ISO8601


class CorrelationCandidate(BaseModel):
    value: str
    key_name: str
    equivalent_forms: list[str] = Field(default_factory=list)
    seen_in_snippets: list[int]
    source_systems: list[str] = Field(default_factory=list)
    first_seen_ts: str | None = None
    last_seen_ts: str | None = None
    suggested_window: list[str] | None = None
    confidence: Literal["high", "medium", "low"]
    why_ranked: str


class CorrelationResult(BaseModel):
    candidates: list[CorrelationCandidate]


class HarEntry(BaseModel):
    method: str
    url: str
    status: int
    time_ms: float
    correlation_headers: dict[str, str] = Field(default_factory=dict)


class VisualEvidenceResult(BaseModel):
    har_entries: list[HarEntry] = Field(default_factory=list)
    har_dropped_count: int = 0
    image_passthrough: str | None = None
    notes: list[str] = Field(default_factory=list)


class GenericQueryResult(BaseModel):
    rows: list[dict]
    truncated: bool
    returned_count: int
    next_cursor: str | None = None
    error: str | None = None


class SourceInfo(BaseModel):
    name: str
    base_url_host: str
    auth_mode: Literal["static_header", "basic", "none"]
    covers: list[str] = Field(default_factory=list)


class CoverageResult(BaseModel):
    covering_surfaces: list[str]
    blind_surfaces: list[str]
    unknown_coverage: bool


class SourceCandidate(BaseModel):
    name: str
    kind: Literal["configured_adapter", "coverage_surface"]
    covers: list[str] = Field(default_factory=list)
    note: str | None = None


class IdentifierPlan(BaseModel):
    identifier: str
    identifier_kind: Literal[
        "uuid", "w3c_trace", "datadog_decimal_trace", "aws_xray", "opaque"
    ]
    equivalent_forms: list[str] = Field(default_factory=list)
    likely_key_names: list[str] = Field(default_factory=list)
    is_async_shaped: bool = False
    suggested_window_hint: str
    queryable_sources: list[SourceCandidate] = Field(default_factory=list)
    unknown_coverage: bool = False
    next_steps: list[str] = Field(default_factory=list)


class ValidationGap(BaseModel):
    name: str
    severity: Literal["blocking", "warning"]
    detail: str


class ValidationResult(BaseModel):
    approved: bool
    gaps: list[ValidationGap] = Field(default_factory=list)
    required_action: str | None = None
