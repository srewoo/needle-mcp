import { describe, expect, it } from "vitest";
import { boundJson, DEFAULT_MAX_CHARS } from "../src/bounding.js";

describe("boundJson", () => {
  it("does not truncate a small payload", () => {
    const data = { rows: [{ a: 1 }], truncated: false, returned_count: 1 };
    const [text, truncated] = boundJson(data);
    expect(truncated).toBe(false);
    expect(JSON.parse(text)).toEqual(data);
  });

  it("truncates a rows payload by dropping rows", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ line: "x".repeat(100), i }));
    const [text, truncated] = boundJson({ rows, truncated: false, returned_count: 500 }, 2000);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(2000);
    const parsed = JSON.parse(text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.rows.length).toBeLessThan(500);
    expect(parsed).toHaveProperty("_truncation_note");
  });

  it("hard-truncates a non-rows payload with a note", () => {
    const [text, truncated] = boundJson({ blob: "y".repeat(20000) }, 1000);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(1005);
    expect(text.toLowerCase()).toContain("truncation");
  });

  it("applies DEFAULT_MAX_CHARS as an ordinary bound, not a separate code path", () => {
    const under = { rows: Array.from({ length: 20 }, () => ({ line: "x".repeat(100) })) };
    const [underText, underTruncated] = boundJson(under);
    expect(underTruncated).toBe(false);
    expect(underText.length).toBeLessThan(DEFAULT_MAX_CHARS);

    const over = { rows: Array.from({ length: 500 }, () => ({ line: "x".repeat(100) })) };
    const [overText, overTruncated] = boundJson(over);
    expect(overTruncated).toBe(true);
    expect(overText.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
    expect(JSON.parse(overText).rows.length).toBeLessThan(500);

    expect(boundJson(over, DEFAULT_MAX_CHARS)).toEqual(boundJson(over));
  });

  it("stringifies BigInt rather than throwing", () => {
    // json.dumps(default=str) never raised here; JSON.stringify would.
    const [text] = boundJson({ id: 9925525482204591653n });
    expect(JSON.parse(text).id).toBe("9925525482204591653");
  });
});
