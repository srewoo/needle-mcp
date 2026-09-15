import { readFileSync, existsSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";
import { AuthModeSchema } from "./models.js";

export const AdapterConfigSchema = z.object({
  name: z.string(),
  base_url: z.string(),
  auth_mode: AuthModeSchema.default("none"),
  auth_env_var: z.string().nullish().default(null),
  header_name: z.string().nullish().default(null),
  basic_user_env_var: z.string().nullish().default(null),
  basic_pass_env_var: z.string().nullish().default(null),
  query_template: z.string(),
  response_path: z.string().nullish().default(null),
  field_map: z.record(z.string()).default({}),
  covers: z.array(z.string()).default([]),
  pagination_cursor_param: z.string().nullish().default(null),
  pagination_cursor_field: z.string().nullish().default(null),
  max_rows_per_call: z.number().int().default(200),
});
export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;

export const AdaptersFileSchema = z.object({
  sources: z.array(AdapterConfigSchema).default([]),
});
export type AdaptersFile = z.infer<typeof AdaptersFileSchema>;

export const SurfaceCoverageSchema = z.object({
  tool_prefix: z.string().nullish().default(null),
  covers: z.array(z.string()).default([]),
  blind_to: z.array(z.string()).default([]),
  coverage_note: z.string().nullish().default(null),
});
export type SurfaceCoverage = z.infer<typeof SurfaceCoverageSchema>;

export const TopologyFileSchema = z.object({
  surfaces: z.record(SurfaceCoverageSchema).default({}),
});
export type TopologyFile = z.infer<typeof TopologyFileSchema>;

function readYaml(path: string): unknown {
  if (!existsSync(path)) return null;
  return parseYaml(readFileSync(path, "utf-8")) ?? {};
}

export function loadAdapters(path: string): AdaptersFile {
  const raw = readYaml(path);
  if (raw === null) return { sources: [] };
  return AdaptersFileSchema.parse(raw);
}

export function loadTopology(path: string): TopologyFile {
  const raw = readYaml(path);
  if (raw === null) return { surfaces: {} };
  return TopologyFileSchema.parse(raw);
}

/**
 * An adapter declares an auth mode but its credential is not available.
 *
 * Distinct from a rejected parameter value: the caller's query was fine, the
 * deployment's environment is not. Reporting this as "Rejected param: ..." sent
 * operators looking in entirely the wrong place.
 */
export class MissingCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCredentialError";
  }
}

/**
 * Resolve the credential for a static_header adapter from its env var.
 *
 * Scoped to auth_mode === "static_header" ONLY. Returns null for "none" and,
 * deliberately, for "basic" — basic-auth credentials are assembled from
 * basic_user_env_var/basic_pass_env_var by queryGenericSource's buildHeaders,
 * not here. Do not route basic auth through this function expecting credentials.
 */
export function resolveAdapterCredential(adapter: AdapterConfig): string | null {
  if (adapter.auth_mode === "static_header") {
    if (!adapter.auth_env_var) {
      throw new MissingCredentialError(
        `Adapter '${adapter.name}' is static_header but has no auth_env_var configured.`,
      );
    }
    const value = process.env[adapter.auth_env_var];
    if (!value) {
      throw new MissingCredentialError(
        `Env var '${adapter.auth_env_var}' for adapter '${adapter.name}' is not set.`,
      );
    }
    return value;
  }
  return null;
}
