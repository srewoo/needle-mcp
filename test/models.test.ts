import { describe, expect, it } from "vitest";
import {
  CorrelationCandidateSchema,
  CoverageResultSchema,
  GenericQueryResultSchema,
  HarEntrySchema,
  IdentifierPlanSchema,
  SourceCandidateSchema,
  SourceInfoSchema,
  TimeRangeSchema,
  ValidationGapSchema,
  ValidationResultSchema,
  VisualEvidenceResultSchema,
} from "../src/models.js";

describe("models", () => {
  it("round-trips a TimeRange", () => {
    const tr = TimeRangeSchema.parse({ start: "2026-09-15T00:00:00Z", end: "2026-09-15T01:00:00Z" });
    expect(tr).toEqual({ start: "2026-09-15T00:00:00Z", end: "2026-09-15T01:00:00Z" });
  });

  it("defaults a CorrelationCandidate's optional fields", () => {
    const c = CorrelationCandidateSchema.parse({
      value: "abc123",
      key_name: "x-request-id",
      seen_in_snippets: [0],
      confidence: "high",
      why_ranked: "test",
    });
    expect(c.equivalent_forms).toEqual([]);
    expect(c.source_systems).toEqual([]);
    expect(c.suggested_window).toBeNull();
  });

  it("defaults HarEntry.timestamp and VisualEvidenceResult fields", () => {
    const entry = HarEntrySchema.parse({ method: "GET", url: "https://x/y", status: 500, time_ms: 1200 });
    expect(entry.timestamp).toBeNull();
    const result = VisualEvidenceResultSchema.parse({ har_entries: [entry], har_dropped_count: 3 });
    expect(result.har_entries[0]!.status).toBe(500);
    expect(result.image_passthrough).toBeNull();
  });

  it("carries an error on GenericQueryResult", () => {
    const result = GenericQueryResultSchema.parse({
      rows: [],
      truncated: false,
      returned_count: 0,
      error: "boom",
    });
    expect(result.error).toBe("boom");
  });

  it("rejects an unknown auth_mode on SourceInfo", () => {
    // SourceInfo is the shape list_generic_sources returns; its auth_mode enum
    // is the part worth pinning, since an adapter file is user-authored.
    expect(
      SourceInfoSchema.parse({
        name: "loki",
        base_url_host: "loki.example.internal",
        auth_mode: "static_header",
      }).covers,
    ).toEqual([]);
    expect(
      SourceInfoSchema.safeParse({
        name: "loki",
        base_url_host: "loki.example.internal",
        auth_mode: "oauth",
      }).success,
    ).toBe(false);
  });

  it("parses a CoverageResult", () => {
    const cov = CoverageResultSchema.parse({
      covering_surfaces: ["cloudwatch"],
      blind_surfaces: ["loki"],
      unknown_coverage: false,
    });
    expect(cov.unknown_coverage).toBe(false);
  });

  it("defaults IdentifierPlan fields", () => {
    const plan = IdentifierPlanSchema.parse({
      identifier: "abc-123",
      identifier_kind: "opaque",
      suggested_window_hint: "+/- 2 minutes around first sighting",
    });
    expect(plan.equivalent_forms).toEqual([]);
    expect(plan.is_async_shaped).toBe(false);
    expect(plan.queryable_sources).toEqual([]);
  });

  it("defaults SourceCandidate.note", () => {
    expect(
      SourceCandidateSchema.parse({ name: "loki", kind: "coverage_surface", covers: ["k8s_pod"] }).note,
    ).toBeNull();
  });

  it("defaults ValidationResult gaps and required_action", () => {
    const result = ValidationResultSchema.parse({ approved: true });
    expect(result.gaps).toEqual([]);
    expect(result.required_action).toBeNull();
  });

  it("enforces the ValidationGap severity enum", () => {
    // validateRca and the Stop hook both filter gaps on severity === "blocking",
    // so a typo'd severity would silently drop a gap out of the blocking reason.
    for (const severity of ["blocking", "warning"]) {
      expect(
        ValidationGapSchema.parse({ name: "format-violation", severity, detail: "d" }).severity,
      ).toBe(severity);
    }
    expect(
      ValidationGapSchema.safeParse({ name: "format-violation", severity: "critical", detail: "d" })
        .success,
    ).toBe(false);
  });
});
