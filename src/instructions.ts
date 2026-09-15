/**
 * The result sentinels must match BYTE-FOR-BYTE in three places:
 * skills/rca-methodology/SKILL.md (what the host is told to emit),
 * hooks/stop-validate.mjs (what the hook greps for), and this string.
 * If they drift, the hook silently never matches a real turn and enforcement is
 * dead with no error anywhere.
 *
 *   grep -rn "NEEDLE_MCP_RESULT_JSON" skills/ hooks/ src/
 *
 * should return all three.
 */
export const RESULT_BEGIN_SENTINEL = "BEGIN_NEEDLE_MCP_RESULT_JSON";
export const RESULT_END_SENTINEL = "END_NEEDLE_MCP_RESULT_JSON";

export const INSTRUCTIONS =
  "needle-mcp provides RCA building-block tools for a Claude session " +
  "investigating an incident. It has no orchestration logic of its own — " +
  "read the rca-methodology skill/prompt before using these tools. Prefer " +
  "your own already-connected vendor MCP (Datadog, Splunk, GitLab, " +
  "Sourcegraph, etc.) for logs, metrics, and code; use query_generic_source " +
  "ONLY when no such vendor MCP covers the source in question. " +
  "Starting from a bare identifier (session/request/trace id) with no logs " +
  "yet? Call plan_investigation first. Already holding log snippets? Use " +
  "correlate_ids. Finish by calling validate_rca, and emit the envelope " +
  `fenced between ${RESULT_BEGIN_SENTINEL} and ${RESULT_END_SENTINEL}.`;
