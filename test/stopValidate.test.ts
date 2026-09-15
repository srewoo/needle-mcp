import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");
const HOOK_PATH = join(REPO_ROOT, "hooks", "stop-validate.mjs");
const tmp = () => mkdtempSync(join(tmpdir(), "needle-hook-"));

const VALID_ENVELOPE = {
  confidence: "strong_evidence",
  status: "success",
  root_cause: "db timeout",
  affected_services: ["svc"],
  environment: "prod",
  alert_window: { start: "2026-09-15T10:00:00Z", end: "2026-09-15T10:10:00Z" },
  evidence: [
    {
      timestamp: "2026-09-15T10:05:00Z",
      text: "conn pool exhausted",
      source_ref: "svc/db.go:1",
      environment: "prod",
    },
    {
      timestamp: "2026-09-15T10:05:01Z",
      text: "500 to caller",
      source_ref: "svc/handler.go:2",
      environment: "prod",
    },
  ],
  hop_trace: { hop_count: 1, stop_reason: "terminal" },
};

function runHookRaw(input: string): { stdout: string; stderr: string } {
  let stderr = "";
  const stdout = execFileSync("node", [HOOK_PATH], {
    input,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout, stderr };
}

function runHook(payload: Record<string, unknown>): Record<string, unknown> {
  const { stdout } = runHookRaw(JSON.stringify(payload));
  return stdout.trim() ? JSON.parse(stdout) : {};
}

const fenced = (envelopeText: string) =>
  `## RCA\nsome prose\nBEGIN_NEEDLE_MCP_RESULT_JSON\n${envelopeText}\nEND_NEEDLE_MCP_RESULT_JSON`;

describe("stop-validate hook", () => {
  it("does not block a turn with no envelope", () => {
    expect(runHook({ last_assistant_message: "Just a normal reply with no RCA in it." })).toEqual({});
  });

  it("does not block a valid envelope", () => {
    expect(runHook({ last_assistant_message: fenced(JSON.stringify(VALID_ENVELOPE)) })).toEqual({});
  });

  it("blocks an invalid envelope", () => {
    const bad = {
      confidence: "strong_evidence",
      status: "success",
      root_cause: "x",
      affected_services: ["svc"],
      environment: "prod",
    };
    const out = runHook({ last_assistant_message: fenced(JSON.stringify(bad)) });
    expect(out.decision).toBe("block");
    expect(out).toHaveProperty("reason");
  });

  it("blocks a malformed-JSON envelope", () => {
    expect(runHook({ last_assistant_message: fenced("{not valid json") }).decision).toBe("block");
  });

  it("short-circuits on stop_hook_active", () => {
    // Without this guard a blocking hook re-fires forever. The guard must stay
    // the first statement inside the try.
    const out = runHook({
      last_assistant_message: fenced(JSON.stringify({ confidence: "strong_evidence" })),
      stop_hook_active: true,
    });
    expect(out).toEqual({});
  });

  it("falls back to the transcript when last_assistant_message is absent", () => {
    const p = join(tmp(), "transcript.jsonl");
    writeFileSync(
      p,
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: fenced(JSON.stringify(VALID_ENVELOPE)) }] },
      })}\n`,
    );
    expect(runHook({ transcript_path: p })).toEqual({});
  });

  it("does not block with no input at all", () => {
    expect(runHook({})).toEqual({});
  });

  it("fails OPEN on malformed non-empty stdin", () => {
    // Must not throw past the top-level guard: exit 0 and print nothing on
    // stdout (the decision channel), never crash or block.
    const { stdout } = runHookRaw("not json at all");
    expect(stdout.trim()).toBe("");
  });
});
