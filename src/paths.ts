import { join } from "node:path";

/**
 * Config resolves NEEDLE_MCP_CONFIG_DIR -> CLAUDE_PROJECT_DIR -> cwd, AT CALL
 * TIME.
 *
 * An MCP server launched by a desktop host inherits an unpredictable working
 * directory, so cwd-relative config silently never resolves — NEEDLE_MCP_CONFIG_DIR
 * is the documented knob and CLAUDE_PROJECT_DIR is the sensible default for
 * plugin installs. Resolving at call time rather than module load also keeps it
 * testable: env vars can legitimately differ between calls, and the config
 * loaders already re-read from disk on every call by the same stateless design.
 */
export function configDir(): string {
  return process.env.NEEDLE_MCP_CONFIG_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function adaptersPath(): string {
  return join(configDir(), "adapters.yaml");
}

export function topologyPath(): string {
  return join(configDir(), "topology.yaml");
}
