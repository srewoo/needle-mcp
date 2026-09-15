import type { CorrelationCandidate, CorrelationResult } from "../models.js";
import { normalizeIdentifier } from "./normalizeIdentifier.js";

/**
 * Insertion order is significant: the first pattern to claim a value decides
 * its key_name, so the more specific vendor spellings must precede the generic
 * ones they would otherwise be swallowed by.
 */
export const KEY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["x-request-id", /x-request-id[=:]\s*"?([A-Za-z0-9\-]{6,})"?/gi],
  ["request_id", /(?<!x-)request_id[=:]\s*"?([A-Za-z0-9\-]{6,})"?/gi],
  ["trace_id", /(?<!datadog-)(?<!x-)trace_id[=:]\s*"?([A-Za-z0-9\-]{6,})"?/gi],
  [
    "traceparent",
    /traceparent[=:]\s*"?([0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2})"?/gi,
  ],
  ["x-datadog-trace-id", /x-datadog-trace-id[=:]\s*"?(\d{1,20})"?/gi],
  ["x-amzn-trace-id", /x-amzn-trace-id[=:]\s*"?([A-Za-z0-9=;\-]{6,})"?/gi],
  ["correlation_id", /correlation_id[=:]\s*"?([A-Za-z0-9\-]{6,})"?/gi],
  ["message_id", /message[_-]?id[=:]\s*"?([A-Za-z0-9\-]{6,})"?/gi],
  ["job_id", /job[_-]?id[=:]\s*"?([A-Za-z0-9\-]{6,})"?/gi],
  ["span_id", /span_id[=:]\s*"?([0-9a-f]{6,32})"?/gi],
];

export const ASYNC_KEYS: ReadonlySet<string> = new Set(["message_id", "job_id", "correlation_id"]);

const DENYLIST: ReadonlySet<string> = new Set([
  "0",
  "-",
  "null",
  "unknown",
  "n/a",
  "na",
  "00000000-0000-0000-0000-000000000000",
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
