import type { AdapterConfig } from "../config.js";

/**
 * Look up an adapter by name from the configured list. Returns null on a miss
 * so the caller can build a structured, schema-conformant error result rather
 * than throwing.
 */
export function resolveAdapter(
  source: string,
  adapters: readonly AdapterConfig[],
): AdapterConfig | null {
  return adapters.find((a) => a.name === source) ?? null;
}
