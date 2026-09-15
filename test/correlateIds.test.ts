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

  // --- Underscored identifiers -----------------------------------------------
  //
  // The opaque-token class once excluded '_', so `request_id=req_7f3a9c`
  // captured only `req` — below the {6,} floor — and the id was dropped with no
  // error and no candidate. `req_`/`msg_`/`job_`/`sess_` prefixes are among the
  // most common conventions in the wild, so the pattern missed exactly the ids
  // most worth correlating, and the empty result read as "these logs share
  // nothing".
  it("extracts underscored ids across every opaque-token key", () => {
    const result = correlateIds([
      "2026-09-15T10:04:11Z status=500 request_id=req_7f3a9c trace_id=trace_abc123",
      "2026-09-15T10:04:11Z publish failed message_id=msg_01HQ7 correlation_id=corr_zz99x",
      "2026-09-15T10:04:19Z retry message_id=msg_01HQ7 job_id=job_5521 x-request-id=xrq_44ab21",
    ]);
    const found = new Map(result.candidates.map((c) => [c.key_name, c.value]));
    expect(found.get("request_id")).toBe("req_7f3a9c");
    expect(found.get("trace_id")).toBe("trace_abc123");
    expect(found.get("message_id")).toBe("msg_01HQ7");
    expect(found.get("correlation_id")).toBe("corr_zz99x");
    expect(found.get("job_id")).toBe("job_5521");
    expect(found.get("x-request-id")).toBe("xrq_44ab21");
  });

  it("ranks an underscored id high when it spans the sync-to-async hop", () => {
    // The whole purpose of the tool: carrying an id from the producer's log
    // into the consumer's.
    const result = correlateIds([
      "2026-09-15T10:04:11Z ERROR publish failed message_id=msg_01HQ7",
      "2026-09-15T10:04:19Z WARN consumer retry 3/5 message_id=msg_01HQ7",
    ]);
    const msg = result.candidates.find((c) => c.key_name === "message_id")!;
    expect(msg.confidence).toBe("high");
    expect(new Set(msg.seen_in_snippets)).toEqual(new Set([0, 1]));
  });

  it("stops an underscored value at whitespace and punctuation", () => {
    // Widening the class must not let one value swallow the next token.
    const result = correlateIds(["request_id=req_7f3a9c,trace_id=trace_abc123 svc=checkout"]);
    const values = result.candidates.map((c) => c.value);
    expect(values).toContain("req_7f3a9c");
    expect(values).toContain("trace_abc123");
    for (const v of values) expect(v).not.toContain(" ");
  });

  it("denylists underscored placeholder values", () => {
    // These became reachable only once '_' entered the class; they are real
    // placeholders, and a false candidate sends an investigation down a wrong
    // path just as effectively as a missing one.
    const result = correlateIds([
      "request_id=not_available trace_id=undefined message_id=not_set job_id=none_provided",
    ]);
    expect(result.candidates).toEqual([]);
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
