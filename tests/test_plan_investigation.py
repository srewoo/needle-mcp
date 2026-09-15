from rcanalyst.config import AdapterConfig, SurfaceCoverage, TopologyFile
from rcanalyst.tools.plan_investigation import (
    ASYNC_WINDOW_HINT,
    SYNC_WINDOW_HINT,
    plan_investigation,
)


def _adapters() -> list[AdapterConfig]:
    return [
        AdapterConfig(name="loki", base_url="https://loki.x", query_template="/q?q={query}", covers=["k8s_pod"]),
        AdapterConfig(name="splunk", base_url="https://splunk.x", query_template="/q?q={query}", covers=["generic_service"]),
    ]


def _topology() -> TopologyFile:
    return TopologyFile(surfaces={
        "loki": SurfaceCoverage(covers=["k8s_pod"], blind_to=["lambda"]),
        "cloudwatch": SurfaceCoverage(covers=["lambda"], blind_to=["k8s_pod"]),
    })


def test_classifies_uuid():
    plan = plan_investigation("3f2504e0-4f89-11d3-9a0c-0305e82c3301", None, [], TopologyFile())
    assert plan.identifier_kind == "uuid"


def test_classifies_w3c_trace():
    plan = plan_investigation("4bf92f3577b34da6a3ce929d0e0e4736", None, [], TopologyFile())
    assert plan.identifier_kind == "w3c_trace"


def test_classifies_datadog_decimal_trace():
    plan = plan_investigation("4823516278365812", None, [], TopologyFile())
    assert plan.identifier_kind == "datadog_decimal_trace"


def test_classifies_aws_xray():
    plan = plan_investigation("1-5759e988-bd862e3fe1be46a994272793", None, [], TopologyFile())
    assert plan.identifier_kind == "aws_xray"


def test_classifies_opaque_session_id():
    plan = plan_investigation("sess_abc123XYZ", None, [], TopologyFile())
    assert plan.identifier_kind == "opaque"


def test_decimal_trace_offers_hex_equivalent_form():
    plan = plan_investigation("4823516278365812", None, [], TopologyFile())
    assert format(4823516278365812, "x") in plan.equivalent_forms


def test_suggests_key_names_to_search():
    plan = plan_investigation("3f2504e0-4f89-11d3-9a0c-0305e82c3301", None, [], TopologyFile())
    assert "x-request-id" in plan.likely_key_names
    assert "trace_id" in plan.likely_key_names


def test_lists_configured_adapters_as_queryable():
    plan = plan_investigation("sess_abc123XYZ", None, _adapters(), TopologyFile())
    names = {s.name for s in plan.queryable_sources if s.kind == "configured_adapter"}
    assert names == {"loki", "splunk"}


def test_lists_coverage_surfaces_as_queryable():
    plan = plan_investigation("sess_abc123XYZ", None, [], _topology())
    names = {s.name for s in plan.queryable_sources if s.kind == "coverage_surface"}
    assert names == {"loki", "cloudwatch"}


def test_no_sources_configured_flags_unknown_coverage():
    plan = plan_investigation("sess_abc123XYZ", None, [], TopologyFile())
    assert plan.unknown_coverage is True
    assert any("no configured sources" in step.lower() for step in plan.next_steps)


def test_async_shaped_identifier_widens_window_hint():
    plan = plan_investigation("msg-00ab12cd34ef", None, [], TopologyFile())
    assert plan.is_async_shaped is True
    assert plan.suggested_window_hint == ASYNC_WINDOW_HINT


def test_sync_identifier_keeps_tight_window_hint():
    plan = plan_investigation("3f2504e0-4f89-11d3-9a0c-0305e82c3301", None, [], TopologyFile())
    assert plan.is_async_shaped is False
    assert plan.suggested_window_hint == SYNC_WINDOW_HINT


def test_classifies_32_digit_decimal_string_as_w3c_trace():
    # Pins current behaviour: _DECIMAL is bounded to {6,20} digits, so a
    # 32-character all-decimal string can only match _W3C_TRACE (digits are
    # legal hex). This would fail if _DECIMAL's bound were ever widened
    # toward 32 without preserving the _W3C_TRACE-before-_DECIMAL order.
    plan = plan_investigation("1" * 32, None, [], TopologyFile())
    assert plan.identifier_kind == "w3c_trace"


def test_next_steps_mention_correlate_ids_handoff():
    plan = plan_investigation("sess_abc123XYZ", None, _adapters(), TopologyFile())
    assert any("correlate_ids" in step for step in plan.next_steps)


def test_environment_echoed_into_next_steps_when_given():
    plan = plan_investigation("sess_abc123XYZ", "staging", _adapters(), TopologyFile())
    assert any("staging" in step for step in plan.next_steps)


def test_environment_missing_prompts_for_it():
    plan = plan_investigation("sess_abc123XYZ", None, _adapters(), TopologyFile())
    assert any("environment" in step.lower() for step in plan.next_steps)
