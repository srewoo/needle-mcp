import { z } from "zod";

/**
 * Shared schemas. This is a CONTRACT: renaming a field breaks callers, and the
 * gap `name` strings in validateRca are shared with the Stop hook and the docs.
 */

export const TimeRangeSchema = z.object({
  start: z.string(), // ISO8601
  end: z.string(), // ISO8601
});
export type TimeRange = z.infer<typeof TimeRangeSchema>;

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);

export const CorrelationCandidateSchema = z.object({
  value: z.string(),
  key_name: z.string(),
  equivalent_forms: z.array(z.string()).default([]),
  seen_in_snippets: z.array(z.number().int()),
  source_systems: z.array(z.string()).default([]),
  first_seen_ts: z.string().nullable().default(null),
  last_seen_ts: z.string().nullable().default(null),
  suggested_window: z.array(z.string()).nullable().default(null),
  confidence: ConfidenceSchema,
  why_ranked: z.string(),
});
export type CorrelationCandidate = z.infer<typeof CorrelationCandidateSchema>;

export const CorrelationResultSchema = z.object({
  candidates: z.array(CorrelationCandidateSchema),
});
export type CorrelationResult = z.infer<typeof CorrelationResultSchema>;

export const HarEntrySchema = z.object({
  method: z.string(),
  url: z.string(),
  status: z.number().int(),
  time_ms: z.number(),
  // Wall-clock anchor, from the HAR's ISO8601 `startedDateTime`. time_ms is a
  // DURATION and cannot serve as one. Without this, the HAR entry point is the
  // one flow that cannot supply the alert_window that validateRca then requires
  // every evidence row to sit inside. Nullable because a malformed HAR may omit
  // it, and a missing anchor beats a fabricated one.
  timestamp: z.string().nullable().default(null),
  correlation_headers: z.record(z.string()).default({}),
});
export type HarEntry = z.infer<typeof HarEntrySchema>;

export const VisualEvidenceResultSchema = z.object({
  har_entries: z.array(HarEntrySchema).default([]),
  har_dropped_count: z.number().int().default(0),
  image_passthrough: z.string().nullable().default(null),
  notes: z.array(z.string()).default([]),
});
export type VisualEvidenceResult = z.infer<typeof VisualEvidenceResultSchema>;

export const GenericQueryResultSchema = z.object({
  rows: z.array(z.record(z.unknown())),
  truncated: z.boolean(),
  returned_count: z.number().int(),
  next_cursor: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type GenericQueryResult = z.infer<typeof GenericQueryResultSchema>;

export const AuthModeSchema = z.enum(["static_header", "basic", "none"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

export const SourceInfoSchema = z.object({
  name: z.string(),
  base_url_host: z.string(),
  auth_mode: AuthModeSchema,
  covers: z.array(z.string()).default([]),
});
export type SourceInfo = z.infer<typeof SourceInfoSchema>;

export const CoverageResultSchema = z.object({
  covering_surfaces: z.array(z.string()),
  blind_surfaces: z.array(z.string()),
  unknown_coverage: z.boolean(),
});
export type CoverageResult = z.infer<typeof CoverageResultSchema>;

export const SourceCandidateSchema = z.object({
  name: z.string(),
  kind: z.enum(["configured_adapter", "coverage_surface"]),
  covers: z.array(z.string()).default([]),
  note: z.string().nullable().default(null),
});
export type SourceCandidate = z.infer<typeof SourceCandidateSchema>;

export const IdentifierKindSchema = z.enum([
  "uuid",
  "w3c_trace",
  "datadog_decimal_trace",
  "aws_xray",
  "opaque",
]);
export type IdentifierKind = z.infer<typeof IdentifierKindSchema>;

export const IdentifierPlanSchema = z.object({
  identifier: z.string(),
  identifier_kind: IdentifierKindSchema,
  equivalent_forms: z.array(z.string()).default([]),
  likely_key_names: z.array(z.string()).default([]),
  is_async_shaped: z.boolean().default(false),
  suggested_window_hint: z.string(),
  queryable_sources: z.array(SourceCandidateSchema).default([]),
  unknown_coverage: z.boolean().default(false),
  next_steps: z.array(z.string()).default([]),
});
export type IdentifierPlan = z.infer<typeof IdentifierPlanSchema>;

export const ValidationGapSchema = z.object({
  name: z.string(),
  severity: z.enum(["blocking", "warning"]),
  detail: z.string(),
});
export type ValidationGap = z.infer<typeof ValidationGapSchema>;

export const ValidationResultSchema = z.object({
  approved: z.boolean(),
  gaps: z.array(ValidationGapSchema).default([]),
  required_action: z.string().nullable().default(null),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
