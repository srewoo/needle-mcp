import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

export const METHODOLOGY_URI = "needle-mcp://skills/rca-methodology";

/**
 * Spec §3: on every host except Claude Code the methodology can only reach the
 * session as an MCP prompt/resource — a plain MCP server cannot drop a file into
 * a host's skill-loading path, and `instructions` alone carries neither the
 * envelope schema nor the five rules. Prompt and resource read the SAME file, so
 * there is exactly one source of truth.
 *
 * Path resolution deliberately avoids process.cwd(): an MCP server launched as a
 * subprocess inherits an unpredictable working directory (often "/"). The
 * candidates cover the published package (skills/ sits beside dist/, per the
 * package.json `files` allowlist) and a source checkout run under a test runner.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_RELATIVE = join("skills", "rca-methodology", "SKILL.md");

export const METHODOLOGY_CANDIDATES = [
  join(HERE, SKILL_RELATIVE),
  join(HERE, "..", SKILL_RELATIVE),
  join(HERE, "..", "..", SKILL_RELATIVE),
];

const METHODOLOGY_MISSING =
  "The rca-methodology skill file could not be located in this installation. " +
  "Read it from the project's skills/rca-methodology/SKILL.md. Note that the " +
  "RCA result envelope must be emitted fenced between " +
  "BEGIN_NEEDLE_MCP_RESULT_JSON and END_NEEDLE_MCP_RESULT_JSON.";

/**
 * Read the methodology skill. Never throws: a missing or unreadable file
 * degrades to a short fallback rather than taking the server down, since this is
 * read during prompt/resource access on every host that connects.
 */
export function methodologyText(candidates: readonly string[] = METHODOLOGY_CANDIDATES): string {
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf-8");
    } catch {
      continue;
    }
  }
  logger.warn(`rca-methodology SKILL.md not found in any of ${JSON.stringify(candidates)}`);
  return METHODOLOGY_MISSING;
}
