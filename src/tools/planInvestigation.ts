import type { AdapterConfig, TopologyFile } from "../config.js";
import type { IdentifierKind, IdentifierPlan, SourceCandidate } from "../models.js";
import { ASYNC_KEYS, KEY_PATTERNS } from "./correlateIds.js";
import { normalizeIdentifier } from "./normalizeIdentifier.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const W3C_TRACE = /^[0-9a-f]{32}$/i;
const AWS_XRAY = /^1-[0-9a-f]{8}-[0-9a-f]{24}$/i;
const DECIMAL = /^\d{6,20}$/;

/**
 * Substrings that mark an identifier as belonging to an async/queued flow, where
 * the consumer's log can trail the producer's by tens of minutes.
 */
const ASYNC_MARKERS = ["msg", "message", "job", "task", "event", "batch", "delivery"] as const;

const ALL_KEY_NAMES = KEY_PATTERNS.map(([name]) => name);

/**
 * Which of correlateIds' KEY_PATTERNS could plausibly carry an identifier of a
 * given shape. likely_key_names previously returned every key regardless of
 * kind: ASYNC_KEYS is a strict SUBSET of KEY_PATTERNS, so both arms of the
 * is_async conditional produced the identical list and the field was never
 * "likely" — a UUID was told it might appear under `x-datadog-trace-id`
 * (decimal only) or `traceparent` (a fixed `00-<32hex>-<16hex>-<2hex>` string).
 * This is the headline output of the bare-identifier entry point, so a wrong
 * hint buys a wasted vendor query.
 *
 * The generic request/correlation keys carry any opaque token and so appear for
 * every kind; the vendor-format-specific keys appear only where the identifier —
 * or one of its equivalent_forms, per normalizeIdentifier — can actually be
 * written that way.
 */
const GENERIC_KEYS = ["x-request-id", "request_id", "correlation_id"] as const;
const ASYNC_ONLY_KEYS: ReadonlySet<string> = new Set(["message_id", "job_id"]);

const LIKELY_KEYS_BY_KIND: Readonly<Record<IdentifierKind, readonly string[]>> = {
  // Dashed 8-4-4-4-12 hex: a generic token. No vendor trace format is spelled
  // this way, and span_id is 16 hex, not a dashed UUID.
  uuid: [...GENERIC_KEYS, "trace_id"],
  // 32 hex: the W3C trace-id, embedded in traceparent and convertible to
  // Datadog's decimal spelling.
  w3c_trace: [...GENERIC_KEYS, "trace_id", "traceparent", "x-datadog-trace-id", "span_id"],
  // Decimal: Datadog's own spelling, hex-convertible to the W3C forms.
  datadog_decimal_trace: [
    ...GENERIC_KEYS,
    "trace_id",
    "traceparent",
    "x-datadog-trace-id",
    "span_id",
  ],
  // 1-<8hex>-<24hex>: only AWS writes this.
  aws_xray: [...GENERIC_KEYS, "trace_id", "x-amzn-trace-id"],
  // Shape tells us nothing, so narrowing here would be a guess dressed as fact.
  opaque: ALL_KEY_NAMES,
};

function likelyKeyNames(kind: IdentifierKind, isAsync: boolean): string[] {
  const keys = new Set<string>(LIKELY_KEYS_BY_KIND[kind] ?? ALL_KEY_NAMES);
  if (isAsync) {
    for (const key of ASYNC_KEYS) keys.add(key);
  } else {
    for (const key of ASYNC_ONLY_KEYS) keys.delete(key);
  }
  // Intersect so this can never name a key correlateIds cannot extract.
  return ALL_KEY_NAMES.filter((name) => keys.has(name)).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

export const SYNC_WINDOW_HINT = "+/- 2 minutes around the identifier's first sighting";
export const ASYNC_WINDOW_HINT =
  "first sighting - 5 minutes to first sighting + 60 minutes (forward-widened: " +
  "a lagging consumer's log trails the producer's, and a tight window reads as " +
  "'never consumed' when the truth is 'not consumed yet')";

/**
 * NOTE: W3C_TRACE is checked before DECIMAL, but that ordering is currently
 * inert for this pair: DECIMAL is bounded to {6,20} digits while W3C_TRACE
 * requires exactly 32 hex chars, so no input can match both. The order is kept
 * as defence in case DECIMAL's upper bound is ever widened toward 32 — at that
 * point the ordering would become the only thing preventing a 32-digit decimal
 * trace id from being misclassified as datadog_decimal_trace.
 */
function classify(identifier: string): IdentifierKind {
  if (UUID.test(identifier)) return "uuid";
  if (AWS_XRAY.test(identifier)) return "aws_xray";
  if (W3C_TRACE.test(identifier)) return "w3c_trace";
  if (DECIMAL.test(identifier)) return "datadog_decimal_trace";
  return "opaque";
}

function isAsyncShaped(identifier: string): boolean {
  const lowered = identifier.toLowerCase();
  return ASYNC_MARKERS.some((marker) => lowered.includes(marker));
}

function buildSources(
  adapters: readonly AdapterConfig[],
  topology: TopologyFile,
): SourceCandidate[] {
  const sources: SourceCandidate[] = adapters.map((a) => ({
    name: a.name,
    kind: "configured_adapter",
    covers: a.covers,
    note: "query via query_generic_source",
  }));

  for (const [name, surface] of Object.entries(topology.surfaces)) {
    sources.push({
      name,
      kind: "coverage_surface",
      covers: surface.covers,
      note: surface.coverage_note ?? null,
    });
  }
  return sources;
}

function buildNextSteps(
  environment: string | null | undefined,
  sources: readonly SourceCandidate[],
  isAsync: boolean,
): string[] {
  const nextSteps: string[] = [];

  if (environment) {
    nextSteps.push(
      `Scope every query to environment '${environment}' — a wrong-environment ` +
        "hit produces a confident, silently wrong RCA.",
    );
  } else {
    nextSteps.push(
      "Confirm the environment (prod/staging/...) before querying — ask the user " +
        "if it is not stated. Do not let a vendor tool's default org decide it.",
    );
  }

  if (sources.length === 0) {
    nextSteps.push(
      "No configured sources and no topology entries: query whatever vendor MCP " +
        "tools this session has connected, and treat any empty result as unknown " +
        "coverage rather than as absence.",
    );
  } else {
    nextSteps.push(
      "Query the sources above for this identifier and each of its " +
        "equivalent_forms — vendors spell the same id differently.",
    );
  }

  nextSteps.push(
    "Feed the log snippets you get back into correlate_ids to find which " +
      "identifiers actually co-occur across services, then follow those.",
  );

  if (isAsync) {
    nextSteps.push(
      "This id looks async: if the consumer side comes back empty, widen the " +
        "window before concluding the message was never processed.",
    );
  }
  return nextSteps;
}

export function planInvestigation(
  identifier: string,
  environment: string | null | undefined,
  adapters: readonly AdapterConfig[],
  topology: TopologyFile,
): IdentifierPlan {
  const kind = classify(identifier);
  const isAsync = isAsyncShaped(identifier);
  const sources = buildSources(adapters, topology);

  return {
    identifier,
    identifier_kind: kind,
    equivalent_forms: normalizeIdentifier(identifier),
    likely_key_names: likelyKeyNames(kind, isAsync),
    is_async_shaped: isAsync,
    suggested_window_hint: isAsync ? ASYNC_WINDOW_HINT : SYNC_WINDOW_HINT,
    queryable_sources: sources,
    unknown_coverage: sources.length === 0,
    next_steps: buildNextSteps(environment, sources, isAsync),
  };
}
