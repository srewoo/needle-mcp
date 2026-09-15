/**
 * End-to-end check on the Claude Code plugin manifest's Stop hook.
 *
 * This is the project's only non-optional enforcement gate, and it is declared
 * in data (JSON), not code — so nothing else in the test suite exercises it.
 * Two independent defects have shipped here before: a hook block nested under
 * the wrong key (silently ignored at runtime) and a command invoking an
 * interpreter too old to load the package. Both are invisible to every other
 * test, and both are caught by actually extracting the declared command and
 * running it.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLUGIN_JSON = join(REPO_ROOT, ".claude-plugin", "plugin.json");

const manifest = (): any => JSON.parse(readFileSync(PLUGIN_JSON, "utf-8"));

/**
 * Resolve plugin.json's `hooks` value to the hook config document. The
 * canonical form is a path to a separate file, relative to the plugin root. An
 * inline object is NOT the canonical form and is rejected here.
 */
function hookConfig(): any {
  const hooksRef = manifest().hooks;
  expect(typeof hooksRef, "plugin.json 'hooks' must be a path to a hook config file").toBe("string");
  const hooksPath = resolve(REPO_ROOT, hooksRef.replace(/^\.\//, ""));
  expect(existsSync(hooksPath), `hook config file ${hooksPath} does not exist`).toBe(true);
  return JSON.parse(readFileSync(hooksPath, "utf-8"));
}

function stopHookCommands(): string[] {
  const stopMatchers = hookConfig().hooks?.Stop;
  expect(stopMatchers, "no Stop hook declared in the hook config file").toBeTruthy();
  const commands: string[] = [];
  for (const matcher of stopMatchers) {
    for (const hook of matcher.hooks ?? []) {
      expect(hook.type).toBe("command");
      commands.push(hook.command);
    }
  }
  return commands;
}

const resolvedCommand = () =>
  stopHookCommands()[0]!.replaceAll("${CLAUDE_PLUGIN_ROOT}", REPO_ROOT);

describe("plugin manifest", () => {
  it("declares an author", () => {
    expect(manifest().author).toBeTruthy();
  });

  it("points its MCP server at the built entry point", () => {
    const entry = manifest().mcpServers["needle-mcp"];
    expect(entry.command).toBe("node");
    const built = entry.args[0].replaceAll("${CLAUDE_PLUGIN_ROOT}", REPO_ROOT);
    expect(existsSync(built), `${built} does not exist — run npm run build`).toBe(true);
  });

  it("uses the canonical hook config shape", () => {
    const config = hookConfig();
    expect(Object.keys(config)).toEqual(["hooks"]);
    // 'hooks.hooks' is not a hook event name — Claude Code ignores it at runtime.
    expect(config.hooks).not.toHaveProperty("hooks");
    expect(config.hooks).toHaveProperty("Stop");
  });

  it("declares exactly one Stop hook command", () => {
    const commands = stopHookCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(commands[0]).toContain("stop-validate.mjs");
  });
});

describe("the declared command actually runs", () => {
  for (const payload of ["{}", '{"last_assistant_message": "no envelope here"}']) {
    it(`exits clean and stays off stdout for payload ${payload}`, () => {
      // Execute the manifest's own command string, exactly as Claude Code would.
      const stdout = execSync(resolvedCommand(), {
        input: payload,
        encoding: "utf-8",
        timeout: 180_000,
      });
      expect(stdout, "hook wrote to the decision channel unexpectedly").toBe("");
    });
  }

  it("blocks a narration-only envelope", () => {
    // The whole point of the gate.
    const message =
      "Here is my RCA.\nBEGIN_NEEDLE_MCP_RESULT_JSON\n" +
      JSON.stringify({
        confidence: "partial_evidence",
        status: "partial",
        root_cause: "checkout was probably overloaded",
        affected_services: ["checkout"],
        environment: "prod",
      }) +
      "\nEND_NEEDLE_MCP_RESULT_JSON\n";
    const stdout = execSync(resolvedCommand(), {
      input: JSON.stringify({ last_assistant_message: message }),
      encoding: "utf-8",
      timeout: 180_000,
    });
    expect(JSON.parse(stdout).decision).toBe("block");
  });
});
