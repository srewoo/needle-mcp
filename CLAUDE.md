# CLAUDE.md — working on rcAnalyst

Orientation for an agent modifying this codebase. `README.md` covers using it;
`skills/rca-methodology/SKILL.md` is the methodology a host Claude follows when
investigating. This file is about not breaking things.

## What this is in one paragraph

rcAnalyst is a **stateless MCP server with no LLM loop and no credentials of its
own**. The host Claude session does all reasoning. It deliberately does *not*
reimplement vendor integrations — if the user has a Datadog/Splunk/GitLab MCP
connected, the host calls that directly with its own credentials. rcAnalyst
supplies only what isn't otherwise covered: investigation methodology, identifier
correlation, HAR parsing, a config-templated fallback HTTP client, and a
deterministic RCA linter. Its output ceiling is therefore set by which vendor
MCPs the user has connected — that is a design property, not a defect.

## Layout

```
src/rcanalyst/
  server.py      MCP wiring: 7 tools + 1 prompt + 1 resource. Wrappers only.
  models.py      Shared pydantic types. A contract — renaming a field breaks callers.
  config.py      adapters.yaml / topology.yaml loading. Re-reads from disk per call.
  security.py    Redaction + host allowlisting. Security floor lives here.
  bounding.py    Response truncation.
  tools/         One pure, independently-tested function per tool. All real logic.
skills/rca-methodology/SKILL.md   The product's actual differentiator.
hooks/stop_validate.py + hooks/hooks.json + .claude-plugin/plugin.json
                                  Claude Code enforcement path.
```

Business logic lives in `tools/`. `server.py` wrappers call a pure function and
return `.model_dump()` — nothing else. Logic in a wrapper is untested by
construction, because the tool test suites call the pure functions directly.

## Invariants — each of these has already broken once

**`mcp>=1.9.0,<2` is load-bearing.** mcp 2.x deleted `mcp.server.fastmcp`
(FastMCP was renamed `MCPServer`). An unpinned install breaks every import in the
project. Porting is a tracked follow-up; do not "modernise" the import.

**stdout is the JSON-RPC channel.** A single stray `print()` — or a library that
writes to stdout — corrupts the protocol and kills the server with an opaque
error. `logging.basicConfig(stream=sys.stderr, ...)` must stay *before* the MCP
import in `server.py`. Diagnostics go to stderr, always.

**The result sentinels must match byte-for-byte in three places:**
`skills/rca-methodology/SKILL.md` (what the host is told to emit),
`hooks/stop_validate.py` (what the hook greps for), and `server.py`'s
`INSTRUCTIONS`. If they drift, the hook silently never matches a real turn and
enforcement is dead with no error anywhere. `grep -rn "RCANALYST_RESULT_JSON"
skills/ hooks/ src/` should return all three.

**The envelope documented in SKILL.md must cover every field `validate_rca`
reads.** Two predicates key off `alert_metric` and `monitored_resource.unresolved`.
These were once absent from the documented envelope, which made those checks
permanently unreachable — the enforcement looked complete and silently wasn't.
Adding a predicate means documenting its field.

**Gap `name` strings are a contract** shared with the Stop hook and the docs.
Add new names freely; never rename or respell an existing one.

**`validate_rca` must never raise.** The Stop hook feeds it `json.loads()` output
from whatever a model emitted between the sentinels — missing keys, wrong types,
nulls. It has per-field coercion *and* a top-level backstop. A raise here crashes
the enforcement gate.

**The Stop hook fails OPEN, deliberately.** On an unexpected exception it allows
the turn. A fail-closed hook would wedge the user's session with no way forward,
which is worse than briefly losing enforcement. The `stop_hook_active` guard must
stay the first statement inside the try — without it, a blocking verdict
re-triggers the hook forever.

**Everything substituted into a query template is percent-encoded**, including
`start`/`end`. Those arrive as model-supplied tool arguments and are exactly as
untrusted as `params`. They were once interpolated raw, which allowed injecting an
arbitrary query parameter into a credentialed request to an internal host.

**Redaction is allowlist, never denylist**, and `Authorization`/`Cookie`/
`Set-Cookie` are dropped even when a caller explicitly allowlists them. Request
and response bodies are never returned by any tool.

**Config resolves `RCANALYST_CONFIG_DIR` → `CLAUDE_PROJECT_DIR` → cwd, at call
time.** An MCP server launched by a desktop host inherits an unpredictable working
directory, so cwd-relative config silently never resolves. Import-time resolution
also makes it untestable.

## Testing

```bash
.venv311/bin/pytest -q          # full suite
```

Python **3.11+** required; the system `python3` on this machine is 3.9. Use
`.venv311/`.

**Unit tests bypass FastMCP's argument coercion.** They call the pure functions
directly, so they cannot see wire-level behaviour. FastMCP pre-parses
JSON-looking *string* arguments, which once made a `str`-typed parameter
unusable over the wire while every unit test passed. Any parameter whose payload
is JSON text needs a test through `mcp.call_tool`, not just the pure function.

`tests/test_plugin_manifest.py` parses `plugin.json`, extracts the declared hook
command and **executes it**. It exists because the manifest was once both
malformed and pointing at the wrong interpreter while 136 tests passed green —
nothing bound the manifest to the hook's real dependencies. Keep it.

Avoid tests that pass regardless of the implementation. Several were removed
during the build for asserting things that were true of any input.

## Committing

This repo has a pre-commit hook that blocks commits without an interactive TTY.
Use `CLAUDE_SKIP_HOOKS=1 git commit -m "..."`. Do not use `--no-verify` and do not
modify or remove the hook.

## Known sharp edges

- A non-editable install ships a copy of `SKILL.md` inside the wheel, and
  `server.py` prefers the package-relative path. Editing the checkout's copy
  without rebuilding serves stale methodology.
- `bounding.py` is described as shared but only `query_generic_source` uses it;
  other tools return unbounded lists.
- `query_generic_source` supports static-header and HTTP-basic auth only. For
  OAuth, write a thin dedicated MCP server instead.
- Enforcement is non-optional only on Claude Code (the plugin's Stop hook). On
  Claude Desktop and claude.ai, `validate_rca` is a tool the session may decline
  to call. Documented as reduced-assurance, not parity.
