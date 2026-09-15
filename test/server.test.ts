import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTRUCTIONS } from "../src/instructions.js";
import { METHODOLOGY_URI, methodologyText } from "../src/methodology.js";
import { createServer } from "../src/server.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const tmp = () => mkdtempSync(join(tmpdir(), "needle-server-"));

const savedEnv = { ...process.env };
const savedCwd = process.cwd();
afterEach(() => {
  process.env = { ...savedEnv };
  process.chdir(savedCwd);
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const client = await connect();
  const result: any = await client.callTool({ name: tool, arguments: args });
  return JSON.parse(result.content[0].text);
}

describe("tool registration", () => {
  it("registers exactly the expected tools", async () => {
    const client = await connect();
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(names).toEqual(
      new Set([
        "correlate_ids",
        "analyze_visual_evidence",
        "query_generic_source",
        "list_generic_sources",
        "get_coverage",
        "validate_rca",
        "plan_investigation",
      ]),
    );
  });
});

describe("tool wrappers dispatch to the pure functions", () => {
  it("correlate_ids surfaces a known id", async () => {
    const parsed = await call("correlate_ids", { evidence_snippets: ["x-request-id=req-12345"] });
    expect(parsed.candidates[0].value).toBe("req-12345");
  });

  it("get_coverage flags an unknown resource type", async () => {
    process.env.NEEDLE_MCP_CONFIG_DIR = tmp();
    expect((await call("get_coverage", { resource_type: "airflow_task" })).unknown_coverage).toBe(true);
  });

  it("validate_rca rejects an empty claim", async () => {
    const parsed = await call("validate_rca", { claim_json: {} });
    expect(parsed.approved).toBe(false);
    expect(parsed.gaps[0].name).toBe("format-violation");
  });

  it("plan_investigation classifies a uuid", async () => {
    process.env.NEEDLE_MCP_CONFIG_DIR = tmp();
    const parsed = await call("plan_investigation", {
      identifier: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(parsed.identifier_kind).toBe("uuid");
  });

  it("analyze_visual_evidence returns empty entries on empty input", async () => {
    expect((await call("analyze_visual_evidence", { context: "none" })).har_entries).toEqual([]);
  });

  it("list_generic_sources returns a list", async () => {
    process.env.NEEDLE_MCP_CONFIG_DIR = tmp();
    expect(await call("list_generic_sources", {})).toEqual([]);
  });

  it("query_generic_source reports an unknown source", async () => {
    process.env.NEEDLE_MCP_CONFIG_DIR = tmp();
    const parsed = await call("query_generic_source", {
      source: "nonexistent-source",
      params: {},
      start: "2026-09-15T00:00:00Z",
      end: "2026-09-15T01:00:00Z",
    });
    expect(parsed.error).toContain("Unknown source 'nonexistent-source'");
  });
});

describe("config resolution", () => {
  it("honours NEEDLE_MCP_CONFIG_DIR at call time", async () => {
    // Safety-critical: an MCP server launched as a subprocess inherits an
    // unpredictable cwd, so this must be honoured per call, not baked in at
    // module load.
    const dir = tmp();
    process.env.NEEDLE_MCP_CONFIG_DIR = dir;
    writeFileSync(
      join(dir, "adapters.yaml"),
      ["sources:", "  - name: my-source", "    base_url: http://example.internal", "    query_template: /search?q={query}", ""].join("\n"),
    );
    expect(await call("list_generic_sources", {})).toEqual([
      { name: "my-source", base_url_host: "example.internal", auth_mode: "none", covers: [] },
    ]);
  });
});

describe("server instructions", () => {
  it("state the load-bearing guidance", async () => {
    // These are the four things INSTRUCTIONS has to carry on a host that reads
    // nothing else: prefer a sibling vendor MCP, the two entry points, and both
    // envelope sentinels.
    expect(INSTRUCTIONS).toContain("query_generic_source");
    expect(INSTRUCTIONS).toContain("ONLY when no such vendor MCP");
    expect(INSTRUCTIONS).toContain("plan_investigation");
    expect(INSTRUCTIONS).toContain("correlate_ids");
    expect(INSTRUCTIONS).toContain("validate_rca");
    expect(INSTRUCTIONS).toContain("BEGIN_NEEDLE_MCP_RESULT_JSON");
    expect(INSTRUCTIONS).toContain("END_NEEDLE_MCP_RESULT_JSON");
  });

  it("are advertised to a connecting client", async () => {
    const client = await connect();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });
});

// --- Methodology delivery on non-Claude-Code hosts (spec §3) ----------------
//
// Claude Code loads skills/rca-methodology/SKILL.md through the plugin. Every
// other host can only receive the methodology as an MCP prompt or resource; the
// instructions string names the sentinels but carries neither the envelope
// schema nor the five rules.
describe("methodology delivery", () => {
  it("lists the prompt", async () => {
    const client = await connect();
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain("rca_methodology");
  });

  it("lists the resource", async () => {
    const client = await connect();
    expect((await client.listResources()).resources.map((r) => r.uri)).toContain(METHODOLOGY_URI);
  });

  it("carries the envelope contract in the resource body", async () => {
    const client = await connect();
    const body = (await client.readResource({ uri: METHODOLOGY_URI })).contents
      .map((c: any) => c.text)
      .join("");
    expect(body).toContain("BEGIN_NEEDLE_MCP_RESULT_JSON");
    expect(body).toContain("END_NEEDLE_MCP_RESULT_JSON");
  });

  it("serves prompt and resource from ONE source of truth", async () => {
    const client = await connect();
    const promptBody = (await client.getPrompt({ name: "rca_methodology" })).messages
      .map((m: any) => m.content.text)
      .join("");
    const resourceBody = (await client.readResource({ uri: METHODOLOGY_URI })).contents
      .map((c: any) => c.text)
      .join("");
    expect(promptBody).toBe(resourceBody);
    expect(promptBody).toBe(
      readFileSync(join(REPO_ROOT, "skills", "rca-methodology", "SKILL.md"), "utf-8"),
    );
  });

  it("does not depend on cwd", async () => {
    // An MCP server inherits an unpredictable cwd; resolution must not use it.
    process.chdir(tmp());
    expect(methodologyText()).toContain("BEGIN_NEEDLE_MCP_RESULT_JSON");
  });
});

// --- Arguments as they arrive over the wire ---------------------------------
//
// Unit tests call the pure functions directly and so cannot see wire-level
// coercion. A parameter whose payload is JSON text needs a test through an
// actual tool call.
const WIRE_HAR = {
  log: {
    entries: [
      {
        request: {
          method: "GET",
          url: "https://api.example.com/checkout",
          headers: [{ name: "x-request-id", value: "req-wire-1" }],
        },
        response: { status: 503 },
        time: 42,
        startedDateTime: "2026-09-15T10:00:00Z",
      },
    ],
  },
};

describe("wire-level argument handling", () => {
  it("accepts har_json as TEXT", async () => {
    const parsed = await call("analyze_visual_evidence", {
      context: "",
      har_json: JSON.stringify(WIRE_HAR),
    });
    expect(parsed.har_entries).toHaveLength(1);
    expect(parsed.har_entries[0].status).toBe(503);
    expect(parsed.har_entries[0].timestamp).toBe("2026-09-15T10:00:00Z");
    expect(parsed.har_entries[0].correlation_headers["x-request-id"]).toBe("req-wire-1");
  });

  it("accepts har_json as an OBJECT", async () => {
    const parsed = await call("analyze_visual_evidence", { context: "", har_json: WIRE_HAR });
    expect(parsed.har_entries[0].status).toBe(503);
  });

  it("accepts har_path over the wire", async () => {
    const p = join(tmp(), "wire.har");
    writeFileSync(p, JSON.stringify(WIRE_HAR));
    const parsed = await call("analyze_visual_evidence", { context: "", har_path: p });
    expect(parsed.har_entries[0].status).toBe(503);
  });

  it("accepts a structured claim_json over the wire", async () => {
    const parsed = await call("validate_rca", {
      claim_json: {
        confidence: "inconclusive",
        status: "inconclusive",
        root_cause: "no cause established",
        affected_services: ["checkout"],
        environment: "prod",
        alert_window: { start: "2026-09-15T10:00:00Z", end: "2026-09-15T10:10:00Z" },
        evidence: [],
      },
    });
    expect(parsed.approved).toBe(true);
  });

  it("accepts dict params over the wire", async () => {
    process.env.NEEDLE_MCP_CONFIG_DIR = tmp();
    const parsed = await call("query_generic_source", {
      source: "nope",
      params: { query: "checkout" },
      start: "2026-09-15T10:00:00Z",
      end: "2026-09-15T10:10:00Z",
    });
    expect(parsed.error).toContain("Unknown source");
  });
});
