# rcAnalyst — Design Spec

Status: Approved for implementation planning
Date: 2026-09-15

## 1. Problem & Goal

DebugIQ (at `debugiq-new-feature-active-development`) is a Mindtickle-internal
RCA tool: a FastAPI service running the Claude Agent SDK in-process as a
server-side orchestrator, with its own Anthropic/Bedrock credentials, dispatching
sub-agents against Mindtickle-specific MCP servers (Loki × 4 tracks, Thanos × 4
tracks, CloudWatch × 3 regions, a forked PagerDuty server, an in-process
"spine graph" service-ownership server, an in-process Sourcegraph server).//
Its real differentiator is not the plumbing — it's `DEBUGIQ.md`'s investigation
discipline (the "five rules") plus three code-enforced gates that stop the
agent from skipping that discipline.

**Goal:** build `rcAnalyst`, a generic, company-agnostic RCA tool any team can
drop into their own Claude session, with:
- No server-side Anthropic API key or credentials of any kind.
- No dependency on Mindtickle-specific infra (no spine graph, no hardcoded
  vendor tracks).
- No vendor-specific adapter code (no built-in Datadog/GitLab/Splunk client) —
  it composes with whatever MCP servers the user already has connected.
- The investigation discipline preserved as robustly as an MCP-server-based
  architecture allows.

## 2. Non-Goals (v1)

- No server-side LLM orchestration loop (no Agent SDK, no in-process agent).
- No vendor-specific adapters (Datadog, GitLab, Sourcegraph, PagerDuty, Splunk)
  — these are assumed to exist as sibling MCP servers already connected in the
  host's own session, using the host's own credentials.
- No cross-call persistence, session store, or caching layer — fully stateless.
- No OAuth-flow support in `query_generic_source` — v1 supports static-header
  and HTTP-basic auth only.
- No k8s/infra metrics adapter equivalent to DebugIQ's Thanos server.

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Host Claude session (Claude Code / Claude Desktop /         │
│  claude.ai) — owns ALL reasoning, orchestration, RCA         │
│  methodology, and its own credentials for any sibling MCPs   │
└───────────────────────────┬───────────────────────────────────┘
              │ MCP (stdio, and HTTP/SSE for remote hosts)
┌───────────────────────────▼───────────────────────────────────┐
│  rcAnalyst MCP server (Python, official MCP SDK), stateless   │
│  ├── tools/                                                    │
│  │     plan_investigation.py                                   │
│  │     correlate_ids.py                                        │
│  │     analyze_visual_evidence.py                               │
│  │     query_generic_source.py                                 │
│  │     list_generic_sources.py                                 │
│  │     get_coverage.py                                          │
│  │     validate_rca.py                                          │
│  ├── config.py        loads adapters.yaml + topology.yaml + env│
│  ├── security.py      redaction + host-allowlist helpers       │
│  └── bounding.py       shared truncation/tiered-degradation     │
├─────────────────────────────────────────────────────────────┤
│  skills/rca-methodology/SKILL.md   (also exposed as an MCP    │
│                                      prompt + resource, and    │
│                                      condensed into the        │
│                                      server's `instructions`)  │
│  topology.example.yaml  |  adapters.example.yaml               │
│  .claude-plugin/plugin.json  (Claude Code distribution: bundles│
│    the MCP server + skill + a Stop hook running validate_rca) │
│  hooks/stop_validate.py                                        │
└─────────────────────────────────────────────────────────────┘
```

Distribution has two forms, both built from the same source tree:

1. **Plain MCP server** (`uvx rcanalyst`, stdio transport; HTTP/SSE transport
   for claude.ai and other remote hosts) — usable by any MCP host. Methodology
   reaches the host via MCP `prompts`, `resources`, and the server's
   `initialize` `instructions` field, since a plain MCP server cannot place a
   file into a host's skill-loading path.
2. **Claude Code plugin** (`.claude-plugin/plugin.json`) — additionally
   declares the skill file under Claude Code's own skill mechanism, and a
   `Stop` hook that runs `validate_rca` against the just-finished turn's
   claimed envelope, blocking a narration-only turn from silently standing in
   for a real RCA. This is the only distribution form with non-optional
   enforcement; document it as such.

## 4. Tool Catalog

### `plan_investigation(identifier, environment) -> IdentifierPlan`

The bare-identifier entry point: what to do when a session id, request id, or
trace id *is* the starting point and no logs have been collected yet.
`correlate_ids` cannot serve this case — it requires snippets already in hand.

Classifies the identifier (`uuid` / `w3c_trace` / `datadog_decimal_trace` /
`aws_xray` / `opaque`), returns every spelling it may appear under (reusing
`normalize_identifier`, since Datadog writes a trace id in decimal where W3C
writes hex), names which configured adapters and coverage surfaces can answer
for it, and emits a suggested time window — forward-widened when the identifier
looks async (`msg`, `job`, `task`, `event`, `batch`, `delivery`), because a
lagging consumer's log trails the producer's and a tight window reads as "never
consumed" when the truth is "not consumed yet". Also returns `next_steps` that
push the host to pin the environment before querying.

### `correlate_ids(evidence_snippets: list[str]) -> CorrelationResult`

Local, no vendor call. Extracts correlation identifiers from raw log/text
snippets the host has already collected elsewhere.

- Extraction keys on **field names** first (`x-request-id=`, `trace_id:`,
  `messageId=`, `correlation_id=`, `traceparent:`, `x-datadog-trace-id:`,
  `x-amzn-trace-id:`), not bare ID-shaped regex — a named-key match always
  outranks a shape-only match.
- Normalizes cross-format IDs so the same trace matches across vendors:
  decimal ⇄ hex (64-bit and 128-bit), dash-stripped/lowercased UUIDs,
  zero-padding. Each candidate carries `equivalent_forms: [...]`.
- Denylists non-discriminative values: `0`, `-`, `null`, `unknown`, `N/A`, the
  all-zero UUID.
- Every candidate carries `first_seen_ts`/`last_seen_ts` across the snippets it
  appeared in, and a `suggested_window` — asymmetric and **forward-widened**
  for async-shaped keys (`messageId`, `jobId`, `correlationId`, `offset`,
  `deliveryTag`), e.g. `[first_seen - 5m, first_seen + 60m]`, since a lagging
  consumer's log can trail the producer's by tens of minutes.
- Ranks candidates by (cross-source co-occurrence > named-key match >
  shape/entropy only) and returns a `why_ranked` string per candidate.
- Output shape:
  ```json
  {
    "candidates": [
      {
        "value": "...", "key_name": "x-request-id",
        "equivalent_forms": ["..."], "seen_in_snippets": [0, 2],
        "source_systems": ["datadog_logs"], "first_seen_ts": "...",
        "last_seen_ts": "...", "suggested_window": ["...", "..."],
        "confidence": "high", "why_ranked": "..."
      }
    ]
  }
  ```

### `analyze_visual_evidence(image_base64: str | None, har_json: str | None, context: str) -> VisualEvidenceResult`

Accepts a UI screenshot and/or a pasted HAR/network-tab export.

- `image_base64`: passed through as-is; the host's own multimodal model does
  the visual reasoning. **Known tradeoff, accepted:** this round-trip can
  approach the ~1MB single-message stdio ceiling on large screenshots and adds
  a second copy of the image into context. Document as a soft size limit, not
  solved in v1.
- `har_json`: deterministically parsed. Returns only failed (`status >= 400`)
  and slow (configurable threshold) entries: method, redacted URL, status,
  the entry's wall-clock start (`startedDateTime`, surfaced as `timestamp`) and
  its duration (`time_ms` — a duration, not an anchor; the HAR entry point
  needs the former to declare an `alert_window` that `validate_rca` will then
  check every evidence row against), and any correlation headers present
  (`x-request-id`, `traceparent`, `x-amzn-trace-id`, `x-datadog-trace-id`,
  `x-correlation-id`, `request-id`), plus a count of entries dropped.
- **Redaction is mandatory and on by default** (see §6 Security): header
  **allowlist** (never a denylist), all request/response bodies dropped unless
  `include_bodies=true` is explicitly passed, `Authorization`/`Cookie`/
  `Set-Cookie` never returned regardless of that flag.
- `har_json` accepts a file path for large HARs in addition to inline JSON, to
  avoid inlining a 5–50MB payload as a tool argument.

### `query_generic_source(source: str, params: dict, time_range: TimeRange) -> GenericQueryResult`

Config-templated REST/GraphQL call, driven by `adapters.yaml`, for the one
real composition gap: an in-house log system or a vendor with no available
MCP. Realistic for query-style HTTP APIs with static auth (Loki, Prometheus/
Thanos-shaped, Elasticsearch/OpenSearch `_search`, Grafana, typical in-house
`/api/logs?q=` endpoints).

- v1 auth modes: static header from an env var, HTTP basic. OAuth
  client-credentials flows are explicitly out of scope — the documented answer
  is "write a thin dedicated MCP server instead."
- **Never silently truncates.** Every response carries `truncated: bool`,
  `returned_count: int`, and an opaque `next_cursor` passthrough when the
  backend supports pagination. The bundled skill forbids magnitude
  reconciliation (rule 3) on a `truncated: true` response.
- Response shaping via a `response_path` (JSONPath) and `field_map` in the
  adapter config.
- **Security-hardened by construction** (see §6): the adapter's `base_url`
  host is allowlisted server-side; every `params` substitution is URL-encoded
  and rejected if it would alter scheme, host, or path-prefix; redirects to a
  non-allowlisted host are blocked; hard timeout and response-size cap
  enforced.
- Tool description states its negative condition explicitly: "Use ONLY when no
  vendor MCP covers this source. If a Datadog/Loki/Splunk/etc. MCP is
  connected, use that instead."

### `list_generic_sources() -> list[SourceInfo]`

Lists what's declared in `adapters.yaml` for this deployment (name, what it
covers, auth mode) — no vendor call.

### `get_coverage(resource_type: str) -> CoverageResult`

Local, reads `topology.yaml`. Returns:
```json
{"covering_surfaces": ["cloudwatch"], "blind_surfaces": ["loki"], "unknown_coverage": false}
```
`unknown_coverage: true` when the resource type has no entry — the skill's
rule: **you may not conclude absence when this is true.** Ships with
`topology.example.yaml` pre-populated with vendor-generic facts (Loki blind to
Lambda/MWAA/EC2; CloudWatch Logs blind to k8s; Datadog Logs coverage is
opt-in-per-service so absence is the ordinary case, not a discovery; Datadog
APM is sampled; RUM is a separate product from Logs; metrics backends answer
numbers, never strings) — a team adds its own resource types, it does not
author the file from scratch.

### `validate_rca(claim_json: dict, investigation_log: list[dict]) -> ValidationResult`

Deterministic linter (pure predicates, not an LLM call) run before the host
posts its RCA. Same gap-name vocabulary as DebugIQ's `rca-critic.md` for
comparability. Checks include:

- Envelope present, schema-valid, enum values in range → `format-violation`.
- Every Evidence row's timestamp inside the declared `alert_window` →
  `evidence-outside-alert-window`.
- `confidence: strong_evidence` with a single evidence row → reject,
  `single-symptom-strong-evidence`.
- Cited evidence matches an RPC-boundary error pattern (`Unavailable`,
  `DeadlineExceeded`, `i/o timeout`, `context deadline exceeded`) **and**
  cited location matches a client-adapter path pattern (`external/`,
  `clients/`, `adapters/`, `_client\.`, `Stub\.`) **and** `stop_reason !=
  vendor_boundary` → reject, `forwarded-error-as-terminal`.
- Root cause text matches "cache miss" with no second evidence row → reject,
  `cache-miss-as-rca`.
- `monitored_resource.unresolved == true` with `strong_evidence` → reject,
  `strong-evidence-on-unresolved`.
- `hop_count > 10` → reject.
- A metric-anchored claim with no `decomposed_by` field → reject,
  `alert-metric-not-decomposed`.
- `environment` is null, or evidence rows span more than one environment →
  reject.
- Returns `{approved: bool, gaps: [{name, severity, detail}], required_action}`.

`investigation_log` is passed in by the host (self-reported) rather than
observed independently — document this limitation plainly: a fabricated log
cannot be caught, unlike DebugIQ's independently-observed sub-agent spawns.
Statelessness is preserved; auditability is best-effort.

## 5. Data Flow (example)

Entry points, in order of how common they actually are: (a) a plain-language
question, (b) a bare identifier → `plan_investigation`, (c) a pasted screenshot
→ the host reads it directly, no tool call, (d) a HAR export →
`analyze_visual_evidence`. The worked example below is (c)+(d):

1. User pastes a screenshot + asks "why is checkout failing" in their own
   Claude session.
2. Host reads the rca-methodology skill (via plugin skill load, or MCP
   prompt/resource/instructions). Skill's opening step: state `environment`
   explicitly, or ask the user (one question is allowed — unlike DebugIQ's
   "never ask", a human is present here).
3. Host calls `analyze_visual_evidence` → gets back extracted status
   code/URL/timestamp/request-id (redacted).
4. Host calls its own connected log/APM MCP (e.g. `mcp__datadog__get_logs`)
   filtered by that id/window, scoped to the confirmed environment.
5. If a log line mentions an async hop (Kafka topic/message id), host calls
   `correlate_ids` to pull that id forward with its widened suggested window,
   then re-queries the consuming service's logs via whatever tool covers it.
6. Before concluding an empty result means absence, host calls `get_coverage`
   for the resource type in question.
7. If a stack frame needs confirming as origin-vs-forward, host uses its own
   GitLab/Sourcegraph MCP (or `query_generic_source` as last resort) —
   dispatched only *after* a suspect `file:line` has appeared, never at t=0.
8. Host applies the skill's five rules, writes the RCA, then calls
   `validate_rca` with its draft + claim + self-reported investigation log
   before posting. On Claude Code, the `Stop` hook re-runs this check
   regardless of whether the host remembered to call it.

## 6. Security

- **HAR/screenshot redaction** (`analyze_visual_evidence`): header allowlist
  (never denylist), bodies dropped by default, `Authorization`/`Cookie`/
  `Set-Cookie` never returned even with `include_bodies=true`.
- **`query_generic_source` SSRF/injection hardening**: the allowlist is derived
  from the declared adapters and enforced in code at request time; **every**
  value substituted into the query template is percent-encoded — including the
  `start`/`end` time range, which arrives as model-supplied tool arguments and is
  therefore exactly as untrusted as `params`; the *built* URL is checked by
  `assert_url_structure_unchanged` to still match the adapter's scheme/host/port
  and to contain no `..` path segment; off-allowlist redirects are refused by a
  custom redirect handler **before** the new host is contacted; hard request
  timeout and response size cap apply; and every error is returned as a
  structured `GenericQueryResult`, never raised.

  Two notes recorded during implementation, because the original wording of this
  section was wrong in a way worth remembering. First, `start`/`end` were
  initially interpolated raw while `params` were encoded — with the shipped
  adapter templates placing them in query-string position, a crafted `start`
  could inject an arbitrary extra query parameter into a request carrying the
  adapter's credentials. Second, `assert_url_structure_unchanged`'s base-path
  prefix check is a no-op whenever `base_url` is a bare host (every shipped
  example), because `str.startswith("")` is always true; the `..`-segment check
  above is what makes that function do real work in the common configuration.

  Note what this deliberately does **not** do: it does not reject param *values*
  containing `://` or `..`. Searching logs for a URL is a core RCA query, and an
  encoded value cannot escape its query-string position — so structural safety
  is enforced on the constructed URL, not by banning substrings in user input.
- Both are in scope for v1, not deferred.

## 6a. The envelope contract

The RCA envelope is emitted fenced between the exact sentinels
`BEGIN_RCANALYST_RESULT_JSON` and `END_RCANALYST_RESULT_JSON`. This is a
two-sided contract: the skill instructs the host to emit it, and the Claude Code
`Stop` hook greps for exactly that block to re-run `validate_rca`. If the
sentinel exists on only one side, enforcement is silently dead — the hook never
matches and every turn passes. Any change to the sentinel changes both sides.

## 6b. Dependency pin

`mcp>=1.9.0,<2`. The `<2` bound is load-bearing: `mcp` 2.x removed
`mcp.server.fastmcp` (FastMCP was renamed to `MCPServer`), so an unpinned
install breaks every import in the project. Porting to 2.x is a tracked
follow-up, not v1 scope.

## 7. Skill Content Changes vs. DEBUGIQ.md

- Adds a required `environment` field to the opening context and to the
  result envelope; `get_coverage` and `validate_rca` both key off it.
- **Inverts** "never ask a question" — a human is present in this
  architecture (unlike DebugIQ's unattended Slack/PagerDuty path); one
  clarifying question on ambiguous environment/target is expected, not
  forbidden.
- "Humans outrank logs" degrades gracefully: if no incident-management MCP is
  connected, the skill instructs the host to ask the responder directly what
  is already known before investigating, rather than silently skipping the
  rule.
- "Never make 'onboard this service to X' the finding" is softened: for a
  first-time user with no coverage for a resource type, that observation is
  legitimately useful — allowed as a Recommendation, still barred from the
  TL;DR.
- "Enrichment means after, not alongside" (code-reading only after a suspect
  `file:line` appears) is promoted near the top of the skill, since a host
  session commonly has a code-search MCP connected and ready, making it the
  model's likeliest default instinct to reach for too early.
- States the 10-hop cap and a turn/cost-conscious stop rule explicitly (no
  wall-clock enforcement exists here the way DebugIQ's watchdog provides it,
  so the skill must say it in prose and `validate_rca` checks `hop_count`).
- Every tool description states its negative condition ("use ONLY if no
  vendor MCP covers this source") so the host doesn't reach for
  `query_generic_source` over a correct sibling vendor MCP.

## 8. Testing

- Unit tests per tool: pydantic validation, `correlate_ids` extraction/
  normalization/ranking against a corpus of real-shaped log lines from at
  least 3 differently-formatted sources, `query_generic_source` against a
  mocked HTTP server (including pagination/truncation and allowlist-violation
  rejection), `validate_rca` against a fixture set of both passing and
  gap-triggering draft envelopes.
- `analyze_visual_evidence` HAR redaction tested against a HAR fixture
  containing `Authorization`/`Cookie` headers and body content, asserting
  none of it appears in the tool's output.
- No integration tests against real vendor APIs — none are called directly.
- Plugin `Stop` hook tested against a fixture "narration-only" transcript to
  confirm it blocks.

## 9. Project Layout

```
rcAnalyst/
├── pyproject.toml
├── README.md                        # incl. "5-minute first run, zero vendor MCPs" walkthrough
├── topology.example.yaml
├── adapters.example.yaml            # 3 working reference configs: Grafana Loki, ES/OpenSearch, Splunk REST
├── .claude-plugin/plugin.json
├── hooks/stop_validate.py
├── src/rcanalyst/
│   ├── server.py                    # stdio + HTTP/SSE transports
│   ├── tools/
│   │   ├── plan_investigation.py
│   │   ├── correlate_ids.py
│   │   ├── analyze_visual_evidence.py
│   │   ├── query_generic_source.py
│   │   ├── list_generic_sources.py
│   │   ├── get_coverage.py
│   │   └── validate_rca.py
│   ├── config.py
│   ├── security.py
│   └── bounding.py
├── skills/rca-methodology/SKILL.md
└── tests/
```

## 10. Load-Bearing Assumptions (carried from review, unresolved by design alone)

1. The host model will actually call `validate_rca` before writing the RCA on
   non-Claude-Code hosts, where no hook forces it. Best-effort only there.
2. Teams will author/extend `topology.yaml` for their own resource types;
   mitigated by shipping populated generic defaults.
3. Cross-snippet, name-keyed ID correlation is discriminative enough in
   practice across real-world log formats — to be validated empirically
   during implementation against samples from multiple differently-shaped
   sources, not just assumed.

## 11. Open Items Deferred Past v1

- HTTP/SSE transport is in v1 scope (per approval) to support claude.ai;
  remote-hosting/auth story for the server process itself is an implementation
  detail to work out in the plan, not fully specified here.
- No k8s/infra metrics adapter equivalent to Thanos.
- No PagerDuty-equivalent adapter (assumed to exist as a sibling MCP).
