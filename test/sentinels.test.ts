/**
 * The result sentinels must match BYTE-FOR-BYTE in three places. If they drift,
 * the Stop hook silently never matches a real turn and enforcement is dead with
 * no error anywhere — the failure is invisible, which is why it gets its own
 * test rather than relying on a grep in the docs.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RESULT_BEGIN_SENTINEL, RESULT_END_SENTINEL } from "../src/instructions.js";
import { INSTRUCTIONS } from "../src/instructions.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf-8");

const SOURCES: ReadonlyArray<readonly [string, () => string]> = [
  ["skills/rca-methodology/SKILL.md", () => read("skills", "rca-methodology", "SKILL.md")],
  ["hooks/stop-validate.mjs", () => read("hooks", "stop-validate.mjs")],
  ["src/instructions.ts (INSTRUCTIONS)", () => INSTRUCTIONS],
];

describe("result sentinels", () => {
  for (const [label, load] of SOURCES) {
    it(`${label} carries both sentinels verbatim`, () => {
      const text = load();
      expect(text).toContain(RESULT_BEGIN_SENTINEL);
      expect(text).toContain(RESULT_END_SENTINEL);
    });
  }

  it("keeps the sentinel spellings themselves unchanged", () => {
    expect(RESULT_BEGIN_SENTINEL).toBe("BEGIN_NEEDLE_MCP_RESULT_JSON");
    expect(RESULT_END_SENTINEL).toBe("END_NEEDLE_MCP_RESULT_JSON");
  });
});

/**
 * The envelope documented in SKILL.md must cover every field validateRca reads.
 * Two predicates key off alert_metric and monitored_resource.unresolved; these
 * were once absent from the documented envelope, which made those checks
 * permanently unreachable — the enforcement looked complete and silently wasn't.
 */
describe("documented envelope covers every field the linter reads", () => {
  const FIELDS_READ_BY_VALIDATOR = [
    "confidence",
    "status",
    "root_cause",
    "affected_services",
    "environment",
    "alert_window",
    "evidence",
    "hop_trace",
    "alert_metric",
    "decomposed_by",
    "monitored_resource",
  ];

  for (const field of FIELDS_READ_BY_VALIDATOR) {
    it(`SKILL.md documents '${field}'`, () => {
      expect(read("skills", "rca-methodology", "SKILL.md")).toContain(field);
    });
  }
});
