import type { ValidationGap, ValidationResult } from "../models.js";
import { pyTypeName } from "../pyrepr.js";
import {
  type Claim,
  alertWindowGaps,
  alertWindowRequiredGaps,
  cacheMissGaps,
  confidenceEnumGaps,
  evidencePresentGaps,
  forwardedErrorGaps,
  gap,
  hopCapGaps,
  isPlainObject,
  metricDecompositionGaps,
  mixedEnvironmentGaps,
  normalizeDictField,
  normalizeEvidence,
  requiredFieldGaps,
  singleSymptomGaps,
  unresolvedStrongEvidenceGaps,
} from "./rcaChecks.js";

function runChecks(claim: Claim): ValidationGap[] {
  const [evidence, evidenceGaps] = normalizeEvidence(claim);
  const [hopTrace, hopTraceGaps] = normalizeDictField(claim, "hop_trace");
  const [monitoredResource, monitoredResourceGaps] = normalizeDictField(claim, "monitored_resource");

  return [
    ...requiredFieldGaps(claim),
    ...confidenceEnumGaps(claim),
    ...evidenceGaps,
    ...hopTraceGaps,
    ...monitoredResourceGaps,
    ...alertWindowRequiredGaps(claim),
    ...evidencePresentGaps(claim, evidence),
    ...alertWindowGaps(claim, evidence),
    ...singleSymptomGaps(claim, evidence),
    ...forwardedErrorGaps(hopTrace, evidence),
    ...cacheMissGaps(claim, evidence),
    ...unresolvedStrongEvidenceGaps(claim, monitoredResource),
    ...hopCapGaps(hopTrace),
    ...metricDecompositionGaps(claim),
    ...mixedEnvironmentGaps(evidence),
  ];
}

/**
 * Deterministic linter over a model-produced RCA claim. NEVER THROWS: malformed
 * input (wrong types, missing keys, non-object rows) is reported as
 * format-violation gaps by the per-field checks in runChecks; the try/catch
 * below is a backstop for any shape neither of us anticipated. A throw here
 * would crash the Stop hook's enforcement gate.
 */
export function validateRca(claim: unknown, _investigationLog?: unknown[] | null): ValidationResult {
  try {
    if (!isPlainObject(claim)) {
      const g = gap("format-violation", `claim_json must be an object, got ${pyTypeName(claim)}.`);
      return { approved: false, gaps: [g], required_action: g.detail };
    }

    const gaps = runChecks(claim);
    const approved = !gaps.some((g) => g.severity === "blocking");
    const requiredAction = approved ? null : (gaps[0]?.detail ?? null);
    return { approved, gaps, required_action: requiredAction };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const g = gap(
      "format-violation",
      `validate_rca could not evaluate the claim due to an unexpected error: ${message}`,
    );
    return { approved: false, gaps: [g], required_action: g.detail };
  }
}
