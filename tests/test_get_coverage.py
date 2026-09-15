from rcanalyst.config import TopologyFile, SurfaceCoverage
from rcanalyst.tools.get_coverage import get_coverage


def _topology() -> TopologyFile:
    return TopologyFile(surfaces={
        "loki": SurfaceCoverage(covers=["k8s_pod"], blind_to=["lambda"]),
        "cloudwatch": SurfaceCoverage(covers=["lambda"], blind_to=["k8s_pod"]),
    })


def test_covering_surface_found():
    result = get_coverage("k8s_pod", _topology())
    assert result.covering_surfaces == ["loki"]
    assert "cloudwatch" in result.blind_surfaces
    assert result.unknown_coverage is False


def test_blind_surface_listed_for_other_resource():
    result = get_coverage("lambda", _topology())
    assert result.covering_surfaces == ["cloudwatch"]
    assert "loki" in result.blind_surfaces


def test_unknown_resource_type_flagged():
    result = get_coverage("airflow_task", _topology())
    assert result.covering_surfaces == []
    assert result.blind_surfaces == []
    assert result.unknown_coverage is True


def test_empty_topology_is_unknown():
    result = get_coverage("anything", TopologyFile(surfaces={}))
    assert result.unknown_coverage is True
