"""End-to-end check on the Claude Code plugin manifest's Stop hook.

This is the project's only non-optional enforcement gate, and it is declared in
data (JSON), not code — so nothing else in the test suite exercises it. Two
independent defects have shipped here before: a hook block nested under the
wrong key (silently ignored at runtime) and a command invoking a `python3` too
old to import the package. Both are invisible to every other test, and both are
caught by actually extracting the declared command and running it.
"""
from __future__ import annotations
import json
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
PLUGIN_JSON = REPO_ROOT / ".claude-plugin" / "plugin.json"


def _manifest() -> dict:
    return json.loads(PLUGIN_JSON.read_text())


def _hook_config() -> dict:
    """Resolve plugin.json's `hooks` value to the hook config document.

    The canonical form is a path to a separate file, relative to the plugin
    root. An inline object is NOT the canonical form and is rejected here.
    """
    hooks_ref = _manifest().get("hooks")
    assert isinstance(hooks_ref, str), (
        "plugin.json 'hooks' must be a path to a hook config file (e.g. "
        f"'./hooks/hooks.json'), got {type(hooks_ref).__name__}"
    )
    hooks_path = (PLUGIN_JSON.parent.parent / hooks_ref.lstrip("./")).resolve()
    assert hooks_path.is_file(), f"hook config file {hooks_path} does not exist"
    return json.loads(hooks_path.read_text())


def _stop_hook_commands() -> list[str]:
    config = _hook_config()
    stop_matchers = config.get("hooks", {}).get("Stop")
    assert stop_matchers, "no Stop hook declared in the hook config file"
    commands: list[str] = []
    for matcher in stop_matchers:
        for hook in matcher.get("hooks", []):
            assert hook.get("type") == "command"
            commands.append(hook["command"])
    return commands


def test_plugin_declares_author():
    assert _manifest().get("author"), "plugin.json must declare an author"


def test_hook_config_uses_canonical_shape():
    config = _hook_config()
    assert set(config) == {"hooks"}, f"hook config top level must be exactly 'hooks', got {sorted(config)}"
    assert "hooks" not in config["hooks"], (
        "'hooks.hooks' is not a hook event name — Claude Code ignores it at runtime"
    )
    assert "Stop" in config["hooks"]


def test_stop_hook_command_declared():
    commands = _stop_hook_commands()
    assert len(commands) == 1
    assert "${CLAUDE_PLUGIN_ROOT}" in commands[0]
    assert "stop_validate.py" in commands[0]


@pytest.mark.parametrize("payload", ['{}', '{"last_assistant_message": "no envelope here"}'])
def test_declared_stop_hook_command_actually_runs(payload: str):
    """Execute the manifest's own command string, exactly as Claude Code would.

    The interpreter named in the manifest must be able to import the package
    (which needs Python >= 3.11); a non-RCA payload must exit 0 and print
    nothing, since stdout is the decision channel.
    """
    command = _stop_hook_commands()[0].replace("${CLAUDE_PLUGIN_ROOT}", str(REPO_ROOT))
    proc = subprocess.run(
        command, shell=True, input=payload, capture_output=True, text=True, timeout=180,
    )
    assert proc.returncode == 0, (
        f"hook command exited {proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr}"
    )
    assert proc.stdout == "", f"hook wrote to the decision channel unexpectedly: {proc.stdout!r}"
    assert "Traceback" not in proc.stderr, proc.stderr


def test_declared_stop_hook_command_blocks_a_bad_envelope():
    """The whole point of the gate: a narration-only envelope must be blocked."""
    command = _stop_hook_commands()[0].replace("${CLAUDE_PLUGIN_ROOT}", str(REPO_ROOT))
    message = (
        "Here is my RCA.\nBEGIN_RCANALYST_RESULT_JSON\n"
        + json.dumps({
            "confidence": "partial_evidence", "status": "resolved",
            "root_cause": "something broke", "affected_services": ["checkout"],
        })
        + "\nEND_RCANALYST_RESULT_JSON\n"
    )
    proc = subprocess.run(
        command, shell=True, input=json.dumps({"last_assistant_message": message}),
        capture_output=True, text=True, timeout=180,
    )
    assert proc.returncode == 0, proc.stderr
    decision = json.loads(proc.stdout)
    assert decision["decision"] == "block"
