import type { CorrelationCandidate, CorrelationResult } from "../models.js";
import { normalizeIdentifier } from "./normalizeIdentifier.js";

/**
 * The character class for an OPAQUE token value.
 *
 * The underscore is load-bearing. Without it, `request_id=req_7f3a9c` captured
 * only `req` — three characters, below the {6,} floor — and the identifier was
 * dropped with no error, no warning and no candidate. Prefixed-with-underscore
 * ids (`req_`, `msg_`, `job_`, `sess_`, `evt_`) are one of the most common
 * conventions in the wild, so the pattern missed exactly the ids most worth
 * correlating. The failure mode is an empty result that reads as "these logs
 * share nothing", which is the most expensive way for this tool to be wrong.
 *
 * The {6,} floor still does the discriminating work: it is what keeps `0`,
 * `null` and `n/a` out, and the DENYLIST catches the rest.
 */
const OPAQUE_TOKEN = String.raw`[A-Za-z0-9_\-]{6,}`;

/**
 * Insertion order is significant: the first pattern to claim a value decides
 * its key_name, so the more specific vendor spellings must precede the generic
 * ones they would otherwise be swallowed by.
 *
 * The fixed-format patterns (traceparent, x-datadog-trace-id, span_id,
 * x-amzn-trace-id) deliberately keep their narrow classes — those formats are
 * specified and cannot contain an underscore, so widening them would only cost
 * precision.
 */
export const KEY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["x-request-id", new RegExp(String.raw`x-request-id[=:]\s*"?(${OPAQUE_TOKEN})"?`, "gi")],
  ["request_id", new RegExp(String.raw`(?<!x-)request_id[=:]\s*"?(${OPAQUE_TOKEN})"?`, "gi")],
  [
    "trace_id",
    new RegExp(String.raw`(?<!datadog-)(?<!x-)trace_id[=:]\s*"?(${OPAQUE_TOKEN})"?`, "gi"),
  ],
  [
    "traceparent",
    /traceparent[=:]\s*"?([0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2})"?/gi,
  ],
  ["x-datadog-trace-id", /x-datadog-trace-id[=:]\s*"?(\d{1,20})"?/gi],
  ["x-amzn-trace-id", /x-amzn-trace-id[=:]\s*"?([A-Za-z0-9=;\-]{6,})"?/gi],
  ["correlation_id", new RegExp(String.raw`correlation_id[=:]\s*"?(${OPAQUE_TOKEN})"?`, "gi")],
  ["message_id", new RegExp(String.raw`message[_-]?id[=:]\s*"?(${OPAQUE_TOKEN})"?`, "gi")],
  ["job_id", new RegExp(String.raw`job[_-]?id[=:]\s*"?(${OPAQUE_TOKEN})"?`, "gi")],
  ["span_id", /span_id[=:]\s*"?([0-9a-f]{6,32})"?/gi],
];

export const ASYNC_KEYS: ReadonlySet<string> = new Set(["message_id", "job_id", "correlation_id"]);

/**
 * Values that are syntactically ids but semantically "there wasn't one".
 * Querying a vendor for these returns the whole fleet, which reads as a broad
 * incident.
 *
 * The underscored entries became reachable only when OPAQUE_TOKEN gained `_`:
 * before that they were captured as a sub-3-character fragment and fell below
 * the length floor by accident. They are placeholders applications really do
 * emit, so they are now excluded on purpose rather than by side effect.
 */
const DENYLIST: ReadonlySet<string> = new Set([
  "0",
  "-",
  "null",
  "unknown",
  "n/a",
  "na",
  "00000000-0000-0000-0000-000000000000",
  "undefined",
  "not_set",
  "not_available",
  "none_provided",
  "unknown_id",
  "no_value",
]);

const TS_PATTERN = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/;

function extractTs(snippet: string): string | null {
  return TS_PATTERN.exec(snippet)?.[1] ?? null;
}

/**
 * Render a UTC instant the way Python's `datetime.isoformat()` does for a
 * tz-aware datetime: `+00:00`, not `Z`, and fractional seconds only when
 * non-zero. Consumers pin windows against these strings, so the spelling is
 * part of the output contract.
 */
function isoFormat(ms: number): string {
  const d = new Date(ms);
  const base = d.toISOString().slice(0, 19);
  const micros = d.getUTCMilliseconds();
  const fraction = micros === 0 ? "" : `.${String(micros).padStart(3, "0")}000`;
  return `${base}${fraction}+00:00`;
}

export function correlateIds(evidenceSnippets: readonly string[]): CorrelationResult {
  const found = new Map<string, CorrelationCandidate>();

  evidenceSnippets.forEach((snippet, idx) => {
    const ts = extractTs(snippet);
    for (const [keyName, pattern] of KEY_PATTERNS) {
      // Fresh lastIndex per snippet: these RegExps are module-level and /g is
      // stateful, so a shared object would skip matches across calls.
      const rx = new RegExp(pattern.source, pattern.flags);
      for (const match of snippet.matchAll(rx)) {
        const value = match[1];
        if (value === undefined || DENYLIST.has(value.toLowerCase())) continue;

        const dedupeKey = value.toLowerCase().replace(/-/g, "");
        let candidate = found.get(dedupeKey);
        if (candidate === undefined) {
          candidate = {
            value,
            key_name: keyName,
            equivalent_forms: normalizeIdentifier(value),
            seen_in_snippets: [],
            source_systems: [],
            first_seen_ts: null,
            last_seen_ts: null,
            suggested_window: null,
            confidence: "low",
            why_ranked: "",
          };
          found.set(dedupeKey, candidate);
        }
        if (!candidate.seen_in_snippets.includes(idx)) {
          candidate.seen_in_snippets.push(idx);
        }
        if (ts !== null) {
          if (candidate.first_seen_ts === null || ts < candidate.first_seen_ts) {
            candidate.first_seen_ts = ts;
          }
          if (candidate.last_seen_ts === null || ts > candidate.last_seen_ts) {
            candidate.last_seen_ts = ts;
          }
        }
      }
    }
  });

  const candidates = [...found.values()];
  for (const c of candidates) {
    const crossSourceCount = new Set(c.seen_in_snippets).size;
    if (crossSourceCount >= 2) {
      c.confidence = "high";
      c.why_ranked = `named key '${c.key_name}' co-occurred across ${crossSourceCount} snippets`;
    } else {
      c.confidence = "medium";
      c.why_ranked = `named key '${c.key_name}' matched once`;
    }

    if (c.first_seen_ts !== null) {
      const base = Date.parse(c.first_seen_ts);
      if (!Number.isNaN(base)) {
        // An async id's consumer-side log trails its producer's, so the window
        // is widened forward rather than centred.
        const [backMinutes, forwardMinutes] = ASYNC_KEYS.has(c.key_name) ? [5, 60] : [2, 2];
        c.suggested_window = [
          isoFormat(base - backMinutes * 60_000),
          isoFormat(base + forwardMinutes * 60_000),
        ];
      }
    }
  }

  candidates.sort((a, b) => {
    const countDelta = new Set(b.seen_in_snippets).size - new Set(a.seen_in_snippets).size;
    if (countDelta !== 0) return countDelta;
    return Number(b.confidence === "high") - Number(a.confidence === "high");
  });

  return { candidates };
}
