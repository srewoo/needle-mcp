import { boundJson } from "../bounding.js";
import {
  type AdapterConfig,
  MissingCredentialError,
  resolveAdapterCredential,
} from "../config.js";
import { formatTemplate, MissingPlaceholderError } from "../format.js";
import { fetchWithHostPinning, MAX_RESPONSE_BYTES } from "../http.js";
import type { GenericQueryResult, TimeRange } from "../models.js";
import {
  assertHostAllowed,
  assertUrlStructureUnchanged,
  HostNotAllowedError,
  safeEncodeParam,
} from "../security.js";

function failure(error: string, truncated = false): GenericQueryResult {
  return { rows: [], truncated, returned_count: 0, next_cursor: null, error };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Everything substituted into a query template is percent-encoded, INCLUDING
 * start/end. Those arrive as model-supplied tool arguments and are exactly as
 * untrusted as params. Raw substitution previously let a value like
 * "2026-09-15T00:00:00Z&admin=true" inject an extra query parameter into the
 * request actually sent, since assertUrlStructureUnchanged only inspects the
 * path and ignores everything after '?'.
 */
function buildUrl(
  adapter: AdapterConfig,
  params: Record<string, unknown>,
  timeRange: TimeRange,
  cursor: string | null,
): string {
  const substitutions: Record<string, string> = {
    start: safeEncodeParam(timeRange.start),
    end: safeEncodeParam(timeRange.end),
  };
  for (const [key, value] of Object.entries(params)) {
    substitutions[key] = safeEncodeParam(String(value));
  }

  const path = formatTemplate(adapter.query_template, substitutions);
  let url = adapter.base_url.replace(/\/+$/, "") + path;

  if (cursor && adapter.pagination_cursor_param) {
    const separator = url.includes("?") ? "&" : "?";
    url = `${url}${separator}${adapter.pagination_cursor_param}=${safeEncodeParam(cursor)}`;
  }
  return url;
}

function buildHeaders(adapter: AdapterConfig): Record<string, string> {
  const headers: Record<string, string> = {};

  if (adapter.auth_mode === "static_header") {
    const value = resolveAdapterCredential(adapter);
    headers[adapter.header_name || "Authorization"] = value ?? "";
    return headers;
  }

  if (adapter.auth_mode === "basic") {
    // Unset credentials used to produce Basic base64(":") — an empty credential
    // sent to the vendor, which answers 401 and leaves the operator debugging
    // the query rather than their environment. The static_header path has
    // always failed loudly on the same condition; basic auth now matches it.
    const fields: ReadonlyArray<readonly [string, string | null | undefined]> = [
      ["basic_user_env_var", adapter.basic_user_env_var],
      ["basic_pass_env_var", adapter.basic_pass_env_var],
    ];
    for (const [field, envVar] of fields) {
      if (!envVar) {
        throw new MissingCredentialError(
          `Adapter '${adapter.name}' is basic auth but has no ${field} configured.`,
        );
      }
      if (!process.env[envVar]) {
        throw new MissingCredentialError(
          `Env var '${envVar}' (${field}) for adapter '${adapter.name}' is not set.`,
        );
      }
    }
    const user = process.env[adapter.basic_user_env_var ?? ""] ?? "";
    const pw = process.env[adapter.basic_pass_env_var ?? ""] ?? "";
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pw}`).toString("base64")}`;
  }

  return headers;
}

function extractRows(payload: unknown, responsePath: string | null | undefined): unknown[] {
  if (!responsePath) {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === "object") {
      const rows = (payload as Record<string, unknown>).rows;
      return Array.isArray(rows) ? rows : [];
    }
    return [];
  }

  let node: unknown = payload;
  for (const part of responsePath.split(".")) {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      node = (node as Record<string, unknown>)[part] ?? [];
    } else {
      return [];
    }
  }
  return Array.isArray(node) ? node : [];
}

function extractCursor(payload: unknown, cursorField: string | null | undefined): string | null {
  if (!cursorField || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[cursorField];
  return typeof value === "string" ? value : null;
}

function toError(e: unknown): GenericQueryResult {
  if (e instanceof HostNotAllowedError) return failure(errText(e));
  if (e instanceof MissingPlaceholderError) {
    return failure(
      `query_template placeholder not satisfied: ${errText(e)}. Every {name} in the ` +
        "template must be supplied in params (literal braces must be doubled).",
    );
  }
  // Listed BEFORE the generic value-rejection clause. A missing credential is a
  // deployment-environment problem, not a rejected parameter value, and the old
  // "Rejected param: ..." wording pointed operators at the query instead of at
  // their env vars.
  if (e instanceof MissingCredentialError) return failure(`Adapter credential unavailable: ${e.message}`);
  if (e instanceof TypeError || e instanceof SyntaxError) return failure(`Rejected param: ${errText(e)}`);
  // Backstop: errors from this tool are always a structured GenericQueryResult,
  // never a raw exception.
  return failure(`query_generic_source failed: ${errText(e)}`);
}

export async function queryGenericSource(
  adapter: AdapterConfig,
  params: Record<string, unknown>,
  timeRange: TimeRange,
  allowedHosts: readonly string[],
  cursor: string | null = null,
): Promise<GenericQueryResult> {
  let raw: Uint8Array;
  let overCap: boolean;

  try {
    // The pre-request check deliberately uses the FULL allowlist: it answers
    // "is this a configured source?". The redirect check below uses only this
    // adapter's own host and answers "may this request's credentials travel
    // there?" — different questions, different scopes.
    assertHostAllowed(adapter.base_url, allowedHosts);
    const url = buildUrl(adapter, params, timeRange, cursor);
    assertUrlStructureUnchanged(url, adapter.base_url);
    const headers = buildHeaders(adapter);

    const ownHost = new URL(adapter.base_url).hostname;
    ({ body: raw, overCap } = await fetchWithHostPinning(url, headers, [ownHost]));
  } catch (e) {
    return toError(e);
  }

  if (overCap) {
    return failure(
      `Response exceeded ${MAX_RESPONSE_BYTES} byte cap before parsing; narrow the query.`,
      true,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch (e) {
    return failure(`Non-JSON response: ${errText(e)}`);
  }

  const rows = extractRows(payload, adapter.response_path);
  const nextCursor = extractCursor(payload, adapter.pagination_cursor_field);
  const rowTruncated = rows.length > adapter.max_rows_per_call || Boolean(nextCursor);
  const capped = rows.slice(0, adapter.max_rows_per_call);

  // A row cap alone is not enough — a handful of very large rows can still blow
  // the host's context, so apply the character bound too.
  const [boundedText, charTruncated] = boundJson({
    rows: capped,
    truncated: rowTruncated,
    returned_count: capped.length,
  });
  const bounded = JSON.parse(boundedText) as { rows: Record<string, unknown>[] };

  return {
    rows: bounded.rows,
    truncated: rowTruncated || charTruncated,
    returned_count: bounded.rows.length,
    next_cursor: nextCursor,
    error: null,
  };
}
