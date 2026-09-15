# rcAnalyst Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build rcAnalyst — a stateless, credential-free MCP server (plus a Claude Code plugin distribution) that gives any Claude session generic RCA-investigation building blocks and a ported, vendor-agnostic version of DebugIQ's investigation discipline.

**Architecture:** A Python MCP server (`mcp` SDK, `FastMCP`) exposing seven tools with zero vendor-specific code — `plan_investigation`, `correlate_ids`, `analyze_visual_evidence`, `query_generic_source`, `list_generic_sources`, `get_coverage`, `validate_rca` — backed by pure, independently-tested business-logic functions. Config (`adapters.yaml`, `topology.yaml`) is user-authored, starting from shipped examples. Methodology lives in a skill file exposed three ways: MCP `instructions`, a Claude Code plugin skill, and (implicitly) whatever the host reads. Claude Code additionally gets a `Stop` hook that runs `validate_rca` against the just-finished turn, the only distribution channel with non-optional enforcement.

**Tech Stack:** Python 3.11+, `mcp` (official Python SDK, `FastMCP`), `pydantic` v2, `pyyaml`, `pytest`. No Anthropic SDK, no Agent SDK, no database.

**Spec:** `docs/superpowers/specs/2026-09-15-rcanalyst-design.md`

## Global Constraints

- No server-side Anthropic API key or credentials of any kind, anywhere in this codebase.
- No vendor-specific adapter code (no Datadog/GitLab/Splunk client libraries) — `query_generic_source` is the only network-calling tool, and it is config-templated, never vendor-specific.
- Fully stateless: no query store, no session store, no on-disk cache, no cross-call persistence.
- Every tool's business logic lives in a pure function in `tools/*.py`, importable and testable without the `mcp` runtime; `server.py` only wraps these with `@mcp.tool()` and calls `.model_dump()`.
- All logging goes to stderr, never stdout — stdout is reserved for the MCP JSON-RPC stream (see spec §7, F7 in the review).
- HAR/header redaction defaults to an **allowlist**, never a denylist; `Authorization`/`Cookie`/`Set-Cookie` are never returned by any tool regardless of flags.
- `query_generic_source` enforces a server-side host allowlist and rejects any param value that could redirect the request off it.
- No response is ever silently truncated without a `truncated: true` flag and an explicit note in the payload.
- Python dependency floors: `mcp>=1.9.0,<2`, `pydantic>=2.7`, `pyyaml>=6.0`, `pytest>=8.0`.
  **The `<2` pin is load-bearing:** `mcp` 2.x deleted `mcp.server.fastmcp` (FastMCP was
  renamed to `MCPServer`), so an unpinned install breaks every import in this plan. Porting
  to 2.x is a tracked follow-up, not part of v1.
- The RCA result envelope is emitted fenced between the exact sentinels
  `BEGIN_RCANALYST_RESULT_JSON` and `END_RCANALYST_RESULT_JSON`. The skill instructs the host
  to emit them; the Stop hook greps for them. These two must never drift apart — if the
  sentinel changes in one place it changes in both.

---

## Task 1: Project scaffolding & shared models

**Files:**
- Create: `pyproject.toml`
- Create: `.gitignore`
- Create: `src/rcanalyst/__init__.py`
- Create: `src/rcanalyst/models.py`
- Test: `tests/test_models.py`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `TimeRange`, `CorrelationCandidate`, `CorrelationResult`, `HarEntry`, `VisualEvidenceResult`, `GenericQueryResult`, `SourceInfo`, `CoverageResult`, `SourceCandidate`, `IdentifierPlan`, `ValidationGap`, `ValidationResult` — all `pydantic.BaseModel` subclasses in `rcanalyst.models`, used by every later task.

- [ ] **Step 1: Create the project scaffold**

`pyproject.toml`:

```toml
[project]
name = "rcanalyst"
version = "0.1.0"
description = "Generic, credential-free MCP server for RCA investigation, composing with whatever vendor MCPs are already connected."
requires-python = ">=3.11"
dependencies = [
    # The <2 pin is load-bearing: mcp 2.x deleted mcp.server.fastmcp (FastMCP was
    # renamed to MCPServer). Every import in this project assumes the 1.x layout.
    "mcp>=1.9.0,<2",
    "pydantic>=2.7",
    "pyyaml>=6.0",
]

[project.scripts]
rcanalyst = "rcanalyst.server:main"

[project.optional-dependencies]
dev = ["pytest>=8.0", "pytest-cov>=5.0"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/rcanalyst"]
```

`.gitignore`:

```gitignore
__pycache__/
*.py[cod]
.venv/
*.egg-info/
dist/
build/
.pytest_cache/
.coverage
htmlcov/
.superpowers/

# User-authored config — never commit a deployment's own sources/topology.
adapters.yaml
topology.yaml
```

`src/rcanalyst/__init__.py`:

```python
"""rcAnalyst: generic, credential-free RCA investigation MCP server."""

__version__ = "0.1.0"
```

- [ ] **Step 2: Write the failing test for shared models**

`tests/test_models.py`:

```python
from rcanalyst.models import (
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


def test_source_info():
    s = SourceInfo(name="loki", base_url_host="loki.example.internal", auth_mode="static_header")
    assert s.covers == []


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
    gap = ValidationGap(name="format-violation", severity="blocking", detail="missing field")
    assert gap.severity == "blocking"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/sharajrewoo/DemoReposQA/rcAnalyst && python -m pip install -e ".[dev]" && pytest tests/test_models.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'rcanalyst.models'`

- [ ] **Step 4: Implement the shared models**

`src/rcanalyst/models.py`:

```python
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_models.py -v`
Expected: PASS (11 tests)

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml .gitignore src/rcanalyst/__init__.py src/rcanalyst/models.py tests/test_models.py
git commit -m "feat: scaffold project and add shared pydantic models"
```

---

## Task 2: Response bounding helper

**Files:**
- Create: `src/rcanalyst/bounding.py`
- Test: `tests/test_bounding.py`

**Interfaces:**
- Consumes: nothing new
- Produces: `bound_json(data: Any, max_chars: int = 12000) -> tuple[str, bool]` in `rcanalyst.bounding`, used by later tools that can return large payloads (`query_generic_source`).

- [ ] **Step 1: Write the failing tests**

`tests/test_bounding.py`:

```python
import json
from rcanalyst.bounding import bound_json, DEFAULT_MAX_CHARS


def test_small_payload_not_truncated():
    data = {"rows": [{"a": 1}], "truncated": False, "returned_count": 1}
    text, truncated = bound_json(data)
    assert truncated is False
    assert json.loads(text) == data


def test_rows_payload_truncates_by_dropping_rows():
    rows = [{"line": "x" * 100, "i": i} for i in range(500)]
    data = {"rows": rows, "truncated": False, "returned_count": 500}
    text, truncated = bound_json(data, max_chars=2000)
    assert truncated is True
    assert len(text) <= 2000
    parsed = json.loads(text)
    assert parsed["truncated"] is True
    assert len(parsed["rows"]) < 500
    assert "_truncation_note" in parsed


def test_non_rows_payload_hard_truncates_with_note():
    data = {"blob": "y" * 20000}
    text, truncated = bound_json(data, max_chars=1000)
    assert truncated is True
    assert len(text) <= 1000 + 5  # small buffer for the closing quote in the appended note
    assert "_truncation_note" in text or "truncation" in text.lower()


def test_default_max_chars_is_12000():
    assert DEFAULT_MAX_CHARS == 12000
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_bounding.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'rcanalyst.bounding'`

- [ ] **Step 3: Implement bounding.py**

`src/rcanalyst/bounding.py`:

```python
from __future__ import annotations
import json
from typing import Any

DEFAULT_MAX_CHARS = 12000


def bound_json(data: Any, max_chars: int = DEFAULT_MAX_CHARS) -> tuple[str, bool]:
    """Serialize data to JSON, applying tiered truncation if it exceeds max_chars.

    Tier 1: return as-is if it already fits.
    Tier 2: if the payload is dict-shaped with a "rows" list, drop rows from
    the end until it fits, and set truncated=True with an explanatory note —
    this is the shape query_generic_source and similar tools return.
    Tier 3: otherwise, hard-truncate the serialized text and append a
    directive note telling the caller to narrow the query.
    """
    text = json.dumps(data, default=str)
    if len(text) <= max_chars:
        return text, False

    if isinstance(data, dict) and isinstance(data.get("rows"), list):
        rows = data["rows"]
        remaining = dict(data)
        remaining["truncated"] = True
        # Reserve the note's cost BEFORE packing rows, so the final serialization
        # already fits and is never sliced mid-token (slicing produced invalid JSON).
        remaining["_truncation_note"] = (
            f"Response truncated from {len(rows)} rows to stay under {max_chars} "
            f"chars. Narrow the query (smaller time_range, more specific filter) "
            f"rather than treating this count as complete."
        )
        kept: list[Any] = []
        for row in rows:
            trial = dict(remaining)
            trial["rows"] = kept + [row]
            if len(json.dumps(trial, default=str)) > max_chars:
                break
            kept.append(row)
        remaining["rows"] = kept
        return json.dumps(remaining, default=str), True

    note = (
        f'..."_truncation_note": "Response hard-truncated at {max_chars} '
        'chars. Narrow the query and retry."'
    )
    return text[: max_chars - len(note)] + note, True
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_bounding.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rcanalyst/bounding.py tests/test_bounding.py
git commit -m "feat: add tiered response-bounding helper"
```

---

## Task 3: Security helpers (redaction + host allowlisting)

**Files:**
- Create: `src/rcanalyst/security.py`
- Test: `tests/test_security.py`

**Interfaces:**
- Consumes: nothing new
- Produces: `redact_headers(headers: dict, allowlist: set[str] | None = None) -> dict`, `redact_url(url: str) -> str`, `HostNotAllowedError`, `assert_host_allowed(url: str, allowed_hosts: list[str]) -> None`, `safe_encode_param(value: str) -> str`, `assert_url_structure_unchanged(built_url: str, base_url: str) -> None` — all in `rcanalyst.security`, used by `analyze_visual_evidence` (Task 6) and `query_generic_source` (Task 7).

- [ ] **Step 1: Write the failing tests**

`tests/test_security.py`:

```python
import pytest
from rcanalyst.security import (
    redact_headers, redact_url, assert_host_allowed, safe_encode_param,
    assert_url_structure_unchanged, HostNotAllowedError,
    DEFAULT_HEADER_ALLOWLIST, NEVER_RETURN_HEADERS,
)


def test_redact_headers_keeps_allowlisted():
    headers = {"X-Request-Id": "abc", "Content-Type": "application/json"}
    out = redact_headers(headers)
    assert out == {"X-Request-Id": "abc", "Content-Type": "application/json"}


def test_redact_headers_drops_non_allowlisted():
    headers = {"X-Request-Id": "abc", "X-Custom-Internal": "secret-shape"}
    out = redact_headers(headers)
    assert "X-Custom-Internal" not in out
    assert out == {"X-Request-Id": "abc"}


def test_redact_headers_never_returns_auth_even_if_allowlisted():
    headers = {"Authorization": "Bearer xyz", "Cookie": "session=abc"}
    out = redact_headers(headers, allowlist={"authorization", "cookie"})
    assert out == {}


def test_redact_url_strips_query_string():
    url = "https://api.example.com/checkout?token=secret&user=alice"
    assert redact_url(url) == "https://api.example.com/checkout"


def test_assert_host_allowed_passes_for_allowed_host():
    assert_host_allowed("https://loki.example.internal/api", ["loki.example.internal"])


def test_assert_host_allowed_raises_for_disallowed_host():
    with pytest.raises(HostNotAllowedError):
        assert_host_allowed("https://evil.example.com/api", ["loki.example.internal"])


def test_safe_encode_param_encodes_normal_value():
    assert safe_encode_param("checkout service") == "checkout%20service"


def test_safe_encode_param_allows_url_valued_query():
    """Searching logs FOR a URL is a core RCA query and must not be rejected;
    encoding renders it inert in query-string position."""
    encoded = safe_encode_param("https://api.example.com/checkout")
    assert "://" not in encoded
    assert encoded == "https%3A%2F%2Fapi.example.com%2Fcheckout"


def test_safe_encode_param_allows_dots_in_range_syntax():
    assert safe_encode_param("latency..500") == "latency..500"


def test_safe_encode_param_rejects_protocol_relative():
    with pytest.raises(ValueError):
        safe_encode_param("//attacker.com/steal")


def test_assert_url_structure_unchanged_passes_for_same_host():
    assert_url_structure_unchanged(
        "https://loki.example.internal/api/q?x=1", "https://loki.example.internal"
    )


def test_assert_url_structure_unchanged_rejects_host_swap():
    with pytest.raises(HostNotAllowedError):
        assert_url_structure_unchanged(
            "https://evil.example.com/api/q", "https://loki.example.internal"
        )


def test_assert_url_structure_unchanged_rejects_scheme_downgrade():
    with pytest.raises(HostNotAllowedError):
        assert_url_structure_unchanged(
            "http://loki.example.internal/api/q", "https://loki.example.internal"
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_security.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'rcanalyst.security'`

- [ ] **Step 3: Implement security.py**

`src/rcanalyst/security.py`:

```python
from __future__ import annotations
from urllib.parse import urlparse, quote

DEFAULT_HEADER_ALLOWLIST = {
    "content-type", "x-request-id", "traceparent", "x-datadog-trace-id",
    "x-amzn-trace-id", "x-correlation-id", "request-id", "server-timing",
    "date", "cache-control",
}

NEVER_RETURN_HEADERS = {"authorization", "cookie", "set-cookie"}


def redact_headers(headers: dict[str, str], allowlist: set[str] | None = None) -> dict[str, str]:
    """Keep only allowlisted headers; NEVER_RETURN_HEADERS are dropped even if
    explicitly allowlisted by the caller — this is a hard floor, not a default."""
    allow = {h.lower() for h in (allowlist if allowlist is not None else DEFAULT_HEADER_ALLOWLIST)}
    out: dict[str, str] = {}
    for key, value in headers.items():
        lower = key.lower()
        if lower in NEVER_RETURN_HEADERS:
            continue
        if lower in allow:
            out[key] = value
    return out


def redact_url(url: str) -> str:
    """Strip the query string (may carry tokens/PII); keep scheme+host+path."""
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"


class HostNotAllowedError(ValueError):
    pass


def assert_host_allowed(url: str, allowed_hosts: list[str]) -> None:
    host = urlparse(url).hostname or ""
    if host not in allowed_hosts:
        raise HostNotAllowedError(
            f"Host '{host}' is not in the configured allowlist {allowed_hosts}. "
            "Add it to adapters.yaml if this is intentional."
        )


def safe_encode_param(value: str) -> str:
    """Percent-encode a param value for safe substitution into a query template.

    Deliberately does NOT reject values containing '://' or '..': searching logs
    for a URL ("https://api.example.com/checkout") or an ES range is a core RCA
    query, and quote(safe="") already renders those inert — an encoded value
    cannot escape its query-string position. Structural safety is enforced after
    the URL is built, by assert_url_structure_unchanged().
    """
    if value.startswith("//"):
        raise ValueError(
            f"Param value '{value}' starts with '//' (protocol-relative) and was rejected."
        )
    return quote(value, safe="")


def assert_url_structure_unchanged(built_url: str, base_url: str) -> None:
    """Confirm a template-built URL still points at the adapter's own host and
    did not gain a scheme/host/path-prefix change from substituted values."""
    built = urlparse(built_url)
    base = urlparse(base_url)
    if built.scheme != base.scheme or built.hostname != base.hostname or built.port != base.port:
        raise HostNotAllowedError(
            f"Built URL '{built_url}' does not match adapter base '{base_url}' "
            "in scheme/host/port; refusing to send it."
        )
    if not built.path.startswith(base.path.rstrip("/")):
        raise HostNotAllowedError(
            f"Built URL path '{built.path}' escapes the adapter's base path; refusing to send it."
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_security.py -v`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rcanalyst/security.py tests/test_security.py
git commit -m "feat: add header redaction and host-allowlist security helpers"
```

---

## Task 4: Config loading (adapters.yaml, topology.yaml) + example files

**Files:**
- Create: `src/rcanalyst/config.py`
- Create: `adapters.example.yaml`
- Create: `topology.example.yaml`
- Test: `tests/test_config.py`

**Interfaces:**
- Consumes: nothing new
- Produces: `AdapterConfig`, `AdaptersFile`, `SurfaceCoverage`, `TopologyFile` (pydantic models), `load_adapters(path) -> AdaptersFile`, `load_topology(path) -> TopologyFile`, `resolve_adapter_credential(adapter: AdapterConfig) -> str | None` — all in `rcanalyst.config`. Used by `query_generic_source` (Task 7), `get_coverage` (Task 8), and `server.py` (Task 10).

- [ ] **Step 1: Write the failing tests**

`tests/test_config.py`:

```python
from pathlib import Path
import pytest
from rcanalyst.config import (
    AdapterConfig, AdaptersFile, SurfaceCoverage, TopologyFile,
    load_adapters, load_topology, resolve_adapter_credential,
)


def test_load_adapters_missing_file_returns_empty(tmp_path):
    result = load_adapters(tmp_path / "nope.yaml")
    assert result.sources == []


def test_load_adapters_parses_real_file(tmp_path):
    p = tmp_path / "adapters.yaml"
    p.write_text(
        "sources:\n"
        "  - name: loki\n"
        "    base_url: https://loki.example.internal\n"
        "    auth_mode: static_header\n"
        "    auth_env_var: LOKI_AUTH_HEADER\n"
        "    header_name: Authorization\n"
        "    query_template: \"/loki/api/v1/query_range?query={query}\"\n"
        "    covers: [k8s_pod]\n"
    )
    result = load_adapters(p)
    assert len(result.sources) == 1
    assert result.sources[0].name == "loki"
    assert result.sources[0].covers == ["k8s_pod"]


def test_load_topology_missing_file_returns_empty(tmp_path):
    result = load_topology(tmp_path / "nope.yaml")
    assert result.surfaces == {}


def test_load_topology_parses_real_file(tmp_path):
    p = tmp_path / "topology.yaml"
    p.write_text(
        "surfaces:\n"
        "  loki:\n"
        "    covers: [k8s_pod]\n"
        "    blind_to: [lambda]\n"
    )
    result = load_topology(p)
    assert "loki" in result.surfaces
    assert result.surfaces["loki"].blind_to == ["lambda"]


def test_resolve_adapter_credential_static_header(monkeypatch):
    monkeypatch.setenv("MY_TOKEN", "secret-value")
    adapter = AdapterConfig(
        name="x", base_url="https://x", auth_mode="static_header",
        auth_env_var="MY_TOKEN", query_template="/q",
    )
    assert resolve_adapter_credential(adapter) == "secret-value"


def test_resolve_adapter_credential_missing_env_var_raises(monkeypatch):
    monkeypatch.delenv("MISSING_TOKEN", raising=False)
    adapter = AdapterConfig(
        name="x", base_url="https://x", auth_mode="static_header",
        auth_env_var="MISSING_TOKEN", query_template="/q",
    )
    with pytest.raises(ValueError):
        resolve_adapter_credential(adapter)


def test_resolve_adapter_credential_none_mode_returns_none():
    adapter = AdapterConfig(name="x", base_url="https://x", auth_mode="none", query_template="/q")
    assert resolve_adapter_credential(adapter) is None


REPO_ROOT = Path(__file__).parent.parent


def test_example_adapters_file_parses():
    result = load_adapters(REPO_ROOT / "adapters.example.yaml")
    names = {s.name for s in result.sources}
    assert {"loki", "opensearch", "splunk"} <= names


def test_example_topology_file_parses():
    result = load_topology(REPO_ROOT / "topology.example.yaml")
    assert "datadog_logs" in result.surfaces
    assert result.surfaces["loki"].blind_to  # non-empty
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'rcanalyst.config'`

- [ ] **Step 3: Implement config.py**

`src/rcanalyst/config.py`:

```python
from __future__ import annotations
import os
from pathlib import Path
from typing import Literal
import yaml
from pydantic import BaseModel, Field


class AdapterConfig(BaseModel):
    name: str
    base_url: str
    auth_mode: Literal["static_header", "basic", "none"] = "none"
    auth_env_var: str | None = None
    header_name: str | None = None
    basic_user_env_var: str | None = None
    basic_pass_env_var: str | None = None
    query_template: str
    response_path: str | None = None
    field_map: dict[str, str] = Field(default_factory=dict)
    covers: list[str] = Field(default_factory=list)
    pagination_cursor_param: str | None = None
    pagination_cursor_field: str | None = None
    max_rows_per_call: int = 200


class AdaptersFile(BaseModel):
    sources: list[AdapterConfig] = Field(default_factory=list)


class SurfaceCoverage(BaseModel):
    tool_prefix: str | None = None
    covers: list[str] = Field(default_factory=list)
    blind_to: list[str] = Field(default_factory=list)
    coverage_note: str | None = None


class TopologyFile(BaseModel):
    surfaces: dict[str, SurfaceCoverage] = Field(default_factory=dict)


def load_adapters(path: str | Path) -> AdaptersFile:
    p = Path(path)
    if not p.exists():
        return AdaptersFile(sources=[])
    with open(p) as f:
        raw = yaml.safe_load(f) or {}
    return AdaptersFile(**raw)


def load_topology(path: str | Path) -> TopologyFile:
    p = Path(path)
    if not p.exists():
        return TopologyFile(surfaces={})
    with open(p) as f:
        raw = yaml.safe_load(f) or {}
    return TopologyFile(**raw)


def resolve_adapter_credential(adapter: AdapterConfig) -> str | None:
    if adapter.auth_mode == "static_header":
        if not adapter.auth_env_var:
            raise ValueError(f"Adapter '{adapter.name}' is static_header but has no auth_env_var")
        value = os.environ.get(adapter.auth_env_var)
        if not value:
            raise ValueError(f"Env var '{adapter.auth_env_var}' for adapter '{adapter.name}' is not set")
        return value
    return None
```

`adapters.example.yaml` (project root):

```yaml
# Copy to adapters.yaml and edit. Each entry is a source query_generic_source
# can reach. Use this ONLY for a backend with no dedicated MCP available —
# prefer a real vendor MCP (Datadog, Splunk, etc.) when one is connected.
sources:
  - name: loki
    base_url: "https://loki.example.internal"
    auth_mode: static_header
    auth_env_var: LOKI_AUTH_HEADER
    header_name: Authorization
    query_template: "/loki/api/v1/query_range?query={query}&start={start}&end={end}&limit=200"
    response_path: "data.result"
    covers: ["k8s_pod"]
    max_rows_per_call: 200

  - name: opensearch
    base_url: "https://opensearch.example.internal:9200"
    auth_mode: basic
    basic_user_env_var: OPENSEARCH_USER
    basic_pass_env_var: OPENSEARCH_PASSWORD
    query_template: "/logs-*/_search?q={query}&size=200"
    response_path: "hits.hits"
    pagination_cursor_param: "search_after"
    pagination_cursor_field: "_scroll_id"
    covers: ["ec2_instance", "generic_service"]
    max_rows_per_call: 200

  - name: splunk
    base_url: "https://splunk.example.internal:8089"
    auth_mode: static_header
    auth_env_var: SPLUNK_AUTH_TOKEN
    header_name: Authorization
    query_template: "/services/search/jobs/export?search=search {query} earliest={start} latest={end}&output_mode=json"
    response_path: "results"
    covers: ["generic_service"]
    max_rows_per_call: 200
```

`topology.example.yaml` (project root):

```yaml
# Copy to topology.yaml and extend with your own resource types. Coverage
# facts below are vendor-generic (not company-specific) and safe to keep as
# defaults; add your own surfaces/resource types as your stack grows.
surfaces:
  loki:
    tool_prefix: "mcp__loki__"
    covers: ["k8s_pod"]
    blind_to: ["lambda", "airflow_task", "ec2_instance", "batch_job"]
    coverage_note: "Loki typically only ingests container stdout/stderr shipped by a k8s log agent."

  cloudwatch:
    tool_prefix: "mcp__cloudwatch__"
    covers: ["lambda", "step_function", "airflow_task", "ec2_instance"]
    blind_to: ["k8s_pod"]
    coverage_note: "CloudWatch Logs covers what writes to a CloudWatch log group; most k8s workloads don't by default."

  datadog_logs:
    tool_prefix: "mcp__datadog__"
    covers: []
    blind_to: []
    coverage_note: "Datadog Logs coverage is opt-in per service via the log pipeline config. Absence of logs for a service is the ORDINARY case, not evidence the service is quiet -- confirm log collection is enabled for this service before treating an empty result as absence."

  datadog_apm:
    tool_prefix: "mcp__datadog__"
    covers: ["generic_service"]
    blind_to: []
    coverage_note: "APM traces are sampled. A missing error span is not proof no errors occurred."

  datadog_rum:
    tool_prefix: "mcp__datadog__"
    covers: ["browser_session"]
    blind_to: ["k8s_pod", "lambda", "ec2_instance"]
    coverage_note: "RUM is a separate product from Datadog Logs -- a log query never returns RUM data and vice versa."
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_config.py -v`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rcanalyst/config.py adapters.example.yaml topology.example.yaml tests/test_config.py
git commit -m "feat: add adapters.yaml/topology.yaml config loading with example files"
```

---

## Task 5: `correlate_ids` tool

**Files:**
- Create: `src/rcanalyst/tools/__init__.py`
- Create: `src/rcanalyst/tools/correlate_ids.py`
- Test: `tests/test_correlate_ids.py`

**Interfaces:**
- Consumes: `CorrelationCandidate`, `CorrelationResult` from `rcanalyst.models` (Task 1)
- Produces: `correlate_ids(evidence_snippets: list[str]) -> CorrelationResult` and `normalize_identifier(value: str) -> list[str]`, plus the module constants `KEY_PATTERNS`, `ASYNC_KEYS`, `DENYLIST`, in `rcanalyst.tools.correlate_ids`. Used by `server.py` (Task 10) and `plan_investigation` (Task 9A).

- [ ] **Step 1: Write the failing tests**

`tests/test_correlate_ids.py`:

```python
from rcanalyst.tools.correlate_ids import correlate_ids


def test_extracts_named_key_request_id():
    snippets = ['2026-09-15T10:00:00Z ERROR x-request-id=req-abc123 checkout failed']
    result = correlate_ids(snippets)
    assert len(result.candidates) == 1
    assert result.candidates[0].value == "req-abc123"
    assert result.candidates[0].key_name == "x-request-id"


def test_denylists_all_zero_uuid():
    """An all-zero trace id means propagation broke; querying on it returns the
    whole fleet, which reads as a broad incident. It must never be a candidate."""
    snippets = ['trace_id=00000000-0000-0000-0000-000000000000 request failed']
    result = correlate_ids(snippets)
    assert result.candidates == []


def test_short_non_discriminative_values_never_match():
    """'0'/'null' fall below the {6,} length floor, so they never reach DENYLIST."""
    snippets = ['trace_id=0 request failed', 'trace_id=null also failed']
    result = correlate_ids(snippets)
    assert result.candidates == []


def test_cross_snippet_co_occurrence_ranks_high():
    snippets = [
        '2026-09-15T10:00:00Z x-request-id=req-abc123 svc=checkout',
        '2026-09-15T10:00:01Z x-request-id=req-abc123 svc=payment',
    ]
    result = correlate_ids(snippets)
    assert len(result.candidates) == 1
    c = result.candidates[0]
    assert c.confidence == "high"
    assert set(c.seen_in_snippets) == {0, 1}


def test_single_occurrence_ranks_medium():
    snippets = ['x-request-id=req-xyz999 svc=checkout']
    result = correlate_ids(snippets)
    assert result.candidates[0].confidence == "medium"


def test_async_key_gets_forward_widened_window():
    snippets = ['2026-09-15T10:00:00Z message_id=msg-777 published to topic orders']
    result = correlate_ids(snippets)
    c = result.candidates[0]
    assert c.key_name == "message_id"
    assert c.suggested_window is not None
    start, end = c.suggested_window
    assert start < "2026-09-15T10:00:00"
    assert end > "2026-09-15T11:00:00"[:19]  # end is at least ~60 min after


def test_sync_key_gets_tight_symmetric_window():
    snippets = ['2026-09-15T10:00:00Z trace_id=abc123def456 svc=checkout']
    result = correlate_ids(snippets)
    c = result.candidates[0]
    start, end = c.suggested_window
    assert start < "2026-09-15T10:00:00"
    assert end > "2026-09-15T10:00:00"


def test_equivalent_forms_includes_hex_for_numeric_trace_id():
    """Datadog writes a trace id in decimal; W3C traceparent writes the same id in
    hex. Without this conversion the two spellings never intersect."""
    snippets = ['x-datadog-trace-id=4823516278365812 svc=checkout']
    result = correlate_ids(snippets)
    c = result.candidates[0]
    assert format(4823516278365812, "x") in c.equivalent_forms
    assert format(4823516278365812, "032x") in c.equivalent_forms


def test_no_matches_returns_empty_candidates():
    result = correlate_ids(["just a plain log line with no ids"])
    assert result.candidates == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_correlate_ids.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'rcanalyst.tools'`

- [ ] **Step 3: Implement correlate_ids.py**

`src/rcanalyst/tools/__init__.py`:

```python
"""Pure, MCP-independent business logic for each rcAnalyst tool."""
```

`src/rcanalyst/tools/correlate_ids.py`:

```python
from __future__ import annotations
import re
from datetime import datetime, timedelta
from rcanalyst.models import CorrelationCandidate, CorrelationResult

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_correlate_ids.py -v`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rcanalyst/tools/__init__.py src/rcanalyst/tools/correlate_ids.py tests/test_correlate_ids.py
git commit -m "feat: add correlate_ids tool with name-keyed extraction and async-widened windows"
```

---

## Task 6: `analyze_visual_evidence` tool

**Files:**
- Create: `src/rcanalyst/tools/analyze_visual_evidence.py`
- Test: `tests/test_analyze_visual_evidence.py`

**Interfaces:**
- Consumes: `HarEntry`, `VisualEvidenceResult` from `rcanalyst.models` (Task 1); `redact_headers`, `redact_url` from `rcanalyst.security` (Task 3)
- Produces: `analyze_visual_evidence(context: str, image_base64: str | None = None, har_json: str | None = None, har_path: str | None = None, slow_threshold_ms: float = 1000) -> VisualEvidenceResult` in `rcanalyst.tools.analyze_visual_evidence`, used by `server.py` (Task 10).

- [ ] **Step 1: Write the failing tests**

`tests/test_analyze_visual_evidence.py`:

```python
import json
from rcanalyst.tools.analyze_visual_evidence import analyze_visual_evidence

SAMPLE_HAR = {
    "log": {
        "entries": [
            {
                "request": {
                    "method": "GET",
                    "url": "https://api.example.com/checkout?token=SECRET123",
                    "headers": [
                        {"name": "x-request-id", "value": "req-abc123"},
                        {"name": "Authorization", "value": "Bearer super-secret-token"},
                        {"name": "Cookie", "value": "session=leak-me"},
                        {"name": "X-Custom-Internal", "value": "not-allowlisted"},
                    ],
                },
                "response": {"status": 500},
                "time": 1500,
            },
            {
                "request": {"method": "GET", "url": "https://api.example.com/ping", "headers": []},
                "response": {"status": 200},
                "time": 20,
            },
        ]
    }
}


def test_har_json_keeps_only_failed_and_slow_entries():
    result = analyze_visual_evidence(context="checkout failure", har_json=json.dumps(SAMPLE_HAR))
    assert len(result.har_entries) == 1
    assert result.har_entries[0].status == 500
    assert result.har_dropped_count == 1


def test_har_json_redacts_url_query_string():
    result = analyze_visual_evidence(context="x", har_json=json.dumps(SAMPLE_HAR))
    assert "SECRET123" not in result.har_entries[0].url
    assert result.har_entries[0].url == "https://api.example.com/checkout"


def test_har_json_never_returns_auth_or_cookie_headers():
    result = analyze_visual_evidence(context="x", har_json=json.dumps(SAMPLE_HAR))
    headers = result.har_entries[0].correlation_headers
    assert "Authorization" not in headers
    assert "Cookie" not in headers


def test_har_json_drops_non_allowlisted_headers():
    result = analyze_visual_evidence(context="x", har_json=json.dumps(SAMPLE_HAR))
    headers = result.har_entries[0].correlation_headers
    assert "X-Custom-Internal" not in headers


def test_har_json_keeps_correlation_header():
    result = analyze_visual_evidence(context="x", har_json=json.dumps(SAMPLE_HAR))
    headers = result.har_entries[0].correlation_headers
    assert headers.get("x-request-id") == "req-abc123"


def test_har_path_reads_from_file(tmp_path):
    p = tmp_path / "sample.har"
    p.write_text(json.dumps(SAMPLE_HAR))
    result = analyze_visual_evidence(context="x", har_path=str(p))
    assert len(result.har_entries) == 1


def test_image_base64_passed_through_with_note():
    result = analyze_visual_evidence(context="x", image_base64="ZmFrZWJhc2U2NA==")
    assert result.image_passthrough == "ZmFrZWJhc2U2NA=="
    assert any("multimodal" in n for n in result.notes)


def test_no_input_returns_empty_result():
    result = analyze_visual_evidence(context="x")
    assert result.har_entries == []
    assert result.image_passthrough is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_analyze_visual_evidence.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'rcanalyst.tools.analyze_visual_evidence'`

- [ ] **Step 3: Implement analyze_visual_evidence.py**

`src/rcanalyst/tools/analyze_visual_evidence.py`:

```python
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
        request = entry.get("request", {})
        response = entry.get("response", {})
        status = response.get("status", 0)
        time_ms = entry.get("time", 0)
        if not (status >= 400 or time_ms >= slow_threshold_ms):
            dropped += 1
            continue
        raw_headers = {h["name"]: h["value"] for h in request.get("headers", [])}
        corr_headers = redact_headers(raw_headers, allowlist=CORRELATION_HEADER_NAMES)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_analyze_visual_evidence.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rcanalyst/tools/analyze_visual_evidence.py tests/test_analyze_visual_evidence.py
git commit -m "feat: add analyze_visual_evidence tool with mandatory HAR redaction"
```

---

## Task 7: `query_generic_source` and `list_generic_sources` tools

**Files:**
- Create: `src/rcanalyst/tools/query_generic_source.py`
- Test: `tests/test_query_generic_source.py`

**Interfaces:**
- Consumes: `AdapterConfig` from `rcanalyst.config` (Task 4), `TimeRange`, `GenericQueryResult`, `SourceInfo` from `rcanalyst.models` (Task 1), `assert_host_allowed`, `safe_encode_param`, `assert_url_structure_unchanged`, `HostNotAllowedError` from `rcanalyst.security` (Task 3), `bound_json` from `rcanalyst.bounding` (Task 2)
- Produces: `query_generic_source(adapter: AdapterConfig, params: dict, time_range: TimeRange, allowed_hosts: list[str], cursor: str | None = None) -> GenericQueryResult` and `list_generic_sources(adapters: list[AdapterConfig]) -> list[dict]` in `rcanalyst.tools.query_generic_source`, used by `server.py` (Task 10).

- [ ] **Step 1: Write the failing tests**

`tests/test_query_generic_source.py`:

```python
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import pytest
from rcanalyst.config import AdapterConfig
from rcanalyst.models import TimeRange
from rcanalyst.tools.query_generic_source import query_generic_source, list_generic_sources


class _MockHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if "cursor=page2" in self.path:
            body = json.dumps({"rows": [{"line": "row-page-2"}]})
        elif "/big" in self.path:
            body = json.dumps({"rows": [{"line": f"row-{i}"} for i in range(50)]})
        else:
            body = json.dumps({"rows": [{"line": "row-1"}], "next_cursor": "page2"})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, format, *args):
        pass


@pytest.fixture(scope="module")
def mock_server():
    server = HTTPServer(("127.0.0.1", 0), _MockHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()


def _adapter_for(mock_server, **overrides) -> AdapterConfig:
    port = mock_server.server_address[1]
    defaults = dict(
        name="test-source",
        base_url=f"http://127.0.0.1:{port}",
        auth_mode="none",
        query_template="/search?q={query}&start={start}&end={end}",
        response_path="rows",
        pagination_cursor_field="next_cursor",
        pagination_cursor_param="cursor",
        max_rows_per_call=200,
    )
    defaults.update(overrides)
    return AdapterConfig(**defaults)


def test_query_generic_source_returns_rows(mock_server):
    adapter = _adapter_for(mock_server)
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.error is None
    assert result.rows == [{"line": "row-1"}]
    assert result.next_cursor == "page2"


def test_query_generic_source_flags_truncated_when_cursor_present(mock_server):
    adapter = _adapter_for(mock_server)
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.truncated is True


def test_query_generic_source_rejects_disallowed_host(mock_server):
    adapter = _adapter_for(mock_server)
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["some-other-host.internal"],
    )
    assert result.error is not None
    assert "not in the configured allowlist" in result.error


def test_query_generic_source_accepts_url_valued_query(mock_server):
    """Searching logs FOR a URL must work — the param is encoded, and structural
    safety is enforced on the built URL, not by banning substrings."""
    adapter = _adapter_for(mock_server)
    result = query_generic_source(
        adapter=adapter, params={"query": "https://api.example.com/checkout"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.error is None
    assert result.rows == [{"line": "row-1"}]


def test_query_generic_source_reports_missing_template_placeholder(mock_server):
    adapter = _adapter_for(mock_server, query_template="/search?q={query}&team={team}")
    result = query_generic_source(
        adapter=adapter, params={"query": "checkout"},  # 'team' not supplied
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.error is not None
    assert "placeholder not satisfied" in result.error


def test_query_generic_source_respects_max_rows_per_call(mock_server):
    adapter = _adapter_for(mock_server, query_template="/big?q={query}", max_rows_per_call=10)
    result = query_generic_source(
        adapter=adapter, params={"query": "x"},
        time_range=TimeRange(start="2026-09-15T00:00:00Z", end="2026-09-15T01:00:00Z"),
        allowed_hosts=["127.0.0.1"],
    )
    assert result.returned_count == 10
    assert result.truncated is True


def test_list_generic_sources_shape(mock_server):
    adapter = _adapter_for(mock_server, covers=["k8s_pod"])
    out = list_generic_sources([adapter])
    assert out[0]["name"] == "test-source"
    assert out[0]["covers"] == ["k8s_pod"]
    assert "auth_mode" in out[0]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_query_generic_source.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'rcanalyst.tools.query_generic_source'`

- [ ] **Step 3: Implement query_generic_source.py**

`src/rcanalyst/tools/query_generic_source.py`:

```python
from __future__ import annotations
import base64
import json
import os
import urllib.error
import urllib.request
from rcanalyst.bounding import bound_json
from rcanalyst.config import AdapterConfig, resolve_adapter_credential
from rcanalyst.models import GenericQueryResult, TimeRange
from rcanalyst.security import (
    assert_host_allowed, safe_encode_param, assert_url_structure_unchanged,
    HostNotAllowedError,
)

MAX_RESPONSE_BYTES = 2_000_000
REQUEST_TIMEOUT_SECONDS = 15


class _AllowlistRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Blocks an off-allowlist redirect BEFORE the new host is contacted.
    Checking response.geturl() after the fact is too late — the request has
    already been sent to the redirect target."""

    def __init__(self, allowed_hosts: list[str]) -> None:
        self.allowed_hosts = allowed_hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        assert_host_allowed(newurl, self.allowed_hosts)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _build_url(adapter: AdapterConfig, params: dict, time_range: TimeRange, cursor: str | None) -> str:
    substitutions = {"start": time_range.start, "end": time_range.end}
    for key, value in params.items():
        substitutions[key] = safe_encode_param(str(value))
    path = adapter.query_template.format(**substitutions)
    url = adapter.base_url.rstrip("/") + path
    if cursor and adapter.pagination_cursor_param:
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}{adapter.pagination_cursor_param}={safe_encode_param(cursor)}"
    return url


def _build_headers(adapter: AdapterConfig) -> dict[str, str]:
    headers: dict[str, str] = {}
    if adapter.auth_mode == "static_header":
        value = resolve_adapter_credential(adapter)
        headers[adapter.header_name or "Authorization"] = value or ""
    elif adapter.auth_mode == "basic":
        user = os.environ.get(adapter.basic_user_env_var or "", "")
        pw = os.environ.get(adapter.basic_pass_env_var or "", "")
        token = base64.b64encode(f"{user}:{pw}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    return headers


def _extract_rows(payload: dict, response_path: str | None) -> list[dict]:
    if not response_path:
        return payload if isinstance(payload, list) else payload.get("rows", [])
    node: object = payload
    for part in response_path.split("."):
        if isinstance(node, dict):
            node = node.get(part, [])
        else:
            return []
    return node if isinstance(node, list) else []


def query_generic_source(
    adapter: AdapterConfig,
    params: dict,
    time_range: TimeRange,
    allowed_hosts: list[str],
    cursor: str | None = None,
) -> GenericQueryResult:
    try:
        assert_host_allowed(adapter.base_url, allowed_hosts)
        url = _build_url(adapter, params, time_range, cursor)
        assert_url_structure_unchanged(url, adapter.base_url)
        headers = _build_headers(adapter)
        opener = urllib.request.build_opener(_AllowlistRedirectHandler(allowed_hosts))
        request = urllib.request.Request(url, headers=headers)
        with opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except HostNotAllowedError as e:
        return GenericQueryResult(rows=[], truncated=False, returned_count=0, error=str(e))
    except (KeyError, IndexError) as e:
        return GenericQueryResult(
            rows=[], truncated=False, returned_count=0,
            error=(
                f"query_template placeholder not satisfied: {e}. Every {{name}} in the "
                "template must be supplied in params (literal braces must be doubled)."
            ),
        )
    except ValueError as e:
        return GenericQueryResult(rows=[], truncated=False, returned_count=0, error=f"Rejected param: {e}")
    except urllib.error.URLError as e:
        return GenericQueryResult(rows=[], truncated=False, returned_count=0, error=f"query_generic_source failed: {e}")

    if len(raw) > MAX_RESPONSE_BYTES:
        return GenericQueryResult(
            rows=[], truncated=True, returned_count=0,
            error=f"Response exceeded {MAX_RESPONSE_BYTES} byte cap before parsing; narrow the query.",
        )

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        return GenericQueryResult(rows=[], truncated=False, returned_count=0, error=f"Non-JSON response: {e}")

    rows = _extract_rows(payload, adapter.response_path)
    next_cursor = payload.get(adapter.pagination_cursor_field) if adapter.pagination_cursor_field else None
    row_truncated = len(rows) > adapter.max_rows_per_call or bool(next_cursor)
    capped = rows[: adapter.max_rows_per_call]

    # A row cap alone is not enough — a handful of very large rows can still blow
    # the host's context, so apply the character bound too.
    bounded_text, char_truncated = bound_json({
        "rows": capped, "truncated": row_truncated, "returned_count": len(capped),
    })
    bounded = json.loads(bounded_text)

    return GenericQueryResult(
        rows=bounded["rows"],
        truncated=row_truncated or char_truncated,
        returned_count=len(bounded["rows"]),
        next_cursor=next_cursor,
    )


def list_generic_sources(adapters: list[AdapterConfig]) -> list[dict]:
    return [
        {
            "name": a.name,
            "base_url_host": a.base_url.split("://")[-1].split("/")[0],
            "auth_mode": a.auth_mode,
            "covers": a.covers,
        }
        for a in adapters
    ]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_query_generic_source.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rcanalyst/tools/query_generic_source.py tests/test_query_generic_source.py
git commit -m "feat: add query_generic_source and list_generic_sources tools with SSRF hardening"
```

---

## Task 8: `get_coverage` tool

**Files:**
- Create: `src/rcanalyst/tools/get_coverage.py`
- Test: `tests/test_get_coverage.py`

**Interfaces:**
- Consumes: `TopologyFile` from `rcanalyst.config` (Task 4), `CoverageResult` from `rcanalyst.models` (Task 1)
- Produces: `get_coverage(resource_type: str, topology: TopologyFile) -> CoverageResult` in `rcanalyst.tools.get_coverage`, used by `server.py` (Task 10).

- [ ] **Step 1: Write the failing tests**

`tests/test_get_coverage.py`:

```python
from rcanalyst.config import TopologyFile, SurfaceCoverage
from rcanalyst.tools.get_coverage import get_coverage


def _topology() -> TopologyFile:
    return TopologyFile(surfaces={
        "loki": SurfaceCoverage(covers=["k8s_pod"], blind_to=["lambda"]),
        "cloudwatch": SurfaceCoverage(covers=["lambda"], blind_to=["k8s_pod"]),
    })


def test_covering_surface_found():
    result = get_coverage("k8s_pod", _topology())
    assert result.covering_surfaces == ["loki"]
    assert "cloudwatch" in result.blind_surfaces
    assert result.unknown_coverage is False


def test_blind_surface_listed_for_other_resource():
    result = get_coverage("lambda", _topology())
    assert result.covering_surfaces == ["cloudwatch"]
    assert "loki" in result.blind_surfaces


def test_unknown_resource_type_flagged():
    result = get_coverage("airflow_task", _topology())
    assert result.covering_surfaces == []
    assert result.blind_surfaces == []
    assert result.unknown_coverage is True


def test_empty_topology_is_unknown():
    result = get_coverage("anything", TopologyFile(surfaces={}))
    assert result.unknown_coverage is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_get_coverage.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'rcanalyst.tools.get_coverage'`

- [ ] **Step 3: Implement get_coverage.py**

`src/rcanalyst/tools/get_coverage.py`:

```python
from __future__ import annotations
from rcanalyst.config import TopologyFile
from rcanalyst.models import CoverageResult


def get_coverage(resource_type: str, topology: TopologyFile) -> CoverageResult:
    covering: list[str] = []
    blind: list[str] = []
    known = False
    for name, surface in topology.surfaces.items():
        if resource_type in surface.covers:
            covering.append(name)
            known = True
        if resource_type in surface.blind_to:
            blind.append(name)
            known = True
    return CoverageResult(covering_surfaces=covering, blind_surfaces=blind, unknown_coverage=not known)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_get_coverage.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rcanalyst/tools/get_coverage.py tests/test_get_coverage.py
git commit -m "feat: add get_coverage tool for empty-is-not-absent judgements"
```

---

## Task 9: `validate_rca` tool

**Files:**
- Create: `src/rcanalyst/tools/validate_rca.py`
- Test: `tests/test_validate_rca.py`

**Interfaces:**
- Consumes: `ValidationGap`, `ValidationResult` from `rcanalyst.models` (Task 1)
- Produces: `validate_rca(claim_json: dict, investigation_log: list[dict]) -> ValidationResult` in `rcanalyst.tools.validate_rca`, used by `server.py` (Task 10) and `hooks/stop_validate.py` (Task 12).

- [ ] **Step 1: Write the failing tests**

`tests/test_validate_rca.py`:

```python
from rcanalyst.tools.validate_rca import validate_rca


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
    claim = _valid_claim()
    del claim["root_cause"]
    result = validate_rca(claim, [])
    assert result.required_action is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_validate_rca.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'rcanalyst.tools.validate_rca'`

- [ ] **Step 3: Implement validate_rca.py**

`src/rcanalyst/tools/validate_rca.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_validate_rca.py -v`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rcanalyst/tools/validate_rca.py tests/test_validate_rca.py
git commit -m "feat: add validate_rca deterministic envelope linter"
```

---

## Task 9A: `plan_investigation` tool (the bare-identifier entry point)

**Files:**
- Create: `src/rcanalyst/tools/plan_investigation.py`
- Test: `tests/test_plan_investigation.py`

**Interfaces:**
- Consumes: `IdentifierPlan`, `SourceCandidate` from `rcanalyst.models` (Task 1); `normalize_identifier`, `KEY_PATTERNS`, `ASYNC_KEYS` from `rcanalyst.tools.correlate_ids` (Task 5); `AdapterConfig`, `TopologyFile` from `rcanalyst.config` (Task 4)
- Produces: `plan_investigation(identifier: str, environment: str | None, adapters: list[AdapterConfig], topology: TopologyFile) -> IdentifierPlan` in `rcanalyst.tools.plan_investigation`, used by `server.py` (Task 10).

**Why this exists:** `correlate_ids` takes snippets you have already collected — it
is useless when a bare id *is* the starting point ("RCA for session abc-123").
This tool is its front half: same normalization, run in the opposite direction.

- [ ] **Step 1: Write the failing tests**

`tests/test_plan_investigation.py`:

```python
from rcanalyst.config import AdapterConfig, SurfaceCoverage, TopologyFile
from rcanalyst.tools.plan_investigation import plan_investigation


def _adapters() -> list[AdapterConfig]:
    return [
        AdapterConfig(name="loki", base_url="https://loki.x", query_template="/q?q={query}", covers=["k8s_pod"]),
        AdapterConfig(name="splunk", base_url="https://splunk.x", query_template="/q?q={query}", covers=["generic_service"]),
    ]


def _topology() -> TopologyFile:
    return TopologyFile(surfaces={
        "loki": SurfaceCoverage(covers=["k8s_pod"], blind_to=["lambda"]),
        "cloudwatch": SurfaceCoverage(covers=["lambda"], blind_to=["k8s_pod"]),
    })


def test_classifies_uuid():
    plan = plan_investigation("3f2504e0-4f89-11d3-9a0c-0305e82c3301", None, [], TopologyFile())
    assert plan.identifier_kind == "uuid"


def test_classifies_w3c_trace():
    plan = plan_investigation("4bf92f3577b34da6a3ce929d0e0e4736", None, [], TopologyFile())
    assert plan.identifier_kind == "w3c_trace"


def test_classifies_datadog_decimal_trace():
    plan = plan_investigation("4823516278365812", None, [], TopologyFile())
    assert plan.identifier_kind == "datadog_decimal_trace"


def test_classifies_aws_xray():
    plan = plan_investigation("1-5759e988-bd862e3fe1be46a994272793", None, [], TopologyFile())
    assert plan.identifier_kind == "aws_xray"


def test_classifies_opaque_session_id():
    plan = plan_investigation("sess_abc123XYZ", None, [], TopologyFile())
    assert plan.identifier_kind == "opaque"


def test_decimal_trace_offers_hex_equivalent_form():
    plan = plan_investigation("4823516278365812", None, [], TopologyFile())
    assert format(4823516278365812, "x") in plan.equivalent_forms


def test_suggests_key_names_to_search():
    plan = plan_investigation("3f2504e0-4f89-11d3-9a0c-0305e82c3301", None, [], TopologyFile())
    assert "x-request-id" in plan.likely_key_names
    assert "trace_id" in plan.likely_key_names


def test_lists_configured_adapters_as_queryable():
    plan = plan_investigation("sess_abc123XYZ", None, _adapters(), TopologyFile())
    names = {s.name for s in plan.queryable_sources if s.kind == "configured_adapter"}
    assert names == {"loki", "splunk"}


def test_lists_coverage_surfaces_as_queryable():
    plan = plan_investigation("sess_abc123XYZ", None, [], _topology())
    names = {s.name for s in plan.queryable_sources if s.kind == "coverage_surface"}
    assert names == {"loki", "cloudwatch"}


def test_no_sources_configured_flags_unknown_coverage():
    plan = plan_investigation("sess_abc123XYZ", None, [], TopologyFile())
    assert plan.unknown_coverage is True
    assert any("no configured sources" in step.lower() for step in plan.next_steps)


def test_async_shaped_identifier_widens_window_hint():
    plan = plan_investigation("msg-00ab12cd34ef", None, [], TopologyFile())
    assert plan.is_async_shaped is True
    assert "60" in plan.suggested_window_hint


def test_sync_identifier_keeps_tight_window_hint():
    plan = plan_investigation("3f2504e0-4f89-11d3-9a0c-0305e82c3301", None, [], TopologyFile())
    assert plan.is_async_shaped is False
    assert "2" in plan.suggested_window_hint


def test_next_steps_mention_correlate_ids_handoff():
    plan = plan_investigation("sess_abc123XYZ", None, _adapters(), TopologyFile())
    assert any("correlate_ids" in step for step in plan.next_steps)


def test_environment_echoed_into_next_steps_when_given():
    plan = plan_investigation("sess_abc123XYZ", "staging", _adapters(), TopologyFile())
    assert any("staging" in step for step in plan.next_steps)


def test_environment_missing_prompts_for_it():
    plan = plan_investigation("sess_abc123XYZ", None, _adapters(), TopologyFile())
    assert any("environment" in step.lower() for step in plan.next_steps)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_plan_investigation.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'rcanalyst.tools.plan_investigation'`

- [ ] **Step 3: Implement plan_investigation.py**

`src/rcanalyst/tools/plan_investigation.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_plan_investigation.py -v`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add src/rcanalyst/tools/plan_investigation.py tests/test_plan_investigation.py
git commit -m "feat: add plan_investigation tool for bare-identifier RCA entry point"
```

---

## Task 10: MCP server wiring (stdio + HTTP transports)

**Files:**
- Create: `src/rcanalyst/server.py`
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: all tool functions from Tasks 5–9A, `load_adapters`/`load_topology` from `rcanalyst.config` (Task 4)
- Produces: the `mcp` `FastMCP` instance and seven registered tools — `plan_investigation`, `correlate_ids`, `analyze_visual_evidence`, `query_generic_source`, `list_generic_sources`, `get_coverage`, `validate_rca` — plus the `main()` entrypoint referenced by `pyproject.toml`'s `[project.scripts]`.

- [ ] **Step 1: Write the failing test**

`tests/test_server.py`:

```python
import asyncio
from rcanalyst.server import mcp


def test_all_expected_tools_are_registered():
    tools = asyncio.run(mcp.list_tools())
    names = {t.name for t in tools}
    assert names == {
        "correlate_ids", "analyze_visual_evidence", "query_generic_source",
        "list_generic_sources", "get_coverage", "validate_rca",
        "plan_investigation",
    }


def test_correlate_ids_tool_returns_plain_dict():
    result = asyncio.run(mcp.call_tool("correlate_ids", {"evidence_snippets": ["x-request-id=req-1"]}))
    # FastMCP wraps tool results in content blocks; assert it ran without error.
    assert result is not None


def test_server_has_instructions_mentioning_sibling_mcps():
    assert "vendor MCP" in mcp.instructions or "vendor" in mcp.instructions.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_server.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'rcanalyst.server'`

- [ ] **Step 3: Implement server.py**

`src/rcanalyst/server.py`:

```python
from __future__ import annotations
import logging
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

logging.basicConfig(stream=sys.stderr, level=logging.INFO)
logger = logging.getLogger("rcanalyst")

from mcp.server.fastmcp import FastMCP  # noqa: E402

from rcanalyst.config import load_adapters, load_topology, AdaptersFile  # noqa: E402
from rcanalyst.models import TimeRange  # noqa: E402
from rcanalyst.tools.correlate_ids import correlate_ids as _correlate_ids  # noqa: E402
from rcanalyst.tools.analyze_visual_evidence import analyze_visual_evidence as _analyze_visual_evidence  # noqa: E402
from rcanalyst.tools.query_generic_source import (  # noqa: E402
    query_generic_source as _query_generic_source,
    list_generic_sources as _list_generic_sources,
)
from rcanalyst.tools.get_coverage import get_coverage as _get_coverage  # noqa: E402
from rcanalyst.tools.plan_investigation import plan_investigation as _plan_investigation  # noqa: E402
from rcanalyst.tools.validate_rca import validate_rca as _validate_rca  # noqa: E402

INSTRUCTIONS = (
    "rcAnalyst provides RCA building-block tools for a Claude session "
    "investigating an incident. It has no orchestration logic of its own — "
    "read the rca-methodology skill/prompt before using these tools. Prefer "
    "your own already-connected vendor MCP (Datadog, Splunk, GitLab, "
    "Sourcegraph, etc.) for logs, metrics, and code; use query_generic_source "
    "ONLY when no such vendor MCP covers the source in question. "
    "Starting from a bare identifier (session/request/trace id) with no logs "
    "yet? Call plan_investigation first. Already holding log snippets? Use "
    "correlate_ids. Finish by calling validate_rca, and emit the envelope "
    "fenced between BEGIN_RCANALYST_RESULT_JSON and END_RCANALYST_RESULT_JSON."
)

# An MCP server launched as a subprocess by Claude Desktop/Code inherits an
# unpredictable cwd (often "/"), so cwd-relative config would silently never
# resolve. RCANALYST_CONFIG_DIR is the documented knob; CLAUDE_PROJECT_DIR is
# injected by Claude Code and is the sensible default for plugin installs.
_CONFIG_DIR = Path(
    os.environ.get("RCANALYST_CONFIG_DIR")
    or os.environ.get("CLAUDE_PROJECT_DIR")
    or Path.cwd()
)
ADAPTERS_PATH = _CONFIG_DIR / "adapters.yaml"
TOPOLOGY_PATH = _CONFIG_DIR / "topology.yaml"

mcp = FastMCP("rcanalyst", instructions=INSTRUCTIONS)


def _adapters() -> AdaptersFile:
    return load_adapters(ADAPTERS_PATH)


def _allowed_hosts(adapters: AdaptersFile) -> list[str]:
    return [urlparse(a.base_url).hostname for a in adapters.sources if urlparse(a.base_url).hostname]


@mcp.tool()
def correlate_ids(evidence_snippets: list[str]) -> dict:
    """Extract and rank correlation IDs (request/trace/span/message/job) shared
    across log snippets you've already collected elsewhere. Use this to carry
    an identifier forward across a sync-to-async hop (e.g. an HTTP request
    into a Kafka consumer)."""
    return _correlate_ids(evidence_snippets).model_dump()


@mcp.tool()
def plan_investigation(identifier: str, environment: str | None = None) -> dict:
    """START HERE when the user hands you a bare identifier — a session id,
    request id, trace id, or correlation id — with no logs yet. Classifies the
    identifier's shape, returns every vendor spelling it may appear under, names
    which configured sources and coverage surfaces can answer for it, and
    suggests a time window (widened when the id looks async). Use correlate_ids
    instead once you already have log snippets in hand."""
    return _plan_investigation(
        identifier=identifier, environment=environment,
        adapters=_adapters().sources, topology=load_topology(TOPOLOGY_PATH),
    ).model_dump()


@mcp.tool()
def analyze_visual_evidence(
    context: str,
    image_base64: str | None = None,
    har_json: str | None = None,
    har_path: str | None = None,
    slow_threshold_ms: float = 1000,
) -> dict:
    """Extract structured evidence from a HAR / browser network-tab export:
    failed and slow requests, with correlation headers, redacted.

    If you already have a screenshot in your own context, reason about it
    directly — do NOT pass it here. The image_base64 parameter returns the image
    unchanged (this tool runs no vision model), so round-tripping one you can
    already see just puts a second copy in your context. Pass it only if you
    need the image echoed back alongside HAR findings."""
    return _analyze_visual_evidence(
        context=context, image_base64=image_base64, har_json=har_json,
        har_path=har_path, slow_threshold_ms=slow_threshold_ms,
    ).model_dump()


@mcp.tool()
def query_generic_source(source: str, params: dict[str, Any], start: str, end: str, cursor: str | None = None) -> dict:
    """Query a source declared in adapters.yaml via a config-templated REST
    call. Use ONLY when no vendor MCP (Datadog/Splunk/Loki/etc.) already
    covers this source — prefer your own connected MCPs first."""
    adapters = _adapters()
    match = next((a for a in adapters.sources if a.name == source), None)
    if match is None:
        return {"rows": [], "truncated": False, "returned_count": 0, "error": f"Unknown source '{source}'. Call list_generic_sources first."}
    result = _query_generic_source(
        adapter=match, params=params, time_range=TimeRange(start=start, end=end),
        allowed_hosts=_allowed_hosts(adapters), cursor=cursor,
    )
    return result.model_dump()


@mcp.tool()
def list_generic_sources() -> list[dict]:
    """List the sources declared in adapters.yaml for this deployment."""
    return _list_generic_sources(_adapters().sources)


@mcp.tool()
def get_coverage(resource_type: str) -> dict:
    """Look up which observability surfaces cover (or are blind to) a resource
    type, from topology.yaml. If unknown_coverage is true, you may NOT
    conclude absence from an empty query result for this resource type."""
    return _get_coverage(resource_type, load_topology(TOPOLOGY_PATH)).model_dump()


@mcp.tool()
def validate_rca(claim_json: dict[str, Any], investigation_log: list[dict[str, Any]] | None = None) -> dict:
    """Deterministically lint a draft RCA's structured claim before you post it.
    Call this before finalizing any RCA, and emit the envelope fenced between
    BEGIN_RCANALYST_RESULT_JSON and END_RCANALYST_RESULT_JSON — on Claude Code a
    Stop hook re-runs this check against that block regardless."""
    return _validate_rca(claim_json, investigation_log or []).model_dump()


def main() -> None:
    transport = "streamable-http" if len(sys.argv) > 1 and sys.argv[1] == "--http" else "stdio"
    logger.info("Starting rcanalyst MCP server (transport=%s)", transport)
    mcp.run(transport=transport)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_server.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `pytest -v`
Expected: PASS (all tests across Tasks 1–10)

- [ ] **Step 6: Commit**

```bash
git add src/rcanalyst/server.py tests/test_server.py
git commit -m "feat: wire all tools into MCP server with stdio/HTTP transports"
```

---

## Task 11: RCA methodology skill

**Files:**
- Create: `skills/rca-methodology/SKILL.md`

**Interfaces:**
- Consumes: nothing (pure documentation)
- Produces: the skill file referenced by `.claude-plugin/plugin.json` (Task 12) and by the README (Task 13).

- [ ] **Step 1: Write the skill content**

`skills/rca-methodology/SKILL.md` (written with a four-backtick fence here because
the file's own content contains a fenced block — write the file with the inner
three-backtick fences intact):

````markdown
---
name: rca-methodology
description: Use when investigating a production incident, alert, or bug report with rcAnalyst's tools — encodes the investigation discipline that turns tool calls into a trustworthy root-cause analysis.
---

# RCA Methodology

You are investigating a production incident. You have your own connected MCP
tools (Datadog, Splunk, Loki, GitLab, Sourcegraph, PagerDuty, or whatever your
session has) plus rcAnalyst's tools: `plan_investigation`, `correlate_ids`,
`analyze_visual_evidence`, `query_generic_source`, `list_generic_sources`,
`get_coverage`, `validate_rca`.

rcAnalyst has no orchestration logic of its own — you decide what to query,
how deep to go, and when to stop. rcAnalyst's tools are building blocks and a
final lint gate, not a substitute for your own judgment.

## Where to start, by what you were given

**A question in plain language** ("why is checkout 500ing in prod since 10am").
This is the most common case. Establish the environment and the time window,
then go straight to your own connected log/APM tools for the named service.
rcAnalyst contributes the discipline below and the final gate — it has no
"search everything" tool, by design, because your vendor MCPs already do that
better with your own credentials.

**A bare identifier** (session id, request id, trace id) with no logs yet. Call
`plan_investigation(identifier, environment)`. It tells you what kind of id it
is, every spelling it may appear under (vendors differ: Datadog writes a trace
id in decimal, W3C in hex), which of your sources can answer for it, and how
wide a window to use. Do not call `correlate_ids` here — that tool needs
snippets you have not collected yet.

**A screenshot.** Reason about it directly; you can already see it. Extract the
failing URL, status code, and any visible id, then treat those as the starting
evidence. Do not pass the image to `analyze_visual_evidence` — that returns it
unchanged and just duplicates it in your context.

**A HAR / network-tab export.** Call `analyze_visual_evidence(har_path=...)`.
It returns only the failed and slow requests, with correlation headers, safely
redacted — the fastest path from "the UI is broken" to a backend trace id.

## Before you start

State (or ask for, if ambiguous) the **environment** (prod / staging /
whatever your deployment names are) explicitly. Unlike a fully unattended
system, a human is present here — one clarifying question about environment
or which specific resource is affected is expected and encouraged, not
forbidden. A wrong-environment investigation produces a confident, silently
wrong answer with nothing else to catch it.

Inventory what you actually have: which vendor MCP tools are connected in
this session (their names tell you roughly what they cover), and whether
`adapters.yaml`/`topology.yaml` are configured for anything else.

## Five rules

### 1. Trace to terminal

A downstream's 5xx, `Unavailable`, `DeadlineExceeded`, `i/o timeout`, or
`context deadline exceeded`, seen at a client-adapter boundary path
(`external/`, `clients/`, `adapters/`, `*_client.*`, `*Stub.*`) is the RPC
boundary, not the cause. Keep querying the named downstream's own logs until
the exception originates there, or names an external vendor at the boundary.
Only then is it strong evidence. Soft cap: 10 hops, then stop and report
`partial_evidence` naming the open question.

A generic error (a 5xx, a panic, a `NullPointerException`) is a symptom — the
real exception usually sits in a WARN/INFO line one hop away. Query more
narrowly before concluding.

"Cache miss + slow fallback" is not a cause — the fallback was slow or errored
for a reason, and that reason is the RCA.

### 2. Empty is not absent

Before treating a zero-result query as "this did not happen," call
`get_coverage(resource_type)`. If `unknown_coverage: true`, you may not
conclude absence — say what you couldn't check instead. Otherwise, work
through these in order:
- **Wrong window** — rule this out first. Re-derive the window from the
  alert's own timestamp; confirm it's UTC and runs forward.
- **Backend unreachable/erroring** — stop, report `primary_backend_unreachable`,
  don't pivot to another backend to manufacture a story.
- **Backend healthy but blind to this resource** (per `get_coverage`) — a
  routing fact, not a finding; re-ask on a surface that covers it.
- **Backend healthy, covers the resource, quiet window** — genuine absence,
  report it.

### 3. Reconcile magnitude

The cited driver's frequency × per-call cost must reproduce the alarm's
actual numeric value. If it doesn't, the cause is incomplete — a volume
driver (one tenant's burst, a batch job) is usually the real cause. **Never
reconcile magnitude against a `truncated: true` result** — a truncated count
is not the real count.

### 4. Decompose the series

An alert is a claim about a measured series. Break it down by whatever
dimension varies in the window (tenant, endpoint, pod, region — there's no
fixed list). A pattern claim ("this is a leak", "one tenant") made without
that breakdown is a guess. Any RCA that cites a metric must record what it
was decomposed by (`decomposed_by` in the envelope) — `validate_rca` rejects
a metric-anchored claim with no decomposition.

### 5. Humans outrank logs

If a PagerDuty (or equivalent incident-management) MCP is connected, its
responder notes/related incidents often *are* the RCA — confirm and report
that chain rather than contradicting it with a guessed code path. If no such
tool is connected, ask the responder directly what's already known before
investigating — don't silently skip this rule for lack of a tool.

## Enrichment order

Read code (via your GitLab/Sourcegraph MCP, or `query_generic_source` as a
last resort) only **after** an investigator has returned a suspect
`file:line`, exception type, or symbol — never at the start. A host session
commonly has a code-search tool ready and reaching for it first is the
easiest way to manufacture a false narrative for what is actually an
infrastructure or operational cause.

## Async tracing

To trace a bug from a sync request into an async hop (a Kafka consumer, an
SQS handler, a background job), call `correlate_ids` on the log snippets
you've collected. It returns each candidate's `suggested_window` — widened
and forward-biased for message/job-shaped keys, since a lagging consumer's
log can trail the producer's by tens of minutes. An empty result on an async
hop queried with a tight window is a wrong-window empty, not an absence.

## Before you finalize

Call `validate_rca(claim_json, investigation_log)` with your draft envelope
and a list of what you actually queried. If it returns `approved: false`,
address every blocking gap before posting — on Claude Code, a Stop hook
re-checks this regardless of whether you remembered to call it.

## Output

Confidence levels: `strong_evidence` (terminal cause traced, or a vendor
boundary confirmed, or a fully reconciled metric), `partial_evidence` (real
evidence pointing at a cause, chain not fully traced), `inconclusive` (data
unavailable or backend unreachable). A resolved condition — a threshold
breach that cleared on its own, evidenced by reading past the peak — is a
full `strong_evidence` answer, not a weaker one.

Write the RCA with: a one-sentence TL;DR (terminal cause, service, when it
crossed threshold), an Evidence section (each row inside the `alert_window`),
and Recommendations (verb-first, ≤3).

Then, as the **last thing in your turn, every time** — success, partial, or
inconclusive — emit the structured envelope fenced with these exact sentinels:

```
BEGIN_RCANALYST_RESULT_JSON
{
  "confidence": "strong_evidence|partial_evidence|inconclusive",
  "status": "success|partial|inconclusive",
  "root_cause": "one-line summary",
  "affected_services": ["svc1"],
  "environment": "prod",
  "alert_window": {"start": "ISO8601", "end": "ISO8601"},
  "evidence": [
    {"timestamp": "ISO8601", "text": "exception or metric value",
     "source_ref": "file:line or surface", "environment": "prod"}
  ],
  "hop_trace": {"hop_count": 2, "stop_reason": "terminal|vendor_boundary|hop_cap_reached"},
  "decomposed_by": "tenant_id"
}
END_RCANALYST_RESULT_JSON
```

The sentinels are not decoration: on Claude Code a Stop hook greps for exactly
this block and re-runs `validate_rca` against it before your turn is allowed to
end. A turn that ends on narration with no envelope is the single most common
way an investigation's work gets thrown away. Omit `decomposed_by` only when no
metric is cited; include every other key.
````

- [ ] **Step 2: Commit**

```bash
git add skills/rca-methodology/SKILL.md
git commit -m "docs: add generalized rca-methodology skill"
```

---

## Task 12: Claude Code plugin bundle (Stop hook enforcement)

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `hooks/stop_validate.py`
- Test: `tests/test_stop_validate.py`

**Interfaces:**
- Consumes: `validate_rca` from `rcanalyst.tools.validate_rca` (Task 9)
- Produces: the plugin manifest and the Stop hook script; no other task depends on this one.

- [ ] **Step 1: Write the failing tests**

`tests/test_stop_validate.py`:

```python
import json
import subprocess
import sys
from pathlib import Path

HOOK_PATH = Path(__file__).parent.parent / "hooks" / "stop_validate.py"


VALID_ENVELOPE = {
    "confidence": "strong_evidence", "status": "success",
    "root_cause": "db timeout", "affected_services": ["svc"],
    "environment": "prod",
    "alert_window": {"start": "2026-09-15T10:00:00Z", "end": "2026-09-15T10:10:00Z"},
    "evidence": [
        {"timestamp": "2026-09-15T10:05:00Z", "text": "conn pool exhausted", "source_ref": "svc/db.go:1", "environment": "prod"},
        {"timestamp": "2026-09-15T10:05:01Z", "text": "500 to caller", "source_ref": "svc/handler.go:2", "environment": "prod"},
    ],
    "hop_trace": {"hop_count": 1, "stop_reason": "terminal"},
}


def _run_hook(payload: dict) -> dict:
    result = subprocess.run(
        [sys.executable, str(HOOK_PATH)], input=json.dumps(payload),
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout) if result.stdout.strip() else {}


def _fenced(envelope_text: str) -> str:
    return (
        "## RCA\nsome prose\n"
        f"BEGIN_RCANALYST_RESULT_JSON\n{envelope_text}\nEND_RCANALYST_RESULT_JSON"
    )


def test_no_envelope_does_not_block():
    out = _run_hook({"last_assistant_message": "Just a normal reply with no RCA in it."})
    assert out == {}


def test_valid_envelope_does_not_block():
    out = _run_hook({"last_assistant_message": _fenced(json.dumps(VALID_ENVELOPE))})
    assert out == {}


def test_invalid_envelope_blocks():
    bad = {"confidence": "strong_evidence", "status": "success", "root_cause": "x",
           "affected_services": ["svc"], "environment": "prod"}
    out = _run_hook({"last_assistant_message": _fenced(json.dumps(bad))})
    assert out.get("decision") == "block"
    assert "reason" in out


def test_malformed_json_envelope_blocks():
    out = _run_hook({"last_assistant_message": _fenced("{not valid json")})
    assert out.get("decision") == "block"


def test_stop_hook_active_short_circuits():
    """Without this guard a blocking hook re-fires forever."""
    bad = {"confidence": "strong_evidence"}
    out = _run_hook({
        "last_assistant_message": _fenced(json.dumps(bad)),
        "stop_hook_active": True,
    })
    assert out == {}


def test_falls_back_to_transcript_when_no_last_assistant_message(tmp_path):
    p = tmp_path / "transcript.jsonl"
    entry = {"type": "assistant", "message": {"content": [
        {"type": "text", "text": _fenced(json.dumps(VALID_ENVELOPE))}
    ]}}
    p.write_text(json.dumps(entry) + "\n")
    out = _run_hook({"transcript_path": str(p)})
    assert out == {}


def test_no_input_at_all_does_not_block():
    out = _run_hook({})
    assert out == {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_stop_validate.py -v`
Expected: FAIL — `hooks/stop_validate.py` does not exist yet

- [ ] **Step 3: Implement the plugin manifest and Stop hook**

`.claude-plugin/plugin.json`:

```json
{
  "name": "rcanalyst",
  "version": "0.1.0",
  "description": "Generic, credential-free RCA investigation tools and methodology, composing with whatever vendor MCPs are already connected.",
  "mcpServers": {
    "rcanalyst": {
      "command": "uv",
      "args": ["run", "--directory", "${CLAUDE_PLUGIN_ROOT}", "rcanalyst"],
      "env": { "RCANALYST_CONFIG_DIR": "${CLAUDE_PROJECT_DIR}" }
    }
  },
  "hooks": {
    "hooks": {
      "Stop": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/stop_validate.py",
              "timeout": 30
            }
          ]
        }
      ]
    }
  }
}
```

Three things here are easy to get wrong and are all deliberate:
- `hooks` takes the **full hook-config object** (`{"hooks": {"<Event>": [{"hooks": [...]}]}}`),
  not `{"Stop": ["path.py"]}`. Stop supports no `matcher`, so none is set.
- There is no `skills` key — `skills/rca-methodology/SKILL.md` is auto-discovered from the
  plugin's `skills/` directory.
- `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are required; bare relative paths do
  not resolve for a plugin-launched stdio server. `uvx rcanalyst` would resolve from the
  package index and cannot run this unpublished, plugin-local package.

`hooks/stop_validate.py`:

```python
#!/usr/bin/env python3
"""Claude Code Stop hook: validates the just-finished turn's RCA envelope
against rcanalyst's validate_rca gates before allowing the session to stop.

Input: JSON on stdin per Claude Code's Stop hook contract. Prefers
`last_assistant_message`; falls back to walking `transcript_path` (that file is
written asynchronously and can lag the current turn, so it is the fallback, not
the primary source).
Output: on a blocking gap, prints {"decision": "block", "reason": "..."} to
stdout. If no RCA envelope is present in the last assistant turn at all, this
hook does not block — an ordinary non-RCA turn is not forced to emit one.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from rcanalyst.tools.validate_rca import validate_rca  # noqa: E402

# Match the fenced block first, then parse what's inside it. A single regex that
# also had to match balanced JSON would silently fail to match malformed JSON —
# which is exactly the case that most needs to be reported.
BLOCK_PATTERN = re.compile(
    r"BEGIN_RCANALYST_RESULT_JSON(.*?)END_RCANALYST_RESULT_JSON", re.DOTALL
)


def _last_assistant_text(transcript_path: str) -> str | None:
    try:
        lines = Path(transcript_path).read_text().splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") == "assistant":
            content = entry.get("message", {}).get("content", [])
            texts = [c.get("text", "") for c in content if c.get("type") == "text"]
            if texts:
                return "\n".join(texts)
    return None


def main() -> None:
    raw_stdin = sys.stdin.read() or "{}"
    payload = json.loads(raw_stdin)

    # Without this guard, a blocking verdict re-triggers this hook forever.
    if payload.get("stop_hook_active"):
        return

    text = payload.get("last_assistant_message")
    if not text:
        transcript_path = payload.get("transcript_path")
        text = _last_assistant_text(transcript_path) if transcript_path else None
    if not text:
        return

    match = BLOCK_PATTERN.search(text)
    if not match:
        return

    try:
        claim_json = json.loads(match.group(1).strip())
    except json.JSONDecodeError:
        print(json.dumps({
            "decision": "block",
            "reason": "RCA result block is present but is not valid JSON. Fix and re-emit it.",
        }))
        return

    result = validate_rca(claim_json, investigation_log=[])
    if not result.approved:
        reasons = "; ".join(f"[{g.name}] {g.detail}" for g in result.gaps if g.severity == "blocking")
        print(json.dumps({"decision": "block", "reason": f"validate_rca rejected this RCA: {reasons}"}))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `chmod +x hooks/stop_validate.py && pytest tests/test_stop_validate.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/plugin.json hooks/stop_validate.py tests/test_stop_validate.py
git commit -m "feat: add Claude Code plugin bundle with Stop-hook RCA validation"
```

---

## Task 13: README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only)
- Produces: nothing consumed by other tasks; this is the last task.

- [ ] **Step 1: Write the README**

`README.md` (four-backtick fence here because the file contains its own fenced
blocks — write the file with the inner three-backtick fences intact):

````markdown
# rcAnalyst

A generic, credential-free MCP server that gives any Claude session
(Claude Code, Claude Desktop, claude.ai) RCA-investigation building blocks —
plus a ported, vendor-agnostic investigation methodology. It runs no LLM loop
of its own and holds no Anthropic API key: the host Claude session you
already have open does all the reasoning, using its own credentials for
whatever vendor MCPs (Datadog, Splunk, GitLab, Sourcegraph, PagerDuty, ...)
you already have connected.

## What it is NOT

- Not a Datadog/Splunk/GitLab client — it never talks to those vendors
  directly. If you have a vendor MCP connected, your host Claude uses that,
  with your own credentials for it.
- Not a server-side agent — no orchestration loop, no Anthropic API key, no
  server cost.
- Not stateful — no query history, no cache, no session store. Every tool
  call is independent.

## Install

`rcanalyst` is not published to PyPI — run it from a local checkout. `uvx
rcanalyst` will NOT work (it resolves from the package index).

```bash
git clone <this repo> ~/rcAnalyst
uv run --directory ~/rcAnalyst rcanalyst --help
```

### Claude Code (recommended — gets enforcement)

Install as a plugin (bundles the MCP server, the rca-methodology skill, and a
`Stop` hook that validates any RCA envelope your session claims to have
produced, before the turn can end):

```bash
claude plugin install ~/rcAnalyst
```

### Claude Desktop / other MCP hosts

Add to your MCP config (e.g. `claude_desktop_config.json`), using an absolute
path — a `uv run --directory` invocation, not `uvx`:

```json
{
  "mcpServers": {
    "rcanalyst": {
      "command": "uv",
      "args": ["run", "--directory", "/absolute/path/to/rcAnalyst", "rcanalyst"],
      "env": { "RCANALYST_CONFIG_DIR": "/absolute/path/to/your/config/dir" }
    }
  }
}
```

No plugin mechanism exists on these hosts, so there's no Stop-hook
enforcement — `validate_rca` is a tool your session can call (and the
methodology is delivered via the server's MCP `instructions`/`prompts`), but
following it is best-effort, not guaranteed. This is a known, accepted
tradeoff, not parity with the Claude Code experience.

### claude.ai

Run with the HTTP transport and register it as a remote MCP server:

```bash
uv run --directory /absolute/path/to/rcAnalyst rcanalyst --http
```

## Configure your own sources (optional)

You almost certainly already have MCPs for your vendors — rcAnalyst is
designed to compose with those, not replace them. Only fill in
`adapters.yaml` for a backend that genuinely has no MCP (an in-house log API,
for example):

```bash
cp adapters.example.yaml adapters.yaml
cp topology.example.yaml topology.yaml
# edit both — adapters.yaml has 3 working reference configs (Loki, OpenSearch,
# Splunk-style) to copy from; topology.yaml already has vendor-generic
# coverage facts, add your own resource types as needed.
```

Both files are read from `RCANALYST_CONFIG_DIR` (falling back to
`CLAUDE_PROJECT_DIR`, then the process cwd). Set it explicitly — an MCP server
launched by a desktop host inherits an unpredictable working directory, so
relying on cwd usually means your config is silently never found.

## How you actually use it

**Ask a question.** The common case. You already have your vendor MCPs
connected; rcAnalyst supplies the method and the final check.

> "Why is checkout 500ing in prod since 10am?"

Claude establishes the environment and window, queries your own Datadog/Splunk/
Loki tools, applies the five rules from the bundled methodology, and calls
`validate_rca` on its own draft before answering.

**Start from an identifier.** A session id, request id, or trace id and nothing
else.

> "RCA for session sess_abc123XYZ"

Claude calls `plan_investigation`, which classifies the id, lists every vendor
spelling it may appear under, names which sources can answer for it, and sets
the right time window — then fans out across your connected tools.

**Start from a screenshot.** Paste it. Claude reads it directly (it is
multimodal), pulls the failing URL/status/timestamp out of the image, and goes
from there. There is no tool call needed for this and you should not make one.

**Start from a HAR.** Export the browser's Network tab, then:

> "Run analyze_visual_evidence on ~/Downloads/checkout.har"

You get back only the failed and slow requests with their correlation headers,
redacted — the fastest path from "the UI is broken" to a backend trace id.

## 5-minute first run (zero vendor MCPs required)

1. Install rcAnalyst as above — no other MCP needed for this walkthrough.
2. Export your browser's Network tab as a HAR for the failing request.
3. Ask Claude: "use analyze_visual_evidence on this HAR to find what failed."
4. Feed the returned correlation headers/request id into `correlate_ids` if you
   have more log snippets to tie together.
5. If you have an in-house log API, add it to `adapters.yaml` and ask Claude to
   `query_generic_source` it with the request id.
6. Ask Claude to write the RCA — it calls `validate_rca` on its own draft and
   emits a fenced `BEGIN_RCANALYST_RESULT_JSON` envelope before finalizing.

## Tools

| Tool | Purpose |
|---|---|
| `plan_investigation` | Start here from a bare session/request/trace id: classifies it, gives every vendor spelling, names which sources can answer, sets the window |
| `correlate_ids` | Extract & rank correlation IDs across log snippets you've already collected, including async (message/job id) hops |
| `analyze_visual_evidence` | Parse a HAR/network-tab export (redacted). Not needed for screenshots — read those directly |
| `query_generic_source` | Config-templated REST query for a backend with no dedicated MCP — use only as a last resort |
| `list_generic_sources` | List what's declared in `adapters.yaml` |
| `get_coverage` | Look up whether a surface covers/is blind to a resource type, from `topology.yaml` |
| `validate_rca` | Deterministically lint a draft RCA envelope before you post it |

## Known limitations (v1)

- `query_generic_source` supports static-header and HTTP-basic auth only —
  no OAuth client-credentials flows. Write a small dedicated MCP server for
  those instead.
- `analyze_visual_evidence`'s raw-image path can approach the ~1MB
  single-message size ceiling most MCP transports impose, on large
  screenshots.
- `validate_rca`'s `investigation_log` is self-reported by the host, not
  independently observed — a fabricated log cannot be caught here.
- Enforcement is only non-optional on Claude Code (via the plugin's `Stop`
  hook). On Claude Desktop and claude.ai, `validate_rca` is a tool the session
  can decline to call.
- Pinned to `mcp>=1.9.0,<2`: mcp 2.x renamed `FastMCP` to `MCPServer`. Porting
  is tracked as a follow-up.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with install, config, and first-run walkthrough"
```

---

## Task 14: Full-suite verification

**Files:** none created — verification only.

**Interfaces:** none.

- [ ] **Step 1: Run the entire test suite**

Run: `cd /Users/sharajrewoo/DemoReposQA/rcAnalyst && pytest -v --cov=src/rcanalyst`
Expected: all tests from Tasks 1–12 (including 9A) pass; no import errors.

- [ ] **Step 1b: Confirm the envelope contract has not drifted**

Run: `grep -rn "RCANALYST_RESULT_JSON" skills/ hooks/ src/ | sort`
Expected: the sentinel appears in `skills/rca-methodology/SKILL.md` (what the host
is told to emit), in `hooks/stop_validate.py` (what the hook greps for), and in
`server.py`'s tool description. If it appears in only one of those, enforcement is
dead — the hook will never match a real turn.

- [ ] **Step 2: Smoke-test the server starts over stdio**

Run: `timeout 3 uv run --directory . rcanalyst || echo "exited as expected (no client connected)"`
Expected: no Python traceback; the process starts and waits on stdio until the timeout kills it.

- [ ] **Step 3: Verify no stray stdout writes exist outside the MCP protocol**

Run: `grep -rn "print(" src/rcanalyst/ | grep -v "^src/rcanalyst/server.py"`
Expected: no output (all logging goes through the `logging` module to stderr, per Global Constraints; `hooks/stop_validate.py`'s two intentional `print()` calls are the hook's documented stdout contract with Claude Code and are excluded from `src/`).

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: verify full test suite and stdio smoke test" --allow-empty
```
