/**
 * Redaction + host allowlisting. The security floor lives here.
 *
 * Redaction is ALLOWLIST, never denylist, and Authorization/Cookie/Set-Cookie
 * are dropped even when a caller explicitly allowlists them.
 */

export const DEFAULT_HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  "content-type",
  "x-request-id",
  "traceparent",
  "x-datadog-trace-id",
  "x-amzn-trace-id",
  "x-correlation-id",
  "request-id",
  "server-timing",
  "date",
  "cache-control",
]);

export const NEVER_RETURN_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
]);

export class HostNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostNotAllowedError";
  }
}

/**
 * Keep only allowlisted headers; NEVER_RETURN_HEADERS are dropped even if
 * explicitly allowlisted by the caller — this is a hard floor, not a default.
 */
export function redactHeaders(
  headers: Record<string, string>,
  allowlist?: Iterable<string> | null,
): Record<string, string> {
  const source = allowlist ?? DEFAULT_HEADER_ALLOWLIST;
  const allow = new Set<string>();
  for (const h of source) allow.add(h.toLowerCase());

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (NEVER_RETURN_HEADERS.has(lower)) continue;
    if (allow.has(lower)) out[key] = value;
  }
  return out;
}

/**
 * Strip the query string (may carry tokens/PII); keep scheme+host+path.
 *
 * Unlike the Python original — which rebuilt from urlparse().netloc and so
 * preserved any `user:pass@` userinfo — this drops userinfo, because a
 * redaction helper that echoes embedded credentials is not redacting.
 * Never throws: HAR exports carry malformed URLs, and this is called while
 * parsing them.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // Not parseable as an absolute URL: drop anything after '?' and return the
    // rest verbatim rather than inventing structure.
    const queryStart = url.indexOf("?");
    return queryStart === -1 ? url : url.slice(0, queryStart);
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function assertHostAllowed(url: string, allowedHosts: readonly string[]): void {
  const host = hostnameOf(url);
  if (!allowedHosts.includes(host)) {
    throw new HostNotAllowedError(
      `Host '${host}' is not in the configured allowlist ${JSON.stringify(allowedHosts)}. ` +
        "Add it to adapters.yaml if this is intentional.",
    );
  }
}

/**
 * Percent-encode a param value for safe substitution into a query template.
 *
 * Matches Python's `quote(value, safe="")`: encodeURIComponent leaves
 * `!'()*` unescaped, so those are escaped explicitly here. Without that, the
 * two implementations would disagree on exactly the characters most useful for
 * smuggling structure into a query.
 *
 * Deliberately does NOT reject values containing '://' or '..': searching logs
 * for a URL or an ES range is a core RCA query, and full encoding already
 * renders those inert. Structural safety is enforced after the URL is built, by
 * assertUrlStructureUnchanged().
 */
export function safeEncodeParam(value: string): string {
  if (value.startsWith("//")) {
    throw new TypeError(
      `Param value '${value}' starts with '//' (protocol-relative) and was rejected.`,
    );
  }
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Confirm a template-built URL still points at the adapter's own host and did
 * not gain a scheme/host/path-prefix change from substituted values.
 */
export function assertUrlStructureUnchanged(builtUrl: string, baseUrl: string): void {
  let built: URL;
  let base: URL;
  try {
    built = new URL(builtUrl);
    base = new URL(baseUrl);
  } catch {
    throw new HostNotAllowedError(
      `Built URL '${redactUrl(builtUrl)}' or adapter base '${redactUrl(baseUrl)}' ` +
        "is not a valid absolute URL; refusing to send it.",
    );
  }

  if (
    built.protocol !== base.protocol ||
    built.hostname !== base.hostname ||
    built.port !== base.port
  ) {
    throw new HostNotAllowedError(
      `Built URL '${redactUrl(builtUrl)}' does not match adapter base ` +
        `'${redactUrl(baseUrl)}' in scheme/host/port; refusing to send it.`,
    );
  }

  const basePath = base.pathname.replace(/\/+$/, "");
  if (!built.pathname.startsWith(basePath)) {
    throw new HostNotAllowedError(
      `Built URL path '${built.pathname}' escapes the adapter's base path; refusing to send it.`,
    );
  }

  // Checked against the RAW string, not built.pathname. The URL constructor
  // RESOLVES dot segments during parsing ("/api/../admin/q" becomes
  // "/admin/q"), so by the time the parsed object exists the traversal is gone
  // and inspecting it would always pass — while the request still goes to the
  // escaped path. Python's urlparse preserves the segments, so the original
  // implementation could check the parsed path; this one cannot.
  const rawPath = rawPathOf(builtUrl);
  if (rawPath.split("/").includes("..")) {
    throw new HostNotAllowedError(
      `Built URL path '${rawPath}' contains a '..' path segment; refusing to send it.`,
    );
  }
}

/**
 * The path portion of a URL exactly as written, with no dot-segment resolution.
 */
function rawPathOf(url: string): string {
  const afterScheme = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const slash = afterScheme.indexOf("/");
  if (slash === -1) return "";
  const path = afterScheme.slice(slash);
  return path.split(/[?#]/)[0] ?? "";
}
