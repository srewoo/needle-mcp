import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { METHODOLOGY_CANDIDATES, methodologyText } from "../src/methodology.js";

describe("methodology delivery", () => {
  it("degrades to a fallback when the skill file is missing", () => {
    // A missing skill file must not crash the server on a prompt/resource read
    // — this is read on every host that connects.
    const text = methodologyText([join("/nonexistent", "nope", "SKILL.md")]);
    expect(text).toContain("BEGIN_NEEDLE_MCP_RESULT_JSON");
    expect(text).toContain("END_NEEDLE_MCP_RESULT_JSON");
    expect(text).toContain("could not be located");
  });

  it("resolves the real skill file from the default candidates", () => {
    const text = methodologyText();
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toContain("BEGIN_NEEDLE_MCP_RESULT_JSON");
  });

  it("offers candidates covering both the published package and a checkout", () => {
    // Published layout puts skills/ beside dist/; a checkout puts it at the root.
    expect(METHODOLOGY_CANDIDATES.length).toBeGreaterThanOrEqual(2);
    for (const c of METHODOLOGY_CANDIDATES) {
      expect(c).toContain("SKILL.md");
      // Never cwd-relative: an MCP subprocess inherits an unpredictable cwd.
      expect(c.startsWith("/")).toBe(true);
    }
  });
});
