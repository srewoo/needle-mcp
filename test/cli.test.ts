/**
 * The two entry-point flags, neither of which any in-process test reaches.
 */
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRY = resolve(import.meta.dirname, "..", "dist", "index.js");

describe("--help", () => {
  it("prints usage and exits 0 without starting a server", () => {
    const out = execFileSync("node", [ENTRY, "--help"], { encoding: "utf-8", timeout: 10_000 });
    expect(out).toContain("Usage: needle-mcp");
    expect(out).toContain("--http");
    expect(out).toContain("NEEDLE_MCP_CONFIG_DIR");
  });
});

describe("--http", () => {
  it("serves initialize over streamable HTTP", async () => {
    const port = 8793;
    const child = spawn("node", [ENTRY, "--http", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
      });
      const body = await res.text();
      expect(body).toContain('"serverInfo"');
      expect(body).toContain("needle-mcp");
    } finally {
      child.kill();
    }
  }, 20_000);
});
