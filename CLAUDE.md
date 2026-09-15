# CLAUDE.md — working on needle-mcp

Orientation for an agent modifying this codebase. `README.md` covers using it;
`skills/rca-methodology/SKILL.md` is the methodology a host Claude follows when
investigating. This file is about not breaking things.

## What this is in one paragraph

needle-mcp is a **stateless MCP server with no LLM loop and no credentials of its
own**. The host Claude session does all reasoning. It deliberately does *not*
reimplement vendor integrations — if the user has a Datadog/Splunk/GitLab MCP
connected, the host calls that directly with its own credentials. needle-mcp
supplies only what isn't otherwise covered: investigation methodology, identifier
correlation, HAR parsing, a config-templated fallback HTTP client, and a
deterministic RCA linter. Its output ceiling is therefore set by which vendor
MCPs the user has connected — that is a design property, not a defect.

## Layout

```
src/
  index.ts       Binary entry: arg parsing, stdio/HTTP transport. Exports the public API.
  server.ts      MCP wiring: 7 tools + 1 prompt + 1 resource. Wrappers only.
  models.ts      Shared zod schemas. A contract — renaming a field breaks callers.
  config.ts      adapters.yaml / topology.yaml loading. Re-reads from disk per call.
  paths.ts       Config-dir resolution. Call time, never module load.
  security.ts    Redaction + host allowlisting. Security floor lives here.
  http.ts        fetch with manual, host-pinned redirect handling.
  bounding.ts    Response truncation.
  format.ts      Python-style `{name}` template substitution (adapters.yaml compat).
  pyrepr.ts      Python-style repr for gap detail strings.
  instructions.ts  Server INSTRUCTIONS + the result sentinels.
  methodology.ts   SKILL.md lookup for the MCP prompt/resource.
  logger.ts      stderr-only logging. Never write to stdout.
  tools/         One pure, independently-tested function per tool. All real logic.
skills/rca-methodology/SKILL.md   The product's actual differentiator.
hooks/stop-validate.mjs + hooks/hooks.json + .claude-plugin/plugin.json
                                  Claude Code enforcement path.
```

Business logic lives in `tools/`. `server.ts` wrappers call a pure function and
serialize the result — nothing else. Logic in a wrapper is untested by
construction, because the tool test suites call the pure functions directly.

The repo was ported from Python; `pyrepr.ts` and `format.ts` exist to keep
operator-facing strings and user-authored `adapters.yaml` templates working
unchanged. They are compatibility shims, not general utilities.

## Invariants — most of these have already broken once

**stdout is the JSON-RPC channel.** In Node, `console.log` writes to stdout, so a
single stray call corrupts the protocol and kills the server with an opaque
error. Use `logger` from `src/logger.ts`, which writes to stderr. Nothing in
`src/` may call `console.log`.

**The result sentinels must match byte-for-byte in three places:**
`skills/rca-methodology/SKILL.md` (what the host is told to emit),
`hooks/stop-validate.mjs` (what the hook greps for), and `src/instructions.ts`.
If they drift, the hook silently never matches a real turn and enforcement is
dead with no error anywhere. `test/sentinels.test.ts` pins this;
`grep -rn "NEEDLE_MCP_RESULT_JSON" skills/ hooks/ src/` should return all three.

**The envelope documented in SKILL.md must cover every field `validateRca`
reads.** Two predicates key off `alert_metric` and `monitored_resource.unresolved`.
These were once absent from the documented envelope, which made those checks
permanently unreachable — the enforcement looked complete and silently wasn't.
Adding a predicate means documenting its field, and `test/sentinels.test.ts`
enforces that.

**Gap `name` strings are a contract** shared with the Stop hook and the docs.
Add new names freely; never rename or respell an existing one.

**`validateRca` must never throw.** The Stop hook feeds it `JSON.parse` output
from whatever a model emitted between the sentinels — missing keys, wrong types,
nulls. It has per-field coercion *and* a top-level backstop. A throw here crashes
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
`safeEncodeParam` also escapes `!'()*`, which `encodeURIComponent` leaves alone —
without that it would be laxer than the Python original it replaced.

**The `..` path-segment check reads the RAW url string, not a parsed `URL`.**
`new URL()` *resolves* dot segments during parsing, so `/api/../admin/q` becomes
`/admin/q` before any check can see it — inspecting `url.pathname` would always
pass while the request still went to the escaped path. Python's `urlparse`
preserved the segments, so the original could check the parsed path; this cannot.

**An opaque-token value class must include `_`.** `OPAQUE_TOKEN` in
`correlateIds.ts` backs the six generic key patterns. It once omitted the
underscore, so `request_id=req_7f3a9c` captured only `req` — below the `{6,}`
floor — and the identifier was dropped with no error and no candidate.
`req_`/`msg_`/`job_`/`sess_` prefixes are among the commonest conventions in the
wild, so the pattern missed exactly the ids most worth correlating, and the
empty result read as "these logs share nothing". The fixed-format patterns
(`traceparent`, `x-datadog-trace-id`, `span_id`, `x-amzn-trace-id`) keep their
narrow classes on purpose — those formats cannot contain an underscore, and
widening them would only cost precision. Widening the class also made
underscored placeholders (`not_available`, `not_set`) reachable, so they are now
explicit DENYLIST entries rather than being excluded by accident of length.

**Identifier conversion uses `BigInt`, never `Number`.** A Datadog decimal trace
id such as `9925525482204591653` exceeds `Number.MAX_SAFE_INTEGER`; parsed as a
double it rounds silently and the hex form matches nothing in any vendor's index.
The failure mode is an empty search result, not an error.

**Redirects are followed manually and pinned to the adapter's own host.**
`fetch(..., { redirect: "manual" })` in `http.ts` validates each hop's target
*before* contacting it. Letting the runtime follow redirects and checking the
final URL afterwards is too late — the credentialed request has already been
sent. The redirect allowlist is scoped to the single adapter being queried, not
the union of every configured adapter's host, so adapter A's `Authorization`
header can never reach adapter B.

**Redaction is allowlist, never denylist**, and `Authorization`/`Cookie`/
`Set-Cookie` are dropped even when a caller explicitly allowlists them. Request
and response bodies are never returned by any tool.

**Config resolves `NEEDLE_MCP_CONFIG_DIR` → `CLAUDE_PROJECT_DIR` → cwd, at call
time.** An MCP server launched by a desktop host inherits an unpredictable working
directory, so cwd-relative config silently never resolves. Module-load resolution
also makes it untestable.

## Testing

```bash
npm test          # full suite, vitest
npm run typecheck # tsc --noEmit, strict
```

Node **18.17+** required.

**Unit tests call the pure functions directly**, so they cannot see wire-level
behaviour. A host may deliver a JSON-text argument already parsed into an object,
which once made a string-typed parameter unusable over the wire while every unit
test passed. Any parameter whose payload is JSON text needs a test through an
actual `client.callTool`, not just the pure function — see the wire-level block in
`test/server.test.ts`.

`test/pluginManifest.test.ts` parses `plugin.json`, extracts the declared hook
command and **executes it**. It exists because the manifest was once both
malformed and pointing at the wrong interpreter while the whole suite passed green
— nothing bound the manifest to the hook's real dependencies. It requires
`npm run build` to have run, since the manifest points at `dist/`. Keep it.

Avoid tests that pass regardless of the implementation. Several were removed
during the build for asserting things that were true of any input.

## Committing

This repo has a pre-commit hook that blocks commits without an interactive TTY.
Use `CLAUDE_SKIP_HOOKS=1 git commit -m "..."`. Do not use `--no-verify` and do not
modify or remove the hook.

## Behavioural changes from the Python original

The port is otherwise output-identical (verified by a differential harness over
8 identifiers, 5 correlation sets and 7 RCA envelopes). One deliberate exception:

- **`correlate_ids` now finds underscored identifiers.** See the `OPAQUE_TOKEN`
  invariant above. On the differential corpus this recovers `request_id`,
  `message_id` and `job_id` from a snippet set where the Python implementation
  returned only `trace_id`. `plan_investigation` and `validate_rca` output is
  unchanged in every case.
- **`redactUrl` drops `user:pass@` userinfo.** The Python version rebuilt from
  `urlparse().netloc`, which preserved embedded credentials — a redaction helper
  that echoes credentials is not redacting.
- **`redactUrl` no longer emits `"://"` for an empty or unparseable URL.** A HAR
  entry with no request URL produced the literal string `"://"`; it now returns
  `""` and an unparseable URL comes back verbatim minus its query string.

Cosmetic, non-functional differences, recorded so a future differential run is
not mistaken for a regression:

- `redactUrl` keeps a bare host's trailing slash (`https://x.com/`), because
  `URL.pathname` is `"/"` where `urlparse().path` was `""`. Also visible in the
  `assertUrlStructureUnchanged` error text.
- Durations serialize as `1500` rather than `1500.0`; JS has no float/int
  distinction. Numerically equal.
- `boundJson` uses compact JSON separators — see Known sharp edges.

## Known sharp edges

- The plugin path (`claude plugin install`) needs a built `dist/`. `plugin.json`
  points at `dist/index.js`, and `hooks/stop-validate.mjs` imports
  `dist/tools/validateRca.js`. Installing the plugin from a fresh clone without
  `npm run build` yields a server that will not start and a hook that fails open
  — i.e. enforcement silently off.
- `bounding.ts` is described as shared but only `queryGenericSource` uses it;
  other tools return unbounded lists.
- `boundJson` serializes with `JSON.stringify`, whose compact separators differ
  from Python's `json.dumps` defaults. The same payload is a few percent shorter,
  so slightly more rows survive the same `maxChars`. Deliberate; only the exact
  row count at the boundary differs.
- `queryGenericSource` supports static-header and HTTP-basic auth only. For
  OAuth, write a thin dedicated MCP server instead.
- Enforcement is non-optional only on Claude Code (the plugin's Stop hook). On
  Claude Desktop and claude.ai, `validate_rca` is a tool the session may decline
  to call. Documented as reduced-assurance, not parity.
