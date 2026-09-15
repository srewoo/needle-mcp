import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadAdapters, loadTopology, type AdaptersFile } from "./config.js";
import { INSTRUCTIONS } from "./instructions.js";
import { METHODOLOGY_URI, methodologyText } from "./methodology.js";
import { adaptersPath, topologyPath } from "./paths.js";
import { analyzeVisualEvidence } from "./tools/analyzeVisualEvidence.js";
import { correlateIds } from "./tools/correlateIds.js";
import { getCoverage } from "./tools/getCoverage.js";
import { listGenericSources } from "./tools/listGenericSources.js";
import { planInvestigation } from "./tools/planInvestigation.js";
import { queryGenericSource } from "./tools/queryGenericSource.js";
import { resolveAdapter } from "./tools/resolveAdapter.js";
import { validateRca } from "./tools/validateRca.js";

/** Wrappers only: every tool body calls one pure function and serializes it. */
function reply(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function adapters(): AdaptersFile {
  return loadAdapters(adaptersPath());
}

function allowedHosts(file: AdaptersFile): string[] {
  const hosts: string[] = [];
  for (const a of file.sources) {
    try {
      const host = new URL(a.base_url).hostname;
      if (host) hosts.push(host);
    } catch {
      continue;
    }
  }
  return hosts;
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "needle-mcp", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerPrompt(
    "rca_methodology",
    {
      title: "RCA methodology",
      description:
        "The full needle-mcp investigation discipline: the five rules, the " +
        "environment/coverage gates, and the exact RCA result envelope schema. " +
        "Read this before using any needle-mcp tool.",
    },
    () => ({
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: methodologyText() } },
      ],
    }),
  );

  server.registerResource(
    "rca_methodology",
    METHODOLOGY_URI,
    {
      title: "RCA methodology",
      description:
        "The full needle-mcp investigation discipline and RCA result envelope " +
        "schema (skills/rca-methodology/SKILL.md).",
      mimeType: "text/markdown",
    },
    () => ({
      contents: [
        { uri: METHODOLOGY_URI, mimeType: "text/markdown", text: methodologyText() },
      ],
    }),
  );

  server.registerTool(
    "correlate_ids",
    {
      description:
        "Extract and rank correlation IDs (request/trace/span/message/job) shared " +
        "across log snippets you've already collected elsewhere. Use this to carry " +
        "an identifier forward across a sync-to-async hop (e.g. an HTTP request " +
        "into a Kafka consumer).",
      inputSchema: { evidence_snippets: z.array(z.string()) },
    },
    ({ evidence_snippets }) => reply(correlateIds(evidence_snippets)),
  );

  server.registerTool(
    "plan_investigation",
    {
      description:
        "START HERE when the user hands you a bare identifier — a session id, " +
        "request id, trace id, or correlation id — with no logs yet. Classifies the " +
        "identifier's shape, returns every vendor spelling it may appear under, names " +
        "which configured sources and coverage surfaces can answer for it, and " +
        "suggests a time window (widened when the id looks async). Use correlate_ids " +
        "instead once you already have log snippets in hand.",
      inputSchema: {
        identifier: z.string(),
        environment: z.string().nullish(),
      },
    },
    ({ identifier, environment }) =>
      reply(
        planInvestigation(identifier, environment, adapters().sources, loadTopology(topologyPath())),
      ),
  );

  server.registerTool(
    "analyze_visual_evidence",
    {
      description:
        "Extract structured evidence from a HAR / browser network-tab export: " +
        "failed and slow requests, with correlation headers, redacted.\n\n" +
        "If you already have a screenshot in your own context, reason about it " +
        "directly — do NOT pass it here. The image_base64 parameter returns the image " +
        "unchanged (this tool runs no vision model), so round-tripping one you can " +
        "already see just puts a second copy in your context. Pass it only if you " +
        "need the image echoed back alongside HAR findings.",
      inputSchema: {
        context: z.string().default(""),
        image_base64: z.string().nullish(),
        // A host sending har_json as HAR *text* — its one intended use — may
        // deliver already-parsed JSON. Accept either shape at the wire boundary
        // and re-serialize; the pure function's string-only contract is correct
        // and stays untouched.
        har_json: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).nullish(),
        har_path: z.string().nullish(),
        slow_threshold_ms: z.number().default(1000),
      },
    },
    ({ context, image_base64, har_json, har_path, slow_threshold_ms }) =>
      reply(
        analyzeVisualEvidence({
          context,
          imageBase64: image_base64 ?? null,
          harJson:
            har_json === null || har_json === undefined
              ? null
              : typeof har_json === "string"
                ? har_json
                : JSON.stringify(har_json),
          harPath: har_path ?? null,
          slowThresholdMs: slow_threshold_ms,
        }),
      ),
  );

  server.registerTool(
    "query_generic_source",
    {
      description:
        "Query a source declared in adapters.yaml via a config-templated REST " +
        "call. Use ONLY when no vendor MCP (Datadog/Splunk/Loki/etc.) already " +
        "covers this source — prefer your own connected MCPs first.",
      inputSchema: {
        source: z.string(),
        params: z.record(z.unknown()),
        start: z.string(),
        end: z.string(),
        cursor: z.string().nullish(),
      },
    },
    async ({ source, params, start, end, cursor }) => {
      const file = adapters();
      const match = resolveAdapter(source, file.sources);
      if (match === null) {
        return reply({
          rows: [],
          truncated: false,
          returned_count: 0,
          next_cursor: null,
          error: `Unknown source '${source}'. Call list_generic_sources first.`,
        });
      }
      return reply(
        await queryGenericSource(match, params, { start, end }, allowedHosts(file), cursor ?? null),
      );
    },
  );

  server.registerTool(
    "list_generic_sources",
    { description: "List the sources declared in adapters.yaml for this deployment." },
    () => reply(listGenericSources(adapters().sources)),
  );

  server.registerTool(
    "get_coverage",
    {
      description:
        "Look up which observability surfaces cover (or are blind to) a resource " +
        "type, from topology.yaml. If unknown_coverage is true, you may NOT " +
        "conclude absence from an empty query result for this resource type.",
      inputSchema: { resource_type: z.string() },
    },
    ({ resource_type }) => reply(getCoverage(resource_type, loadTopology(topologyPath()))),
  );

  server.registerTool(
    "validate_rca",
    {
      description:
        "Deterministically lint a draft RCA's structured claim before you post it. " +
        "Call this before finalizing any RCA, and emit the envelope fenced between " +
        "BEGIN_NEEDLE_MCP_RESULT_JSON and END_NEEDLE_MCP_RESULT_JSON — on Claude Code a " +
        "Stop hook re-runs this check against that block regardless.",
      inputSchema: {
        claim_json: z.record(z.unknown()),
        investigation_log: z.array(z.record(z.unknown())).nullish(),
      },
    },
    ({ claim_json, investigation_log }) =>
      reply(validateRca(claim_json, investigation_log ?? [])),
  );

  return server;
}
