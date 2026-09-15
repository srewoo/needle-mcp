import { describe, expect, it } from "vitest";
import { validateRca } from "../src/tools/validateRca.js";

function validClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    confidence: "strong_evidence",
    status: "success",
    root_cause: "payment-service timed out calling its own DB",
    affected_services: ["checkout", "payment-service"],
    environment: "prod",
    alert_window: { start: "2026-09-15T10:00:00Z", end: "2026-09-15T10:10:00Z" },
    evidence: [
      {
        timestamp: "2026-09-15T10:05:00Z",
        text: "DB connection pool exhausted",
        source_ref: "payment_service/db.go:42",
        environment: "prod",
      },
      {
        timestamp: "2026-09-15T10:05:01Z",
        text: "500 from payment-service",
        source_ref: "checkout/clients/payment_client.go:88",
        environment: "prod",
      },
    ],
    hop_trace: { hop_count: 2, stop_reason: "terminal" },
    ...overrides,
  };
}

const names = (r: ReturnType<typeof validateRca>) => r.gaps.map((g) => g.name);

describe("validateRca", () => {
  it("approves a valid claim", () => {
    const result = validateRca(validClaim(), []);
    expect(result.approved).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it("rejects a missing required field", () => {
    const claim = validClaim();
    delete claim.environment;
    const result = validateRca(claim, []);
    expect(result.approved).toBe(false);
    expect(names(result)).toContain("format-violation");
  });

  it("rejects an invalid confidence enum value", () => {
    expect(names(validateRca(validClaim({ confidence: "pretty_sure" }), []))).toContain(
      "format-violation",
    );
  });

  it("rejects evidence outside the alert window", () => {
    const claim = validClaim();
    (claim.evidence as Record<string, unknown>[])[0]!.timestamp = "2026-09-15T09:00:00Z";
    expect(names(validateRca(claim, []))).toContain("evidence-outside-alert-window");
  });

  it("rejects strong_evidence backed by a single symptom", () => {
    const claim = validClaim();
    claim.evidence = [(claim.evidence as unknown[])[0]];
    expect(names(validateRca(claim, []))).toContain("single-symptom-strong-evidence");
  });

  it("rejects a forwarded error presented as terminal", () => {
    const claim = validClaim({
      root_cause: "checkout failed",
      evidence: [
        {
          timestamp: "2026-09-15T10:05:00Z",
          text: "rpc error: DeadlineExceeded",
          source_ref: "checkout/clients/payment_client.go:88",
          environment: "prod",
        },
        {
          timestamp: "2026-09-15T10:05:01Z",
          text: "500 returned to user",
          source_ref: "checkout/handler.go:12",
          environment: "prod",
        },
      ],
      hop_trace: { hop_count: 1, stop_reason: "terminal" },
    });
    expect(names(validateRca(claim, []))).toContain("forwarded-error-as-terminal");
  });

  it("allows a forwarded error when stop_reason is vendor_boundary", () => {
    const claim = validClaim({
      evidence: [
        {
          timestamp: "2026-09-15T10:05:00Z",
          text: "rpc error: Unavailable",
          source_ref: "checkout/clients/payment_client.go:88",
          environment: "prod",
        },
        {
          timestamp: "2026-09-15T10:05:01Z",
          text: "confirmed vendor outage",
          source_ref: "vendor status page",
          environment: "prod",
        },
      ],
      hop_trace: { hop_count: 3, stop_reason: "vendor_boundary" },
    });
    expect(names(validateRca(claim, []))).not.toContain("forwarded-error-as-terminal");
  });

  it("rejects a cache miss offered as a root cause", () => {
    const claim = validClaim({
      root_cause: "cache miss caused slow response",
      evidence: [(validClaim().evidence as unknown[])[0]],
    });
    expect(names(validateRca(claim, []))).toContain("cache-miss-as-rca");
  });

  it("rejects strong_evidence on an unresolved monitored resource", () => {
    expect(names(validateRca(validClaim({ monitored_resource: { unresolved: true } }), []))).toContain(
      "strong-evidence-on-unresolved",
    );
  });

  it("rejects an exceeded hop cap", () => {
    const claim = validClaim({ hop_trace: { hop_count: 15, stop_reason: "hop_cap_reached" } });
    expect(names(validateRca(claim, []))).toContain("hop-cap-exceeded");
  });

  it("rejects a metric claim with no decomposition", () => {
    const claim = validClaim({ alert_metric: { name: "error_rate", object_class: "service" } });
    expect(names(validateRca(claim, []))).toContain("alert-metric-not-decomposed");
  });

  it("accepts a metric claim with decomposition", () => {
    const claim = validClaim({ alert_metric: { name: "error_rate" }, decomposed_by: "tenant_id" });
    expect(names(validateRca(claim, []))).not.toContain("alert-metric-not-decomposed");
  });

  it("rejects evidence spanning multiple environments", () => {
    const claim = validClaim();
    (claim.evidence as Record<string, unknown>[])[1]!.environment = "staging";
    expect(names(validateRca(claim, []))).toContain("mixed-environment-evidence");
  });

  it("surfaces the FIRST gap's detail as required_action", () => {
    // Two independent gaps in a known order: the missing 'environment' field is
    // detected in the required-field loop (which runs first), the invalid
    // 'confidence' enum value afterwards. required_action must reflect gaps[0]
    // specifically, not just "any" gap or a hardcoded string.
    const claim = validClaim({ confidence: "pretty_sure" });
    delete claim.environment;
    const result = validateRca(claim, []);
    expect(result.gaps.length).toBeGreaterThanOrEqual(2);
    expect(result.required_action).toBe(result.gaps[0]!.detail);
    expect(result.required_action!.toLowerCase()).toContain("environment");
    expect(result.required_action!.toLowerCase()).not.toContain("confidence");
  });
});

describe("validateRca never throws", () => {
  const malformed: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["non-object evidence rows", validClaim({ evidence: ["not an object"] })],
    ["null evidence", validClaim({ evidence: null })],
    ["non-string root_cause", validClaim({ root_cause: 12345 })],
    ["wrong-typed hop_trace", validClaim({ hop_trace: ["not", "an", "object"] })],
    ["wrong-typed monitored_resource", validClaim({ monitored_resource: ["nope"] })],
  ];

  for (const [label, claim] of malformed) {
    it(`survives ${label}`, () => {
      const result = validateRca(claim, []);
      expect(result.approved).toBe(false);
      expect(Array.isArray(result.gaps)).toBe(true);
    });
  }

  it("reports a malformed alert_window as a format violation", () => {
    const claim = validClaim({ alert_window: { start: "not-a-timestamp", end: "also-not" } });
    const result = validateRca(claim, []);
    expect(result.approved).toBe(false);
    expect(names(result)).toContain("format-violation");
  });

  it("rejects a non-object claim entirely", () => {
    for (const bad of [null, undefined, "a string", 42, ["a", "list"]]) {
      const result = validateRca(bad, []);
      expect(result.approved).toBe(false);
      expect(names(result)).toContain("format-violation");
    }
  });
});

// --- The narration-only envelope (I5) ---------------------------------------
//
// 'evidence' was not required, and the window check returned early on a falsy
// alert_window, so an envelope with the five required scalars, zero evidence
// rows and no window was APPROVED — precisely the narration the Stop hook
// exists to block (spec §3).
const NARRATION_ONLY = {
  confidence: "partial_evidence",
  status: "partial",
  root_cause: "the checkout service was probably overloaded",
  affected_services: ["checkout"],
  environment: "prod",
};

describe("narration-only envelopes", () => {
  it("rejects an evidence-free envelope", () => {
    const result = validateRca({ ...NARRATION_ONLY }, []);
    expect(result.approved).toBe(false);
    expect(names(result)).toEqual(expect.arrayContaining(["no-evidence-cited", "alert-window-missing"]));
  });

  it("rejects a missing alert_window even with evidence", () => {
    const claim = validClaim();
    delete claim.alert_window;
    const result = validateRca(claim, []);
    expect(result.approved).toBe(false);
    expect(new Set(names(result))).toEqual(new Set(["alert-window-missing"]));
  });

  it("rejects an empty evidence list", () => {
    expect(names(validateRca(validClaim({ evidence: [] }), []))).toContain("no-evidence-cited");
  });

  it("lets inconclusive confidence cite no evidence", () => {
    // "I found nothing" is the honest answer, and has nothing to cite.
    const claim = validClaim({ confidence: "inconclusive", status: "inconclusive", evidence: [] });
    expect(validateRca(claim, []).approved).toBe(true);
  });

  it("still requires an alert_window when inconclusive", () => {
    const claim = validClaim({ confidence: "inconclusive", status: "inconclusive", evidence: [] });
    delete claim.alert_window;
    const result = validateRca(claim, []);
    expect(result.approved).toBe(false);
    expect(names(result)).toContain("alert-window-missing");
  });

  it("keeps gap names in the existing kebab-case style", () => {
    // Gap names are a contract shared with the Stop hook and the docs.
    for (const gap of validateRca({ ...NARRATION_ONLY }, []).gaps) {
      expect(gap.name).toBe(gap.name.toLowerCase());
      expect(gap.name).not.toContain(" ");
      expect(gap.name).not.toContain("_");
    }
  });
});
