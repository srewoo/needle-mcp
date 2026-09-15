import { readFileSync, statSync } from "node:fs";
import type { HarEntry, VisualEvidenceResult } from "../models.js";
import { redactHeaders, redactUrl } from "../security.js";

export const SLOW_THRESHOLD_MS_DEFAULT = 1000;

/**
 * Spec §4 anticipates 5-50MB HAR exports arriving by path (which is exactly why
 * harPath exists). The cap sits at the top of that documented range: above it,
 * parsing would hold the whole document in the server's memory with no benefit,
 * since the tool discards all but the failed/slow entries anyway.
 */
export const MAX_HAR_FILE_BYTES = 50 * 1024 * 1024;

const CORRELATION_HEADER_NAMES = [
  "x-request-id",
  "traceparent",
  "x-amzn-trace-id",
  "x-datadog-trace-id",
  "x-correlation-id",
  "request-id",
] as const;

export interface AnalyzeVisualEvidenceOptions {
  /**
   * Never read by this tool — it exists so the caller can state what it is
   * looking at. Defaulted because SKILL.md and README both document calls that
   * omit it, and a required-but-unused parameter turns those documented calls
   * into errors.
   */
  context?: string;
  imageBase64?: string | null;
  harJson?: string | null;
  harPath?: string | null;
  slowThresholdMs?: number;
}

/**
 * Return [har, errorNote]. Never throws: a mistyped path, an oversized export,
 * or a truncated/invalid JSON body is described in the returned note and
 * surfaced through VisualEvidenceResult.notes. Every other tool in this server
 * returns a structured result on failure; this one used to be the sole
 * exception, letting filesystem/parse errors escape as a raw MCP tool error.
 */
function loadHar(
  harJson: string | null | undefined,
  harPath: string | null | undefined,
): [unknown, string | null] {
  if (harPath) {
    let size: number;
    try {
      size = statSync(harPath).size;
    } catch (e) {
      return [null, `Could not read har_path '${harPath}': ${errText(e)}`];
    }
    if (size > MAX_HAR_FILE_BYTES) {
      return [
        null,
        `har_path '${harPath}' is ${size} bytes, over the ${MAX_HAR_FILE_BYTES} byte cap. ` +
          "Trim the export in your browser's network tab (filter to the failing requests) and retry.",
      ];
    }
    let text: string;
    try {
      text = readFileSync(harPath, "utf-8");
    } catch (e) {
      return [null, `Could not read har_path '${harPath}': ${errText(e)}`];
    }
    try {
      return [JSON.parse(text), null];
    } catch (e) {
      return [null, `har_path '${harPath}' is not valid JSON: ${errText(e)}`];
    }
  }

  if (harJson) {
    try {
      return [JSON.parse(harJson), null];
    } catch (e) {
      return [null, `har_json is not valid JSON: ${errText(e)}`];
    }
  }

  return [null, null];
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toFloat(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function parseHarEntries(har: unknown, slowThresholdMs: number): [HarEntry[], number] {
  const log = (har as { log?: { entries?: unknown } }).log;
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  const kept: HarEntry[] = [];
  let dropped = 0;

  for (const raw of entries) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const request = (entry.request ?? {}) as Record<string, unknown>;
    const response = (entry.response ?? {}) as Record<string, unknown>;

    const status = toInt(response.status);
    const timeMs = toFloat(entry.time);

    if (!(status >= 400 || timeMs >= slowThresholdMs)) {
      dropped += 1;
      continue;
    }

    const rawHeaders: Record<string, string> = {};
    const headerList = Array.isArray(request.headers) ? request.headers : [];
    for (const h of headerList) {
      const header = (h ?? {}) as Record<string, unknown>;
      if (typeof header.name === "string" && header.name) {
        rawHeaders[header.name] = typeof header.value === "string" ? header.value : "";
      }
    }

    const allowed = redactHeaders(rawHeaders, CORRELATION_HEADER_NAMES);
    const corrHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(allowed)) corrHeaders[k.toLowerCase()] = v;

    // Defensive, matching this parser's posture elsewhere: a malformed HAR can
    // carry a non-string or absent startedDateTime, and a missing wall-clock
    // anchor is better than a fabricated one.
    const started = entry.startedDateTime;
    const timestamp = typeof started === "string" && started ? started : null;

    kept.push({
      method: typeof request.method === "string" ? request.method : "?",
      url: redactUrl(typeof request.url === "string" ? request.url : ""),
      status,
      time_ms: timeMs,
      timestamp,
      correlation_headers: corrHeaders,
    });
  }

  return [kept, dropped];
}

export function analyzeVisualEvidence(
  options: AnalyzeVisualEvidenceOptions = {},
): VisualEvidenceResult {
  const {
    imageBase64 = null,
    harJson = null,
    harPath = null,
    slowThresholdMs = SLOW_THRESHOLD_MS_DEFAULT,
  } = options;

  const notes: string[] = [];
  let harEntries: HarEntry[] = [];
  let dropped = 0;

  const [har, harError] = loadHar(harJson, harPath);
  if (harError) {
    notes.push(harError);
  } else if (har !== null && (typeof har !== "object" || Array.isArray(har))) {
    notes.push(
      `HAR input parsed as ${Array.isArray(har) ? "list" : typeof har}, not a HAR document ` +
        "(expected an object with a 'log.entries' array); no entries extracted.",
    );
  } else if (har !== null) {
    [harEntries, dropped] = parseHarEntries(har, slowThresholdMs);
    notes.push(
      "Request/response bodies are never returned by this tool, to " +
        "avoid leaking auth tokens or PII into the model context.",
    );
  }

  let passthrough: string | null = null;
  if (imageBase64) {
    passthrough = imageBase64;
    notes.push(
      "Raw image passed through unmodified for your own multimodal " +
        "reasoning; this tool does not run its own vision model. Large " +
        "screenshots may approach the ~1MB single-message size limit.",
    );
  }

  return {
    har_entries: harEntries,
    har_dropped_count: dropped,
    image_passthrough: passthrough,
    notes,
  };
}
