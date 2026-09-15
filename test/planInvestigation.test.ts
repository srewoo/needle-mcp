import { describe, expect, it } from "vitest";
import type { AdapterConfig, TopologyFile } from "../src/config.js";
import { KEY_PATTERNS } from "../src/tools/correlateIds.js";
import {
  ASYNC_WINDOW_HINT,
  planInvestigation,
  SYNC_WINDOW_HINT,
} from "../src/tools/planInvestigation.js";

const EMPTY: TopologyFile = { surfaces: {} };
const ALL_KEY_NAMES = new Set(KEY_PATTERNS.map(([name]) => name));

function adapter(name: string, covers: string[]): AdapterConfig {
  return {
    name,
    base_url: `https://${name}.x`,
    auth_mode: "none",
    auth_env_var: null,
    header_name: null,
    basic_user_env_var: null,
    basic_pass_env_var: null,
    query_template: "/q?q={query}",
    response_path: null,
    field_map: {},
    covers,
    pagination_cursor_param: null,
    pagination_cursor_field: null,
    max_rows_per_call: 200,
  };
}

const adapters = () => [adapter("loki", ["k8s_pod"]), adapter("splunk", ["generic_service"])];

const topology = (): TopologyFile => ({
  surfaces: {
    loki: { covers: ["k8s_pod"], blind_to: ["lambda"], tool_prefix: null, coverage_note: null },
    cloudwatch: { covers: ["lambda"], blind_to: ["k8s_pod"], tool_prefix: null, coverage_note: null },
  },
});

const planFor = (identifier: string, environment: string | null = "prod") =>
  planInvestigation(identifier, environment, [], EMPTY);

describe("identifier classification", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["3f2504e0-4f89-11d3-9a0c-0305e82c3301", "uuid"],
    ["4bf92f3577b34da6a3ce929d0e0e4736", "w3c_trace"],
    ["4823516278365812", "datadog_decimal_trace"],
    ["1-5759e988-bd862e3fe1be46a994272793", "aws_xray"],
    ["sess_abc123XYZ", "opaque"],
  ];

  for (const [identifier, kind] of cases) {
    it(`classifies ${kind}`, () => {
      expect(planInvestigation(identifier, null, [], EMPTY).identifier_kind).toBe(kind);
    });
  }

  it("classifies a 32-digit decimal string as w3c_trace", () => {
    // Pins current behaviour: DECIMAL is bounded to {6,20} digits, so a
    // 32-character all-decimal string can only match W3C_TRACE (digits are
    // legal hex). This would fail if DECIMAL's bound were widened toward 32
    // without preserving the W3C_TRACE-before-DECIMAL order.
    expect(planInvestigation("1".repeat(32), null, [], EMPTY).identifier_kind).toBe("w3c_trace");
  });

  it("offers a hex equivalent form for a decimal trace", () => {
    expect(planInvestigation("4823516278365812", null, [], EMPTY).equivalent_forms).toContain(
      (4823516278365812).toString(16),
    );
  });
});

describe("queryable sources and next steps", () => {
  it("lists configured adapters", () => {
    const plan = planInvestigation("sess_abc123XYZ", null, adapters(), EMPTY);
    const names = plan.queryable_sources
      .filter((s) => s.kind === "configured_adapter")
      .map((s) => s.name);
    expect(new Set(names)).toEqual(new Set(["loki", "splunk"]));
  });

  it("lists coverage surfaces", () => {
    const plan = planInvestigation("sess_abc123XYZ", null, [], topology());
    const names = plan.queryable_sources
      .filter((s) => s.kind === "coverage_surface")
      .map((s) => s.name);
    expect(new Set(names)).toEqual(new Set(["loki", "cloudwatch"]));
  });

  it("flags unknown coverage when nothing is configured", () => {
    const plan = planInvestigation("sess_abc123XYZ", null, [], EMPTY);
    expect(plan.unknown_coverage).toBe(true);
    expect(plan.next_steps.some((s) => s.toLowerCase().includes("no configured sources"))).toBe(true);
  });

  it("mentions the correlate_ids handoff", () => {
    const plan = planInvestigation("sess_abc123XYZ", null, adapters(), EMPTY);
    expect(plan.next_steps.some((s) => s.includes("correlate_ids"))).toBe(true);
  });

  it("echoes a given environment into next steps", () => {
    const plan = planInvestigation("sess_abc123XYZ", "staging", adapters(), EMPTY);
    expect(plan.next_steps.some((s) => s.includes("staging"))).toBe(true);
  });

  it("prompts for the environment when missing", () => {
    const plan = planInvestigation("sess_abc123XYZ", null, adapters(), EMPTY);
    expect(plan.next_steps.some((s) => s.toLowerCase().includes("environment"))).toBe(true);
  });
});

describe("window hints", () => {
  it("widens for an async-shaped identifier", () => {
    const plan = planInvestigation("msg-00ab12cd34ef", null, [], EMPTY);
    expect(plan.is_async_shaped).toBe(true);
    expect(plan.suggested_window_hint).toBe(ASYNC_WINDOW_HINT);
  });

  it("stays tight for a sync identifier", () => {
    const plan = planInvestigation("3f2504e0-4f89-11d3-9a0c-0305e82c3301", null, [], EMPTY);
    expect(plan.is_async_shaped).toBe(false);
    expect(plan.suggested_window_hint).toBe(SYNC_WINDOW_HINT);
  });
});

// --- likely_key_names actually filters (I6) ---------------------------------
//
// The field previously returned every key in KEY_PATTERNS for every identifier:
// ASYNC_KEYS is a strict SUBSET of KEY_PATTERNS, so both arms of the is_async
// conditional produced the identical list. Nothing was "likely" about it.
describe("likely_key_names", () => {
  it("does not offer a UUID the Datadog or traceparent specific keys", () => {
    const plan = planFor("6f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8");
    expect(plan.identifier_kind).toBe("uuid");
    expect(plan.likely_key_names).not.toContain("x-datadog-trace-id");
    expect(plan.likely_key_names).not.toContain("traceparent");
    expect(plan.likely_key_names).not.toContain("x-amzn-trace-id");
    expect(plan.likely_key_names).toContain("x-request-id");
  });

  it("differs across identifier kinds", () => {
    // The point of the field: the same list for every id is no signal at all.
    const uuidKeys = planFor("6f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8").likely_key_names;
    const w3cKeys = planFor("4bf92f3577b34da6a3ce929d0e0e4736").likely_key_names;
    const xrayKeys = planFor("1-5759e988-bd862e3fe1be46a994272793").likely_key_names;
    expect(uuidKeys).not.toEqual(w3cKeys);
    expect(w3cKeys).not.toEqual(xrayKeys);
    expect(w3cKeys).toContain("traceparent");
    expect(xrayKeys).toContain("x-amzn-trace-id");
    expect(xrayKeys).not.toContain("traceparent");
  });

  it("gives a decimal trace the Datadog key", () => {
    const plan = planFor("13088165645273925280");
    expect(plan.identifier_kind).toBe("datadog_decimal_trace");
    expect(plan.likely_key_names).toContain("x-datadog-trace-id");
  });

  it("does not narrow an opaque identifier", () => {
    const plan = planFor("sess_ABCdef");
    expect(plan.identifier_kind).toBe("opaque");
    for (const key of ["x-request-id", "traceparent", "x-datadog-trace-id"]) {
      expect(plan.likely_key_names).toContain(key);
    }
  });

  it("adds the async keys for an async-shaped identifier", () => {
    const plan = planFor("msg-6f0a1b2c3d4e");
    expect(plan.is_async_shaped).toBe(true);
    expect(plan.likely_key_names).toContain("message_id");
    expect(plan.likely_key_names).toContain("job_id");
  });

  it("withholds async-only keys from a non-async identifier", () => {
    const plan = planFor("6f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8");
    expect(plan.is_async_shaped).toBe(false);
    expect(plan.likely_key_names).not.toContain("message_id");
    expect(plan.likely_key_names).not.toContain("job_id");
  });

  it("never names a key correlateIds cannot extract", () => {
    for (const identifier of [
      "6f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8",
      "4bf92f3577b34da6a3ce929d0e0e4736",
      "1-5759e988-bd862e3fe1be46a994272793",
      "13088165645273925280",
      "sess_ABCdef",
      "msg-abc123",
    ]) {
      const plan = planFor(identifier);
      expect(plan.likely_key_names.length).toBeGreaterThan(0);
      for (const key of plan.likely_key_names) expect(ALL_KEY_NAMES).toContain(key);
    }
  });
});
