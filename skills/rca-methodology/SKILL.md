---
name: rca-methodology
description: Use when investigating a production incident, alert, or bug report with rcAnalyst's tools — encodes the investigation discipline that turns tool calls into a trustworthy root-cause analysis.
---

# RCA Methodology

You are investigating a production incident. You have your own connected MCP
tools (Datadog, Splunk, Loki, GitLab, Sourcegraph, PagerDuty, or whatever your
session has) plus rcAnalyst's tools: `plan_investigation`, `correlate_ids`,
`analyze_visual_evidence`, `query_generic_source`, `list_generic_sources`,
`get_coverage`, `validate_rca`.

rcAnalyst has no orchestration logic of its own — you decide what to query,
how deep to go, and when to stop. rcAnalyst's tools are building blocks and a
final lint gate, not a substitute for your own judgment.

## Where to start, by what you were given

**A question in plain language** ("why is checkout 500ing in prod since 10am").
This is the most common case. Establish the environment and the time window,
then go straight to your own connected log/APM tools for the named service.
rcAnalyst contributes the discipline below and the final gate — it has no
"search everything" tool, by design, because your vendor MCPs already do that
better with your own credentials.

**A bare identifier** (session id, request id, trace id) with no logs yet. Call
`plan_investigation(identifier, environment)`. It tells you what kind of id it
is, every spelling it may appear under (vendors differ: Datadog writes a trace
id in decimal, W3C in hex), which of your sources can answer for it, and how
wide a window to use. Do not call `correlate_ids` here — that tool needs
snippets you have not collected yet.

**A screenshot.** Reason about it directly; you can already see it. Extract the
failing URL, status code, and any visible id, then treat those as the starting
evidence. Do not pass the image to `analyze_visual_evidence` — that returns it
unchanged and just duplicates it in your context.

**A HAR / network-tab export.** Call `analyze_visual_evidence(har_path=...)`.
It returns only the failed and slow requests, with correlation headers, safely
redacted — the fastest path from "the UI is broken" to a backend trace id.

## Before you start

State (or ask for, if ambiguous) the **environment** (prod / staging /
whatever your deployment names are) explicitly. Unlike a fully unattended
system, a human is present here — one clarifying question about environment
or which specific resource is affected is expected and encouraged, not
forbidden. A wrong-environment investigation produces a confident, silently
wrong answer with nothing else to catch it.

Inventory what you actually have: which vendor MCP tools are connected in
this session (their names tell you roughly what they cover), and whether
`adapters.yaml`/`topology.yaml` are configured for anything else.

## Five rules

### 1. Trace to terminal

A downstream's 5xx, `Unavailable`, `DeadlineExceeded`, `i/o timeout`, or
`context deadline exceeded`, seen at a client-adapter boundary path
(`external/`, `clients/`, `adapters/`, `*_client.*`, `*Stub.*`) is the RPC
boundary, not the cause. Keep querying the named downstream's own logs until
the exception originates there, or names an external vendor at the boundary.
Only then is it strong evidence. Soft cap: 10 hops, then stop and report
`partial_evidence` naming the open question.

A generic error (a 5xx, a panic, a `NullPointerException`) is a symptom — the
real exception usually sits in a WARN/INFO line one hop away. Query more
narrowly before concluding.

"Cache miss + slow fallback" is not a cause — the fallback was slow or errored
for a reason, and that reason is the RCA.

### 2. Empty is not absent

Before treating a zero-result query as "this did not happen," call
`get_coverage(resource_type)`. If `unknown_coverage: true`, you may not
conclude absence — say what you couldn't check instead. Otherwise, work
through these in order:
- **Wrong window** — rule this out first. Re-derive the window from the
  alert's own timestamp; confirm it's UTC and runs forward.
- **Backend unreachable/erroring** — stop, report `primary_backend_unreachable`,
  don't pivot to another backend to manufacture a story.
- **Backend healthy but blind to this resource** (per `get_coverage`) — a
  routing fact, not a finding; re-ask on a surface that covers it.
- **Backend healthy, covers the resource, quiet window** — genuine absence,
  report it.

### 3. Reconcile magnitude

The cited driver's frequency × per-call cost must reproduce the alarm's
actual numeric value. If it doesn't, the cause is incomplete — a volume
driver (one tenant's burst, a batch job) is usually the real cause. **Never
reconcile magnitude against a `truncated: true` result** — a truncated count
is not the real count.

### 4. Decompose the series

An alert is a claim about a measured series. Break it down by whatever
dimension varies in the window (tenant, endpoint, pod, region — there's no
fixed list). A pattern claim ("this is a leak", "one tenant") made without
that breakdown is a guess. Any RCA that cites a metric must record what it
was decomposed by (`decomposed_by` in the envelope) — `validate_rca` rejects
a metric-anchored claim with no decomposition.

### 5. Humans outrank logs

If a PagerDuty (or equivalent incident-management) MCP is connected, its
responder notes/related incidents often *are* the RCA — confirm and report
that chain rather than contradicting it with a guessed code path. If no such
tool is connected, ask the responder directly what's already known before
investigating — don't silently skip this rule for lack of a tool.

## Enrichment order

Read code (via your GitLab/Sourcegraph MCP, or `query_generic_source` as a
last resort) only **after** an investigator has returned a suspect
`file:line`, exception type, or symbol — never at the start. A host session
commonly has a code-search tool ready and reaching for it first is the
easiest way to manufacture a false narrative for what is actually an
infrastructure or operational cause.

## Async tracing

To trace a bug from a sync request into an async hop (a Kafka consumer, an
SQS handler, a background job), call `correlate_ids` on the log snippets
you've collected. It returns each candidate's `suggested_window` — widened
and forward-biased for message/job-shaped keys, since a lagging consumer's
log can trail the producer's by tens of minutes. An empty result on an async
hop queried with a tight window is a wrong-window empty, not an absence.

## Before you finalize

Call `validate_rca(claim_json, investigation_log)` with your draft envelope
and a list of what you actually queried. If it returns `approved: false`,
address every blocking gap before posting — on Claude Code, a Stop hook
re-checks this regardless of whether you remembered to call it.

## Output

Confidence levels: `strong_evidence` (terminal cause traced, or a vendor
boundary confirmed, or a fully reconciled metric), `partial_evidence` (real
evidence pointing at a cause, chain not fully traced), `inconclusive` (data
unavailable or backend unreachable). A resolved condition — a threshold
breach that cleared on its own, evidenced by reading past the peak — is a
full `strong_evidence` answer, not a weaker one.

Write the RCA with: a one-sentence TL;DR (terminal cause, service, when it
crossed threshold), an Evidence section (each row inside the `alert_window`),
and Recommendations (verb-first, ≤3).

Then, as the **last thing in your turn, every time** — success, partial, or
inconclusive — emit the structured envelope fenced with these exact sentinels:

```
BEGIN_RCANALYST_RESULT_JSON
{
  "confidence": "strong_evidence|partial_evidence|inconclusive",
  "status": "success|partial|inconclusive",
  "root_cause": "one-line summary",
  "affected_services": ["svc1"],
  "environment": "prod",
  "alert_window": {"start": "ISO8601", "end": "ISO8601"},
  "evidence": [
    {"timestamp": "ISO8601", "text": "exception or metric value",
     "source_ref": "file:line or surface", "environment": "prod"}
  ],
  "hop_trace": {"hop_count": 2, "stop_reason": "terminal|vendor_boundary|hop_cap_reached"},
  "alert_metric": "metric.name",
  "decomposed_by": "tenant_id",
  "monitored_resource": {"unresolved": false}
}
END_RCANALYST_RESULT_JSON
```

The sentinels are not decoration: on Claude Code a Stop hook greps for exactly
this block and re-runs `validate_rca` against it before your turn is allowed to
end. A turn that ends on narration with no envelope is the single most common
way an investigation's work gets thrown away. Include `alert_metric` whenever
the claim is anchored to a metric or threshold — and then `decomposed_by` is
required alongside it, naming the dimension the series was broken down by.
Include `monitored_resource` with an `unresolved` boolean whenever the alert's
target resource could not be definitively identified; set `unresolved: true`
in that case (a `strong_evidence` confidence is rejected while it's true).
Omit `alert_metric`/`decomposed_by` when no metric is cited, and omit
`monitored_resource` when the target resource was cleanly identified;
include every other key.

`alert_window` and `evidence` are not optional. An envelope with an empty or
absent `evidence` list is rejected (`no-evidence-cited`) unless `confidence` is
`inconclusive`, where having nothing to cite is the honest answer. An envelope
with no `alert_window` is rejected (`alert-window-missing`), because without one
every evidence-timestamp check is vacuous.
