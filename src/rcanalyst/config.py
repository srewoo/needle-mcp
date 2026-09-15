from __future__ import annotations
import os
from pathlib import Path
from typing import Literal
import yaml
from pydantic import BaseModel, Field


class AdapterConfig(BaseModel):
    name: str
    base_url: str
    auth_mode: Literal["static_header", "basic", "none"] = "none"
    auth_env_var: str | None = None
    header_name: str | None = None
    basic_user_env_var: str | None = None
    basic_pass_env_var: str | None = None
    query_template: str
    response_path: str | None = None
    field_map: dict[str, str] = Field(default_factory=dict)
    covers: list[str] = Field(default_factory=list)
    pagination_cursor_param: str | None = None
    pagination_cursor_field: str | None = None
    max_rows_per_call: int = 200


class AdaptersFile(BaseModel):
    sources: list[AdapterConfig] = Field(default_factory=list)


class SurfaceCoverage(BaseModel):
    tool_prefix: str | None = None
    covers: list[str] = Field(default_factory=list)
    blind_to: list[str] = Field(default_factory=list)
    coverage_note: str | None = None


class TopologyFile(BaseModel):
    surfaces: dict[str, SurfaceCoverage] = Field(default_factory=dict)


def load_adapters(path: str | Path) -> AdaptersFile:
    p = Path(path)
    if not p.exists():
        return AdaptersFile(sources=[])
    with open(p) as f:
        raw = yaml.safe_load(f) or {}
    return AdaptersFile(**raw)


def load_topology(path: str | Path) -> TopologyFile:
    p = Path(path)
    if not p.exists():
        return TopologyFile(surfaces={})
    with open(p) as f:
        raw = yaml.safe_load(f) or {}
    return TopologyFile(**raw)


class MissingCredentialError(ValueError):
    """An adapter declares an auth mode but its credential is not available.

    Distinct from a rejected parameter value: the caller's query was fine, the
    deployment's environment is not. Reporting this as "Rejected param: ..."
    sent operators looking in entirely the wrong place.
    """


def resolve_adapter_credential(adapter: AdapterConfig) -> str | None:
    """Resolve the credential for a static_header adapter from its env var.

    Scoped to auth_mode == "static_header" ONLY. Returns None for "none" and,
    deliberately, for "basic" -- basic-auth credentials are assembled from
    basic_user_env_var/basic_pass_env_var by query_generic_source._build_headers,
    not here. Do not route basic auth through this function expecting credentials.
    """
    if adapter.auth_mode == "static_header":
        if not adapter.auth_env_var:
            raise MissingCredentialError(
                f"Adapter '{adapter.name}' is static_header but has no auth_env_var configured."
            )
        value = os.environ.get(adapter.auth_env_var)
        if not value:
            raise MissingCredentialError(
                f"Env var '{adapter.auth_env_var}' for adapter '{adapter.name}' is not set."
            )
        return value
    return None
