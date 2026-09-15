import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AdapterConfig } from "../src/config.js";
import { listGenericSources } from "../src/tools/listGenericSources.js";
import { queryGenericSource } from "../src/tools/queryGenericSource.js";
import { resolveAdapter } from "../src/tools/resolveAdapter.js";

const state = { requestedPaths: [] as string[], redirectTargetHitCount: 0 };
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "";
    state.requestedPaths.push(path);

    if (path.startsWith("/redirect-target")) {
      // Should never be reached — the redirect target is off-allowlist
      // ("localhost" !== "127.0.0.1") and must be blocked before contact.
      state.redirectTargetHitCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ rows: [{ line: "should-not-be-reached" }] }));
      return;
    }
    if (path.startsWith("/redirect")) {
      res.writeHead(302, { Location: `http://localhost:${port}/redirect-target` });
      res.end();
      return;
    }

    let body: string;
    if (path.includes("/scalar")) body = JSON.stringify("just-a-string");
    else if (path.includes("cursor=page2")) body = JSON.stringify({ rows: [{ line: "row-page-2" }] });
    else if (path.includes("/big"))
      body = JSON.stringify({ rows: Array.from({ length: 50 }, (_, i) => ({ line: `row-${i}` })) });
    else body = JSON.stringify({ rows: [{ line: "row-1" }], next_cursor: "page2" });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

function adapterFor(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    name: "test-source",
    base_url: `http://127.0.0.1:${port}`,
    auth_mode: "none",
    auth_env_var: null,
    header_name: null,
    basic_user_env_var: null,
    basic_pass_env_var: null,
    query_template: "/search?q={query}&start={start}&end={end}",
    response_path: "rows",
    field_map: {},
    covers: [],
    pagination_cursor_param: "cursor",
    pagination_cursor_field: "next_cursor",
    max_rows_per_call: 200,
    ...overrides,
  };
}

const RANGE = { start: "2026-09-15T00:00:00Z", end: "2026-09-15T01:00:00Z" };
const run = (adapter: AdapterConfig, params: Record<string, unknown>, hosts: string[], cursor = null as string | null) =>
  queryGenericSource(adapter, params, RANGE, hosts, cursor);

describe("queryGenericSource", () => {
  it("returns rows", async () => {
    const result = await run(adapterFor(), { query: "checkout" }, ["127.0.0.1"]);
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([{ line: "row-1" }]);
    expect(result.next_cursor).toBe("page2");
  });

  it("flags truncated when a cursor is present", async () => {
    expect((await run(adapterFor(), { query: "checkout" }, ["127.0.0.1"])).truncated).toBe(true);
  });

  it("rejects a disallowed host", async () => {
    const result = await run(adapterFor(), { query: "checkout" }, ["some-other-host.internal"]);
    expect(result.error).toContain("not in the configured allowlist");
  });

  it("accepts a URL-valued query", async () => {
    // Searching logs FOR a URL must work — the param is encoded, and structural
    // safety is enforced on the built URL, not by banning substrings.
    const result = await run(adapterFor(), { query: "https://api.example.com/checkout" }, ["127.0.0.1"]);
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([{ line: "row-1" }]);
  });

  it("reports a missing template placeholder", async () => {
    const adapter = adapterFor({ query_template: "/search?q={query}&team={team}" });
    const result = await run(adapter, { query: "checkout" }, ["127.0.0.1"]);
    expect(result.error).toContain("placeholder not satisfied");
  });

  it("respects max_rows_per_call", async () => {
    const adapter = adapterFor({ query_template: "/big?q={query}", max_rows_per_call: 10 });
    const result = await run(adapter, { query: "x" }, ["127.0.0.1"]);
    expect(result.returned_count).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it("encodes start/end against query injection", async () => {
    // start/end are model-supplied, exactly as untrusted as params. An
    // unencoded '&admin=true' suffix must not inject an extra query parameter.
    const result = await queryGenericSource(
      adapterFor(),
      { query: "checkout" },
      { start: "2026-09-15T00:00:00Z&admin=true", end: "2026-09-15T01:00:00Z" },
      ["127.0.0.1"],
    );
    expect(result.error).toBeNull();
    const lastPath = state.requestedPaths.at(-1)!;
    expect(lastPath).not.toContain("&admin=true");
    expect(lastPath).toContain("%26admin%3Dtrue");
  });

  it("returns a null next_cursor on the final page", async () => {
    const result = await run(adapterFor(), { query: "checkout" }, ["127.0.0.1"], "page2");
    expect(result.error).toBeNull();
    expect(result.next_cursor).toBeNull();
  });

  it("does not crash on a scalar JSON payload", async () => {
    // A backend returning a bare JSON scalar must come back as a clean
    // structured result with no rows and no cursor.
    const adapter = adapterFor({ query_template: "/scalar?q={query}&start={start}&end={end}" });
    const result = await run(adapter, { query: "checkout" }, ["127.0.0.1"]);
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([]);
    expect(result.next_cursor).toBeNull();
  });
});

describe("redirect pinning", () => {
  it("blocks an off-allowlist redirect BEFORE contacting the target", async () => {
    const adapter = adapterFor({ query_template: "/redirect?q={query}&start={start}&end={end}" });
    state.redirectTargetHitCount = 0;
    const result = await run(adapter, { query: "checkout" }, ["127.0.0.1"]);
    expect(result.error).toContain("localhost");
    expect(state.redirectTargetHitCount).toBe(0);
  });

  it("refuses a redirect to a DIFFERENT configured adapter's host", async () => {
    // Credentials must not cross adapters on a redirect. Here 'localhost' IS in
    // allowedHosts — it stands for a second configured adapter, exactly as the
    // server builds the union of every adapter's host. With a union-scoped
    // redirect allowlist this request would follow the redirect and hand
    // adapter A's Authorization header to adapter B's host.
    process.env.SOURCE_A_TOKEN = "Bearer source-a-secret";
    const adapter = adapterFor({
      name: "source-a",
      auth_mode: "static_header",
      auth_env_var: "SOURCE_A_TOKEN",
      query_template: "/redirect?q={query}&start={start}&end={end}",
    });
    state.redirectTargetHitCount = 0;
    const result = await run(adapter, { query: "checkout" }, ["127.0.0.1", "localhost"]);
    expect(result.error).toContain("localhost");
    expect(state.redirectTargetHitCount).toBe(0);
  });

  it("keeps the FULL allowlist for the pre-request check", async () => {
    // Scoping the redirect allowlist must not narrow the pre-request check.
    const result = await run(adapterFor(), { query: "checkout" }, [
      "127.0.0.1",
      "localhost",
      "logs.other.internal",
    ]);
    expect(result.error).toBeNull();
    expect(result.returned_count).toBe(1);
  });
});

// --- Credential handling (I4) -----------------------------------------------
describe("credential errors name the environment, not the query", () => {
  it("names the unset basic-auth env var", async () => {
    // Sending Basic base64(":") gets a 401 from the vendor and leaves the
    // operator debugging their query instead of their environment.
    delete process.env.NEEDLE_MCP_TEST_BASIC_USER;
    delete process.env.NEEDLE_MCP_TEST_BASIC_PASS;
    const adapter = adapterFor({
      auth_mode: "basic",
      basic_user_env_var: "NEEDLE_MCP_TEST_BASIC_USER",
      basic_pass_env_var: "NEEDLE_MCP_TEST_BASIC_PASS",
    });
    const result = await run(adapter, { query: "checkout" }, ["127.0.0.1"]);
    expect(result.rows).toEqual([]);
    expect(result.error).toContain("NEEDLE_MCP_TEST_BASIC_USER");
    expect(result.error).not.toContain("Rejected param");
  });

  it("names the missing basic-auth config field", async () => {
    const result = await run(adapterFor({ auth_mode: "basic" }), { query: "checkout" }, ["127.0.0.1"]);
    expect(result.error).toContain("basic_user_env_var");
  });

  it("succeeds when both basic-auth env vars are set", async () => {
    process.env.NEEDLE_MCP_TEST_BASIC_USER = "svc";
    process.env.NEEDLE_MCP_TEST_BASIC_PASS = "hunter2";
    const adapter = adapterFor({
      auth_mode: "basic",
      basic_user_env_var: "NEEDLE_MCP_TEST_BASIC_USER",
      basic_pass_env_var: "NEEDLE_MCP_TEST_BASIC_PASS",
    });
    const result = await run(adapter, { query: "checkout" }, ["127.0.0.1"]);
    expect(result.error).toBeNull();
    expect(result.returned_count).toBe(1);
  });

  it("does not report a missing static_header credential as a rejected param", async () => {
    delete process.env.NEEDLE_MCP_TEST_TOKEN;
    const adapter = adapterFor({ auth_mode: "static_header", auth_env_var: "NEEDLE_MCP_TEST_TOKEN" });
    const result = await run(adapter, { query: "checkout" }, ["127.0.0.1"]);
    expect(result.error).not.toContain("Rejected param");
    expect(result.error).toContain("NEEDLE_MCP_TEST_TOKEN");
    expect(result.error!.toLowerCase()).toContain("credential");
  });

  it("still says 'Rejected param' for a genuinely rejected param", async () => {
    const result = await run(adapterFor(), { query: "//evil.example.com" }, ["127.0.0.1"]);
    expect(result.error!.startsWith("Rejected param")).toBe(true);
  });
});

describe("resolveAdapter and listGenericSources", () => {
  it("finds a matching name", () => {
    const adapter = adapterFor({ name: "my-source" });
    const other = adapterFor({ name: "other-source" });
    expect(resolveAdapter("my-source", [other, adapter])).toBe(adapter);
  });

  it("returns null on a miss", () => {
    expect(resolveAdapter("nonexistent", [adapterFor({ name: "my-source" })])).toBeNull();
  });

  it("returns the SourceInfo shape", () => {
    const listed = listGenericSources([adapterFor({ covers: ["k8s_pod"] })])[0]!;
    expect(listed.name).toBe("test-source");
    expect(listed.covers).toEqual(["k8s_pod"]);
    expect(Object.keys(listed).sort()).toEqual(["auth_mode", "base_url_host", "covers", "name"]);
  });

  it("derives a host that matches the allowlisted host, port dropped", () => {
    // A string-split derivation KEEPS the port while the server's allowlist uses
    // URL.hostname, which drops it — the two disagreed for every adapter on a
    // non-default port, which the mock server here is.
    const listed = listGenericSources([adapterFor()])[0]!;
    expect(listed.base_url_host).toBe("127.0.0.1");
    expect(listed.base_url_host).not.toContain(":");
  });
});
