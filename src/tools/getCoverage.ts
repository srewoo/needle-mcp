import type { TopologyFile } from "../config.js";
import type { CoverageResult } from "../models.js";

export function getCoverage(resourceType: string, topology: TopologyFile): CoverageResult {
  const covering: string[] = [];
  const blind: string[] = [];
  let known = false;

  for (const [name, surface] of Object.entries(topology.surfaces)) {
    if (surface.covers.includes(resourceType)) {
      covering.push(name);
      known = true;
    }
    if (surface.blind_to.includes(resourceType)) {
      blind.push(name);
      known = true;
    }
  }

  return { covering_surfaces: covering, blind_surfaces: blind, unknown_coverage: !known };
}
