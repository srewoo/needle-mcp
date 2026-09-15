import { assertHostAllowed, HostNotAllowedError } from "./security.js";

export const MAX_RESPONSE_BYTES = 2_000_000;
export const REQUEST_TIMEOUT_SECONDS = 15;
const MAX_REDIRECTS = 5;

export interface FetchOutcome {
  body: Uint8Array;
  overCap: boolean;
}

/** Read at most MAX_RESPONSE_BYTES + 1 so the caller can detect the overflow. */
async function readCapped(response: Response): Promise<FetchOutcome> {
  const reader = response.body?.getReader();
  if (!reader) return { body: new Uint8Array(0), overCap: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  await reader.cancel().catch(() => undefined);

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, overCap: total > MAX_RESPONSE_BYTES };
}

/**
 * Fetch with redirects followed MANUALLY, validating each hop's target against
 * `allowedRedirectHosts` BEFORE it is contacted.
 *
 * Letting the runtime follow redirects and checking the final URL afterwards is
 * too late — the request, with its Authorization header, has already been sent
 * to the redirect target. The allowlist passed here is deliberately scoped to
 * the adapter's OWN host, not the union of every configured adapter's host: a
 * redirect from adapter A to adapter B's host would otherwise pass a union
 * allowlist and deliver A's credentials to B. A legitimate adapter never needs
 * to redirect to a different vendor mid-query.
 */
export async function fetchWithHostPinning(
  url: string,
  headers: Record<string, string>,
  allowedRedirectHosts: readonly string[],
): Promise<FetchOutcome> {
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(currentUrl, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_SECONDS * 1000),
    });

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) return readCapped(response);

    const location = response.headers.get("location");
    if (!location) return readCapped(response);

    const nextUrl = new URL(location, currentUrl).toString();
    assertHostAllowed(nextUrl, allowedRedirectHosts);
    currentUrl = nextUrl;
  }

  throw new HostNotAllowedError(
    `Exceeded ${MAX_REDIRECTS} redirects starting from the adapter's base URL; refusing to continue.`,
  );
}
