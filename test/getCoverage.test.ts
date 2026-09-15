import { describe, expect, it } from "vitest";
import type { TopologyFile } from "../src/config.js";
import { getCoverage } from "../src/tools/getCoverage.js";

function topology(): TopologyFile {
  return {
    surfaces: {
      loki: { covers: ["k8s_pod"], blind_to: ["lambda"], tool_prefix: null, coverage_note: null },
      cloudwatch: {
        covers: ["lambda"],
        blind_to: ["k8s_pod"],
        tool_prefix: null,
        coverage_note: null,
      },
    },
  };
}

describe("getCoverage", () => {
  it("finds the covering surface", () => {
    const result = getCoverage("k8s_pod", topology());
    expect(result.covering_surfaces).toEqual(["loki"]);
    expect(result.blind_surfaces).toContain("cloudwatch");
    expect(result.unknown_coverage).toBe(false);
  });

  it("lists the blind surface for another resource", () => {
    const result = getCoverage("lambda", topology());
    expect(result.covering_surfaces).toEqual(["cloudwatch"]);
    expect(result.blind_surfaces).toContain("loki");
  });

  it("flags an unknown resource type", () => {
    const result = getCoverage("airflow_task", topology());
    expect(result.covering_surfaces).toEqual([]);
    expect(result.blind_surfaces).toEqual([]);
    expect(result.unknown_coverage).toBe(true);
  });

  it("treats an empty topology as unknown", () => {
    expect(getCoverage("anything", { surfaces: {} }).unknown_coverage).toBe(true);
  });
});
