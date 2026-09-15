from pathlib import Path
import pytest
from rcanalyst.config import (
    AdapterConfig, AdaptersFile, SurfaceCoverage, TopologyFile,
    load_adapters, load_topology, resolve_adapter_credential,
)


def test_load_adapters_missing_file_returns_empty(tmp_path):
    result = load_adapters(tmp_path / "nope.yaml")
    assert result.sources == []


def test_load_adapters_parses_real_file(tmp_path):
    p = tmp_path / "adapters.yaml"
    p.write_text(
        "sources:\n"
        "  - name: loki\n"
        "    base_url: https://loki.example.internal\n"
        "    auth_mode: static_header\n"
        "    auth_env_var: LOKI_AUTH_HEADER\n"
        "    header_name: Authorization\n"
        "    query_template: \"/loki/api/v1/query_range?query={query}\"\n"
        "    covers: [k8s_pod]\n"
    )
    result = load_adapters(p)
    assert len(result.sources) == 1
    assert result.sources[0].name == "loki"
    assert result.sources[0].covers == ["k8s_pod"]


def test_load_topology_missing_file_returns_empty(tmp_path):
    result = load_topology(tmp_path / "nope.yaml")
    assert result.surfaces == {}


def test_load_topology_parses_real_file(tmp_path):
    p = tmp_path / "topology.yaml"
    p.write_text(
        "surfaces:\n"
        "  loki:\n"
        "    covers: [k8s_pod]\n"
        "    blind_to: [lambda]\n"
    )
    result = load_topology(p)
    assert "loki" in result.surfaces
    assert result.surfaces["loki"].blind_to == ["lambda"]


def test_resolve_adapter_credential_static_header(monkeypatch):
    monkeypatch.setenv("MY_TOKEN", "secret-value")
    adapter = AdapterConfig(
        name="x", base_url="https://x", auth_mode="static_header",
        auth_env_var="MY_TOKEN", query_template="/q",
    )
    assert resolve_adapter_credential(adapter) == "secret-value"


def test_resolve_adapter_credential_missing_env_var_raises(monkeypatch):
    monkeypatch.delenv("MISSING_TOKEN", raising=False)
    adapter = AdapterConfig(
        name="x", base_url="https://x", auth_mode="static_header",
        auth_env_var="MISSING_TOKEN", query_template="/q",
    )
    with pytest.raises(ValueError):
        resolve_adapter_credential(adapter)


def test_resolve_adapter_credential_none_mode_returns_none():
    adapter = AdapterConfig(name="x", base_url="https://x", auth_mode="none", query_template="/q")
    assert resolve_adapter_credential(adapter) is None


REPO_ROOT = Path(__file__).parent.parent


def test_example_adapters_file_parses():
    result = load_adapters(REPO_ROOT / "adapters.example.yaml")
    names = {s.name for s in result.sources}
    assert {"loki", "opensearch", "splunk"} <= names


def test_example_topology_file_parses():
    result = load_topology(REPO_ROOT / "topology.example.yaml")
    assert "datadog_logs" in result.surfaces
    assert result.surfaces["loki"].blind_to  # non-empty

    # datadog_logs: log coverage is opt-in per service, so an empty result is
    # the ordinary case, not evidence a service was quiet.
    assert "ORDINARY case" in result.surfaces["datadog_logs"].coverage_note

    # datadog_apm: traces are sampled, so a missing error span is not proof
    # no errors occurred.
    assert "sampled" in result.surfaces["datadog_apm"].coverage_note
