/**
 * The binary must actually start when executed — including through a symlink.
 *
 * The entry guard compares `import.meta.url` against `process.argv[1]`. A naive
 * string comparison passes locally and fails for every real install: npm's
 * node_modules/.bin shims, macOS /tmp -> /private/tmp, and nvm prefixes all put
 * a symlink between the two. The binary then exits 0 having done nothing, which
 * looks like a clean run and is invisible to every in-process test.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIST_ENTRY = resolve(import.meta.dirname, "..", "dist", "index.js");

const INITIALIZE = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
})}\n`;

function handshake(entry: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("node", [entry], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.stdin.write(INITIALIZE);
    setTimeout(() => {
      child.kill();
      resolvePromise({ stdout, stderr });
    }, 1500);
  });
}

describe("binary entry point", () => {
  it("responds to initialize when run directly", async () => {
    const { stdout } = await handshake(DIST_ENTRY);
    expect(stdout.trim(), "server produced no output — the entry guard did not fire").not.toBe("");
    expect(JSON.parse(stdout.trim().split("\n")[0]!).result.serverInfo.name).toBe("needle-mcp");
  }, 10_000);

  it("responds to initialize when run THROUGH A SYMLINK", async () => {
    const link = join(mkdtempSync(join(tmpdir(), "needle-link-")), "needle-mcp");
    symlinkSync(DIST_ENTRY, link);
    const { stdout } = await handshake(link);
    expect(stdout.trim(), "server produced no output when invoked via a symlink").not.toBe("");
    expect(JSON.parse(stdout.trim().split("\n")[0]!).result.serverInfo.name).toBe("needle-mcp");
  }, 10_000);

  it("keeps stdout free of anything that is not JSON-RPC", async () => {
    // stdout is the protocol channel; a stray write corrupts it.
    const { stdout, stderr } = await handshake(DIST_ENTRY);
    for (const line of stdout.trim().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Diagnostics still happen — they just go to stderr.
    expect(stderr).toContain("Starting needle-mcp MCP server");
  }, 10_000);
});
