#!/usr/bin/env node
/**
 * Claude Code Stop hook: validates the just-finished turn's RCA envelope
 * against needle-mcp's validateRca gates before allowing the session to stop.
 *
 * Input: JSON on stdin per Claude Code's Stop hook contract. Prefers
 * `last_assistant_message`; falls back to walking `transcript_path` (that file
 * is written asynchronously and can lag the current turn, so it is the
 * fallback, not the primary source).
 * Output: on a blocking gap, prints {"decision": "block", "reason": "..."} to
 * stdout. If no RCA envelope is present in the last assistant turn at all, this
 * hook does not block — an ordinary non-RCA turn is not forced to emit one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Match the fenced block first, then parse what's inside it. A single regex
// that also had to match balanced JSON would silently fail to match malformed
// JSON — which is exactly the case that most needs to be reported.
const BLOCK_PATTERN = /BEGIN_NEEDLE_MCP_RESULT_JSON([\s\S]*?)END_NEEDLE_MCP_RESULT_JSON/;

function readStdin() {
  try {
    return readFileSync(0, "utf-8") || "{}";
  } catch {
    return "{}";
  }
}

function lastAssistantText(transcriptPath) {
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf-8").split("\n");
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry?.type === "assistant") {
      const content = entry?.message?.content ?? [];
      const texts = content.filter((c) => c?.type === "text").map((c) => c.text ?? "");
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return null;
}

async function main() {
  // This hook is the project's only non-optional enforcement gate. An uncaught
  // exception anywhere below must not propagate: if it did, Claude Code would
  // see a non-zero exit / no decision on a turn we can't finish validating, and
  // a bug here would then behave like a gate that blocks indefinitely with no
  // way for the user to proceed. We deliberately fail OPEN (return silently,
  // allowing the turn to stop) rather than fail closed — losing enforcement for
  // one turn is recoverable; a hook that wedges every Stop is not. Nothing is
  // printed to stdout on this path: stdout is the decision channel, and stray
  // output there would be parsed as a malformed decision.
  try {
    const payload = JSON.parse(readStdin());

    // Without this guard, a blocking verdict re-triggers this hook forever.
    // It must stay the first statement inside the try.
    if (payload.stop_hook_active) return;

    let text = payload.last_assistant_message;
    if (!text) {
      const transcriptPath = payload.transcript_path;
      text = transcriptPath ? lastAssistantText(transcriptPath) : null;
    }
    if (!text) return;

    const match = BLOCK_PATTERN.exec(text);
    if (!match) return;

    let claimJson;
    try {
      claimJson = JSON.parse(match[1].trim());
    } catch {
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason: "RCA result block is present but is not valid JSON. Fix and re-emit it.",
        }),
      );
      return;
    }

    const { validateRca } = await import(join(HERE, "..", "dist", "tools", "validateRca.js"));
    const result = validateRca(claimJson, []);
    if (!result.approved) {
      const reasons = result.gaps
        .filter((g) => g.severity === "blocking")
        .map((g) => `[${g.name}] ${g.detail}`)
        .join("; ");
      process.stdout.write(
        JSON.stringify({ decision: "block", reason: `validate_rca rejected this RCA: ${reasons}` }),
      );
    }
  } catch (error) {
    process.stderr.write(`stop-validate.mjs: unexpected error, failing open: ${error}\n`);
  }
}

await main();
