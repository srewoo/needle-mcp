from __future__ import annotations
from needle_mcp.config import TopologyFile
from needle_mcp.models import CoverageResult


def get_coverage(resource_type: str, topology: TopologyFile) -> CoverageResult:
    covering: list[str] = []
    blind: list[str] = []
    known = False
    for name, surface in topology.surfaces.items():
        if resource_type in surface.covers:
            covering.append(name)
            known = True
        if resource_type in surface.blind_to:
            blind.append(name)
            known = True
    return CoverageResult(covering_surfaces=covering, blind_surfaces=blind, unknown_coverage=not known)
