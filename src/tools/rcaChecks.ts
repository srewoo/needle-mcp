import type { ValidationGap } from "../models.js";
import { pyRepr, pySorted, pyTypeName } from "../pyrepr.js";

const FORWARDED_ERROR_PATTERN =
  /unavailable|deadlineexceeded|i\/o timeout|context deadline exceeded/i;
const BOUNDARY_PATH_PATTERN = /external\/|clients\/|adapters\/|_client\.|stub\./i;
const VALID_CONFIDENCE = new Set(["strong_evidence", "partial_evidence", "inconclusive"]);

type PyType = "str" | "list";
const REQUIRED_FIELD_TYPES: ReadonlyArray<readonly [string, PyType]> = [
  ["confidence", "str"],
  ["status", "str"],
  ["root_cause", "str"],
  ["affected_services", "list"],
  ["environment", "str"],
];

export type Claim = Record<string, unknown>;

/** Throws on an unparseable timestamp, so the caller reports a format gap. */
function parseTs(ts: unknown): number {
  if (typeof ts !== "string") throw new TypeError(`timestamp must be a string, got ${pyTypeName(ts)}`);
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) throw new TypeError(`invalid ISO8601 timestamp: ${ts}`);
  return parsed;
}

export function gap(name: string, detail: string): ValidationGap {
  return { name, severity: "blocking", detail };
}

/** Python's falsy test, for parity with `if not value`. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "number") return value === 0;
  if (typeof value === "boolean") return !value;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function matchesType(value: unknown, expected: PyType): boolean {
  return expected === "list" ? Array.isArray(value) : typeof value === "string";
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return [clean evidence rows, gaps]. Never throws: non-list/non-object inputs
 * are coerced to an empty/filtered list with a diagnostic gap rather than being
 * passed on to crash a downstream predicate.
 */
export function normalizeEvidence(claim: Claim): [Claim[], ValidationGap[]] {
  const raw = claim.evidence;
  if (raw === null || raw === undefined) return [[], []];
  if (!Array.isArray(raw)) {
    return [[], [gap("format-violation", `'evidence' must be a list, got ${pyTypeName(raw)}.`)]];
  }
  const clean = raw.filter(isPlainObject);
  const malformed = raw.length - clean.length;
  const gaps: ValidationGap[] = [];
  if (malformed) {
    gaps.push(
      gap("format-violation", `${malformed} evidence row(s) are not objects and were ignored.`),
    );
  }
  return [clean, gaps];
}

export function normalizeDictField(claim: Claim, fieldName: string): [Claim, ValidationGap[]] {
  const raw = claim[fieldName];
  if (raw === null || raw === undefined) return [{}, []];
  if (!isPlainObject(raw)) {
    return [
      {},
      [gap("format-violation", `'${fieldName}' must be an object, got ${pyTypeName(raw)}.`)],
    ];
  }
  return [raw, []];
}

export function requiredFieldGaps(claim: Claim): ValidationGap[] {
  const gaps: ValidationGap[] = [];
  for (const [field, expected] of REQUIRED_FIELD_TYPES) {
    const value = claim[field];
    if (isEmpty(value)) {
      gaps.push(gap("format-violation", `Required envelope field '${field}' is missing or empty.`));
    } else if (!matchesType(value, expected)) {
      gaps.push(
        gap(
          "format-violation",
          `Required envelope field '${field}' must be of type ${expected}, ` +
            `got ${pyTypeName(value)}.`,
        ),
      );
    }
  }
  return gaps;
}

export function confidenceEnumGaps(claim: Claim): ValidationGap[] {
  const confidence = claim.confidence;
  if (typeof confidence === "string" && !VALID_CONFIDENCE.has(confidence)) {
    return [
      gap(
        "format-violation",
        `'confidence' value '${confidence}' is not one of ${pyRepr(pySorted(VALID_CONFIDENCE))}.`,
      ),
    ];
  }
  return [];
}

/**
 * An absent alert_window silently disabled the evidence-window check below,
 * which returned early on a falsy window — so an envelope simply omitting it
 * skipped the check entirely. Scoping every evidence row to the alert's own
 * window is the point of that check, so the window itself is required. Named
 * separately from 'evidence-outside-alert-window' so the two failures stay
 * distinguishable in the hook's blocking reason.
 */
export function alertWindowRequiredGaps(claim: Claim): ValidationGap[] {
  if (isEmpty(claim.alert_window)) {
    return [
      gap(
        "alert-window-missing",
        "No alert_window declared. Without it, evidence cannot be scoped to the " +
          "incident's own time range and every timestamp check is vacuous. State the " +
          "window the alert or report actually covers.",
      ),
    ];
  }
  return [];
}

/**
 * An envelope with zero evidence rows is narration wearing a JSON hat, and
 * blocking exactly that is the Stop hook's stated purpose (spec §3). The one
 * honest exception is confidence: inconclusive, where "I found nothing" IS the
 * finding and there is by definition nothing to cite.
 */
export function evidencePresentGaps(claim: Claim, evidence: Claim[]): ValidationGap[] {
  if (evidence.length > 0) return [];
  if (claim.confidence === "inconclusive") return [];
  return [
    gap(
      "no-evidence-cited",
      "The envelope cites zero evidence rows. A root cause asserted without a " +
        "single timestamped, sourced observation is narration, not an RCA. Cite the " +
        "evidence, or set confidence to 'inconclusive'.",
    ),
  ];
}

export function alertWindowGaps(claim: Claim, evidence: Claim[]): ValidationGap[] {
  const alertWindow = claim.alert_window;
  if (isEmpty(alertWindow) || evidence.length === 0) return [];
  const gaps: ValidationGap[] = [];
  try {
    const window = alertWindow as Record<string, unknown>;
    const winStart = parseTs(window.start);
    const winEnd = parseTs(window.end);
    for (const row of evidence) {
      const ts = row.timestamp;
      if (isEmpty(ts)) continue;
      const at = parseTs(ts);
      if (!(winStart <= at && at <= winEnd)) {
        gaps.push(
          gap(
            "evidence-outside-alert-window",
            `Evidence row timestamp ${String(ts)} falls outside alert_window ${pyRepr(alertWindow)}.`,
          ),
        );
      }
    }
  } catch {
    return [
      ...gaps,
      gap(
        "format-violation",
        `'alert_window' (${pyRepr(alertWindow)}) is malformed and could not be compared ` +
          "against evidence timestamps.",
      ),
    ];
  }
  return gaps;
}

export function singleSymptomGaps(claim: Claim, evidence: Claim[]): ValidationGap[] {
  if (claim.confidence === "strong_evidence" && evidence.length <= 1) {
    return [
      gap(
        "single-symptom-strong-evidence",
        "strong_evidence claimed with a single evidence row; a single symptom is not a traced chain.",
      ),
    ];
  }
  return [];
}

export function forwardedErrorGaps(hopTrace: Claim, evidence: Claim[]): ValidationGap[] {
  const stopReason = hopTrace.stop_reason;
  const gaps: ValidationGap[] = [];
  for (const row of evidence) {
    const rowText = String(row.text ?? "");
    const location = String(row.source_ref ?? "");
    if (FORWARDED_ERROR_PATTERN.test(rowText) && BOUNDARY_PATH_PATTERN.test(location)) {
      if (stopReason !== "vendor_boundary") {
        gaps.push(
          gap(
            "forwarded-error-as-terminal",
            `Evidence cites '${rowText}' at boundary location '${location}' but ` +
              "stop_reason is not vendor_boundary — this looks like an RPC-forwarded " +
              "error, not the originating cause. Query the named downstream's own logs.",
          ),
        );
      }
    }
  }
  return gaps;
}

export function cacheMissGaps(claim: Claim, evidence: Claim[]): ValidationGap[] {
  const rootCause = String(claim.root_cause ?? "");
  if (rootCause.toLowerCase().includes("cache miss") && evidence.length < 2) {
    return [
      gap(
        "cache-miss-as-rca",
        "Root cause names a cache miss with no second evidence row explaining why the " +
          "fallback was slow/errored.",
      ),
    ];
  }
  return [];
}

export function unresolvedStrongEvidenceGaps(claim: Claim, monitoredResource: Claim): ValidationGap[] {
  if (monitoredResource.unresolved && claim.confidence === "strong_evidence") {
    return [
      gap(
        "strong-evidence-on-unresolved",
        "monitored_resource.unresolved is true but confidence is strong_evidence.",
      ),
    ];
  }
  return [];
}

export function hopCapGaps(hopTrace: Claim): ValidationGap[] {
  const hopCount = hopTrace.hop_count;
  if (typeof hopCount === "number" && Number.isInteger(hopCount) && hopCount > 10) {
    return [gap("hop-cap-exceeded", `hop_trace.hop_count is ${hopCount}, exceeding the 10-hop soft cap.`)];
  }
  return [];
}

export function metricDecompositionGaps(claim: Claim): ValidationGap[] {
  if (!isEmpty(claim.alert_metric) && isEmpty(claim.decomposed_by)) {
    return [
      gap(
        "alert-metric-not-decomposed",
        "A metric-anchored claim (alert_metric present) has no decomposed_by field — " +
          "the series was not broken down by dimension.",
      ),
    ];
  }
  return [];
}

export function mixedEnvironmentGaps(evidence: Claim[]): ValidationGap[] {
  const seen = new Set<string>();
  for (const row of evidence) {
    if (!isEmpty(row.environment)) seen.add(String(row.environment));
  }
  if (seen.size > 1) {
    return [
      gap(
        "mixed-environment-evidence",
        `Evidence rows span multiple environments: ${pyRepr(pySorted(seen))}.`,
      ),
    ];
  }
  return [];
}
