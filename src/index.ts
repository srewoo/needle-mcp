#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "./logger.js";
import { createServer } from "./server.js";

export { createServer } from "./server.js";
export { validateRca } from "./tools/validateRca.js";
export { RESULT_BEGIN_SENTINEL, RESULT_END_SENTINEL } from "./instructions.js";

async function runHttp(port: number): Promise<void> {
  const { createServer: createHttpServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await createServer().connect(transport);

  createHttpServer((req, res) => {
    void transport.handleRequest(req, res);
  }).listen(port, () => {
    logger.info(`needle-mcp listening on http://127.0.0.1:${port}/`);
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      [
        "needle-mcp — credential-free MCP server for RCA investigation",
        "",
        "Usage: needle-mcp [--http [port]] [--help]",
        "",
        "  (no args)      Serve over stdio (the default; how MCP hosts launch it).",
        "  --http [port]  Serve over streamable HTTP instead. Default port 8000.",
        "  --help, -h     Show this message.",
        "",
        "Config is read at call time from NEEDLE_MCP_CONFIG_DIR, then",
        "CLAUDE_PROJECT_DIR, then the working directory.",
        "",
      ].join("\n"),
    );
    return;
  }

  if (argv[0] === "--http") {
    const port = Number(argv[1] ?? 8000);
    logger.info("Starting needle-mcp MCP server (transport=streamable-http)");
    await runHttp(Number.isFinite(port) ? port : 8000);
    return;
  }

  logger.info("Starting needle-mcp MCP server (transport=stdio)");
  await createServer().connect(new StdioServerTransport());
}

/**
 * True when this module is the process entry point, false when it is imported.
 *
 * Compares REAL paths, not raw strings. `import.meta.url` is already
 * symlink-resolved while `process.argv[1]` is not, so on any system where the
 * install path crosses a symlink (macOS /tmp -> /private/tmp, npm's
 * node_modules/.bin shims, nvm prefixes) a naive string comparison never
 * matches and the binary exits 0 having done nothing at all. Path escaping
 * (spaces become %20 in a URL) breaks the same comparison a second way.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

// Only auto-start when executed as a binary, never when imported by a test or
// by the Stop hook — importing this module must not seize stdio.
if (isMainModule()) {
  main().catch((error: unknown) => {
    logger.error(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
