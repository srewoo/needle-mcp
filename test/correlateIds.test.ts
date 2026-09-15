import { describe, expect, it } from "vitest";
import { correlateIds } from "../src/tools/correlateIds.js";
import { normalizeIdentifier } from "../src/tools/normalizeIdentifier.js";

describe("correlateIds", () => {
  it("extracts a named x-request-id key", () => {
    const result = correlateIds(["2026-09-15T10:00:00Z ERROR x-request-id=req-abc123 checkout failed"]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.value).toBe("req-abc123");
    expect(result.candidates[0]!.key_name).toBe("x-request-id");
  });

  it("denylists the all-zero uuid", () => {
    // An all-zero trace id means propagation broke; querying on it returns the
    // whole fleet, which reads as a broad incident.
    expect(
      correlateIds(["trace_id=00000000-0000-0000-0000-000000000000 request failed"]).candidates,
    ).toEqual([]);
  });

  it("never matches short non-discriminative values", () => {
    // '0'/'null' fall below the {6,} length floor, so they never reach DENYLIST.
    expect(
      correlateIds(["trace_id=0 request failed", "trace_id=null also failed"]).candidates,
    ).toEqual([]);
  });

  it("ranks cross-snippet co-occurrence high", () => {
    const result = correlateIds([
      "2026-09-15T10:00:00Z x-request-id=req-abc123 svc=checkout",
      "2026-09-15T10:00:01Z x-request-id=req-abc123 svc=payment",
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.confidence).toBe("high");
    expect(new Set(result.candidates[0]!.seen_in_snippets)).toEqual(new Set([0, 1]));
  });

  it("ranks a single occurrence medium", () => {
    expect(correlateIds(["x-request-id=req-xyz999 svc=checkout"]).candidates[0]!.confidence).toBe(
      "medium",
    );
  });

  it("gives an async key a forward-widened window", () => {
    const c = correlateIds([
      "2026-09-15T10:00:00Z message_id=msg-777 published to topic orders",
    ]).candidates[0]!;
    expect(c.key_name).toBe("message_id");
    const [start, end] = c.suggested_window!;
    expect(start! < "2026-09-15T10:00:00").toBe(true);
    expect(end! > "2026-09-15T11:00:00".slice(0, 19)).toBe(true);
  });

  it("gives a sync key a tight symmetric window", () => {
    const c = correlateIds(["2026-09-15T10:00:00Z trace_id=abc123def456 svc=checkout"])
      .candidates[0]!;
    const [start, end] = c.suggested_window!;
    expect(start! < "2026-09-15T10:00:00").toBe(true);
    expect(end! > "2026-09-15T10:00:00").toBe(true);
  });

  it("formats the suggested window as +00:00, matching the original contract", () => {
    const c = correlateIds(["2026-09-15T10:04:11Z trace_id=abc123def456"]).candidates[0]!;
    expect(c.suggested_window).toEqual(["2026-09-15T10:02:11+00:00", "2026-09-15T10:06:11+00:00"]);
  });

  it("returns no candidates when nothing matches", () => {
    expect(correlateIds(["just a plain log line with no ids"]).candidates).toEqual([]);
  });
});

describe("normalizeIdentifier", () => {
  it("includes the hex form of a numeric trace id", () => {
    // Datadog writes a trace id in decimal; W3C traceparent writes the same id
    // in hex. Without this conversion the two spellings never intersect.
    const c = correlateIds(["x-datadog-trace-id=4823516278365812 svc=checkout"]).candidates[0]!;
    expect(c.equivalent_forms).toContain((4823516278365812).toString(16));
    expect(c.equivalent_forms).toContain((4823516278365812).toString(16).padStart(32, "0"));
  });

  it("converts a decimal trace id beyond Number.MAX_SAFE_INTEGER exactly", () => {
    // 9925525482204591653 > 2^53-1. Parsed as a double it rounds, and the hex
    // form then matches nothing in any vendor's index — an empty result rather
    // than an error, which is the worst kind of failure.
    const forms = normalizeIdentifier("9925525482204591653");
    expect(forms).toContain("89be8cd69fe47625");
    expect(forms).toContain("000000000000000089be8cd69fe47625");
  });

  it("converts hex back to the exact decimal spelling", () => {
    expect(normalizeIdentifier("89be8cd69fe47625")).toContain("9925525482204591653");
  });

  it("includes dash-stripped and lowercased spellings", () => {
    const forms = normalizeIdentifier("REQ-Abc-123");
    expect(forms).toContain("REQ-Abc-123");
    expect(forms).toContain("req-abc-123");
    expect(forms).toContain("reqabc123");
  });
});
