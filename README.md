# needle-mcp

A generic, credential-free MCP server that gives any Claude session
(Claude Code, Claude Desktop, claude.ai) RCA-investigation building blocks —
plus a ported, vendor-agnostic investigation methodology. It runs no LLM loop
of its own and holds no Anthropic API key: the host Claude session you
already have open does all the reasoning, using its own credentials for
whatever vendor MCPs (Datadog, Splunk, GitLab, Sourcegraph, PagerDuty, ...)
you already have connected.

## What it is NOT

- Not a Datadog/Splunk/GitLab client — it never talks to those vendors
  directly. If you have a vendor MCP connected, your host Claude uses that,
  with your own credentials for it.
- Not a server-side agent — no orchestration loop, no Anthropic API key, no
  server cost.
- Not stateful — no query history, no cache, no session store. Every tool
  call is independent.

## Install

Published to npm, so no checkout is needed:

```bash
npx needle-mcp --help
```

Requires Node.js 18.17 or newer. There are no runtime credentials to configure —
needle-mcp has none of its own.

### Claude Code (recommended — gets enforcement)

```bash
claude mcp add needle-mcp -- npx -y needle-mcp
```

That registers the 7 tools. For the full experience, install it as a plugin
instead — this additionally bundles the rca-methodology skill and a `Stop` hook
that validates any RCA envelope your session claims to have produced, before the
turn can end:

```bash
git clone <this repo> ~/needle-mcp
cd ~/needle-mcp && npm install && npm run build
claude plugin install ~/needle-mcp
```

The plugin path needs a checkout because the hook and skill are files Claude Code
loads from disk, not things the MCP protocol can deliver.

### Claude Desktop / other MCP hosts

Add to your MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "needle-mcp": {
      "command": "npx",
      "args": ["-y", "needle-mcp"],
      "env": { "NEEDLE_MCP_CONFIG_DIR": "/absolute/path/to/your/config/dir" }
    }
  }
}
```

No plugin mechanism exists on these hosts, so there's no Stop-hook
enforcement — `validate_rca` is a tool your session can call (and the
methodology is delivered via the server's MCP `instructions`/`prompts`), but
following it is best-effort, not guaranteed. This is a known, accepted
tradeoff, not parity with the Claude Code experience.

### claude.ai

Run with the HTTP transport and register it as a remote MCP server:

```bash
npx needle-mcp --http 8000
```

## Developing

```bash
npm install
npm test          # vitest, 207 tests
npm run typecheck # tsc --noEmit, strict
npm run build     # emits dist/
```

## Configure your own sources (optional)

You almost certainly already have MCPs for your vendors — needle-mcp is
designed to compose with those, not replace them. Only fill in
`adapters.yaml` for a backend that genuinely has no MCP (an in-house log API,
for example):

```bash
cp adapters.example.yaml adapters.yaml
cp topology.example.yaml topology.yaml
# edit both — adapters.yaml has 3 working reference configs (Loki, OpenSearch,
# Splunk-style) to copy from; topology.yaml already has vendor-generic
# coverage facts, add your own resource types as needed.
```

Both files are read from `NEEDLE_MCP_CONFIG_DIR` (falling back to
`CLAUDE_PROJECT_DIR`, then the process cwd). Set it explicitly — an MCP server
launched by a desktop host inherits an unpredictable working directory, so
relying on cwd usually means your config is silently never found.

## How you actually use it

**Ask a question.** The common case. You already have your vendor MCPs
connected; needle-mcp supplies the method and the final check.

> "Why is checkout 500ing in prod since 10am?"

Claude establishes the environment and window, queries your own Datadog/Splunk/
Loki tools, applies the five rules from the bundled methodology, and calls
`validate_rca` on its own draft before answering.

**Start from an identifier.** A session id, request id, or trace id and nothing
else.

> "RCA for session sess_abc123XYZ"

Claude calls `plan_investigation`, which classifies the id, lists every vendor
spelling it may appear under, names which sources can answer for it, and sets
the right time window — then fans out across your connected tools.

**Start from a screenshot.** Paste it. Claude reads it directly (it is
multimodal), pulls the failing URL/status/timestamp out of the image, and goes
from there. There is no tool call needed for this and you should not make one.

**Start from a HAR.** Export the browser's Network tab, then:

> "Run analyze_visual_evidence on ~/Downloads/checkout.har"

You get back only the failed and slow requests with their correlation headers,
redacted — the fastest path from "the UI is broken" to a backend trace id.

## 5-minute first run (zero vendor MCPs required)

1. Install needle-mcp as above — no other MCP needed for this walkthrough.
2. Export your browser's Network tab as a HAR for the failing request.
3. Ask Claude: "use analyze_visual_evidence on this HAR to find what failed."
4. Feed the returned correlation headers/request id into `correlate_ids` if you
   have more log snippets to tie together.
5. If you have an in-house log API, add it to `adapters.yaml` and ask Claude to
   `query_generic_source` it with the request id.
6. Ask Claude to write the RCA — it calls `validate_rca` on its own draft and
   emits a fenced `BEGIN_NEEDLE_MCP_RESULT_JSON` envelope before finalizing.

## Tools

| Tool | Purpose |
|---|---|
| `plan_investigation` | Start here from a bare session/request/trace id: classifies it, gives every vendor spelling, names which sources can answer, sets the window |
| `correlate_ids` | Extract & rank correlation IDs across log snippets you've already collected, including async (message/job id) hops |
| `analyze_visual_evidence` | Parse a HAR/network-tab export (redacted). Not needed for screenshots — read those directly |
| `query_generic_source` | Config-templated REST query for a backend with no dedicated MCP — use only as a last resort |
| `list_generic_sources` | List what's declared in `adapters.yaml` |
| `get_coverage` | Look up whether a surface covers/is blind to a resource type, from `topology.yaml` |
| `validate_rca` | Deterministically lint a draft RCA envelope before you post it |

## Known limitations (v1)

- `query_generic_source` supports static-header and HTTP-basic auth only —
  no OAuth client-credentials flows. Write a small dedicated MCP server for
  those instead.
- `analyze_visual_evidence`'s raw-image path can approach the ~1MB
  single-message size ceiling most MCP transports impose, on large
  screenshots.
- `validate_rca`'s `investigation_log` is self-reported by the host, not
  independently observed — a fabricated log cannot be caught here.
- Enforcement is only non-optional on Claude Code (via the plugin's `Stop`
  hook). On Claude Desktop and claude.ai, `validate_rca` is a tool the session
  can decline to call.
- Pinned to `mcp>=1.9.0,<2`: mcp 2.x renamed `FastMCP` to `MCPServer`. Porting
  is tracked as a follow-up.
