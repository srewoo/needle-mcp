import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AdapterConfig,
  loadAdapters,
  loadTopology,
  MissingCredentialError,
  resolveAdapterCredential,
} from "../src/config.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const tmp = () => mkdtempSync(join(tmpdir(), "needle-config-"));

function adapter(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    name: "x",
    base_url: "https://x",
    auth_mode: "none",
    auth_env_var: null,
    header_name: null,
    basic_user_env_var: null,
    basic_pass_env_var: null,
    query_template: "/q",
    response_path: null,
    field_map: {},
    covers: [],
    pagination_cursor_param: null,
    pagination_cursor_field: null,
    max_rows_per_call: 200,
    ...overrides,
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("loadAdapters / loadTopology", () => {
  it("returns empty when the adapters file is missing", () => {
    expect(loadAdapters(join(tmp(), "nope.yaml")).sources).toEqual([]);
  });

  it("parses a real adapters file", () => {
    const dir = tmp();
    const p = join(dir, "adapters.yaml");
    writeFileSync(
      p,
      [
        "sources:",
        "  - name: loki",
        "    base_url: https://loki.example.internal",
        "    auth_mode: static_header",
        "    auth_env_var: LOKI_AUTH_HEADER",
        "    header_name: Authorization",
        '    query_template: "/loki/api/v1/query_range?query={query}"',
        "    covers: [k8s_pod]",
        "",
      ].join("\n"),
    );
    const result = loadAdapters(p);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.name).toBe("loki");
    expect(result.sources[0]!.covers).toEqual(["k8s_pod"]);
  });

  it("returns empty when the topology file is missing", () => {
    expect(loadTopology(join(tmp(), "nope.yaml")).surfaces).toEqual({});
  });

  it("parses a real topology file", () => {
    const p = join(tmp(), "topology.yaml");
    writeFileSync(p, "surfaces:\n  loki:\n    covers: [k8s_pod]\n    blind_to: [lambda]\n");
    const result = loadTopology(p);
    expect(result.surfaces).toHaveProperty("loki");
    expect(result.surfaces.loki!.blind_to).toEqual(["lambda"]);
  });
});

describe("resolveAdapterCredential", () => {
  it("resolves a static_header credential from its env var", () => {
    process.env.MY_TOKEN = "secret-value";
    expect(resolveAdapterCredential(adapter({ auth_mode: "static_header", auth_env_var: "MY_TOKEN" }))).toBe(
      "secret-value",
    );
  });

  it("throws when the env var is unset", () => {
    delete process.env.MISSING_TOKEN;
    expect(() =>
      resolveAdapterCredential(adapter({ auth_mode: "static_header", auth_env_var: "MISSING_TOKEN" })),
    ).toThrow(MissingCredentialError);
  });

  it("returns null for auth_mode none", () => {
    expect(resolveAdapterCredential(adapter({ auth_mode: "none" }))).toBeNull();
  });

  it("returns null for basic, which assembles credentials elsewhere", () => {
    expect(resolveAdapterCredential(adapter({ auth_mode: "basic" }))).toBeNull();
  });
});

describe("shipped example config", () => {
  it("parses adapters.example.yaml", () => {
    const names = new Set(loadAdapters(join(REPO_ROOT, "adapters.example.yaml")).sources.map((s) => s.name));
    for (const expected of ["loki", "opensearch", "splunk"]) expect(names).toContain(expected);
  });

  it("parses topology.example.yaml and keeps its coverage caveats", () => {
    const result = loadTopology(join(REPO_ROOT, "topology.example.yaml"));
    expect(result.surfaces).toHaveProperty("datadog_logs");
    expect(result.surfaces.loki!.blind_to.length).toBeGreaterThan(0);
    // Log coverage is opt-in per service, so an empty result is the ordinary
    // case, not evidence a service was quiet.
    expect(result.surfaces.datadog_logs!.coverage_note).toContain("ORDINARY case");
    // Traces are sampled, so a missing error span is not proof no errors occurred.
    expect(result.surfaces.datadog_apm!.coverage_note).toContain("sampled");
  });
});
