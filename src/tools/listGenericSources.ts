import type { AdapterConfig } from "../config.js";
import type { SourceInfo } from "../models.js";

/**
 * Built through the SourceInfo shape rather than a hand-rolled object mirroring
 * it. The hand-rolled version derived the host with a string split that KEEPS
 * the port, while the server's allowlist uses URL.hostname, which drops it — so
 * the host this tool advertised for an adapter on a non-default port never
 * matched the one actually allowlisted. One derivation now.
 */
export function listGenericSources(adapters: readonly AdapterConfig[]): SourceInfo[] {
  return adapters.map((a) => ({
    name: a.name,
    base_url_host: hostOf(a.base_url),
    auth_mode: a.auth_mode,
    covers: a.covers,
  }));
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}
