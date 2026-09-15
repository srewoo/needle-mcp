from needle_mcp.config import AdapterConfig, SurfaceCoverage, TopologyFile
from needle_mcp.tools.correlate_ids import KEY_PATTERNS
from needle_mcp.tools.plan_investigation import (
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


# --- likely_key_names actually filters (I6) -----------------------------------
#
# The field previously returned every key in KEY_PATTERNS for every identifier:
# ASYNC_KEYS is a strict SUBSET of KEY_PATTERNS, so both arms of the is_async
# conditional produced the identical list. Nothing was "likely" about it.


def _plan_for(identifier: str):
    return plan_investigation(
        identifier=identifier, environment="prod", adapters=[], topology=TopologyFile(),
    )


def test_uuid_is_not_offered_datadog_or_traceparent_specific_keys():
    """A dashed UUID cannot be written as a decimal Datadog trace id or as a
    traceparent's fixed 00-<32hex>-<16hex>-<2hex> string."""
    plan = _plan_for("6f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8")
    assert plan.identifier_kind == "uuid"
    assert "x-datadog-trace-id" not in plan.likely_key_names
    assert "traceparent" not in plan.likely_key_names
    assert "x-amzn-trace-id" not in plan.likely_key_names
    assert "x-request-id" in plan.likely_key_names


def test_likely_key_names_differ_across_identifier_kinds():
    """The point of the field: the same list for every id is no signal at all."""
    uuid_keys = set(_plan_for("6f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8").likely_key_names)
    w3c_keys = set(_plan_for("4bf92f3577b34da6a3ce929d0e0e4736").likely_key_names)
    xray_keys = set(_plan_for("1-5759e988-bd862e3fe1be46a994272793").likely_key_names)
    assert uuid_keys != w3c_keys != xray_keys
    assert "traceparent" in w3c_keys
    assert "x-amzn-trace-id" in xray_keys
    assert "traceparent" not in xray_keys


def test_datadog_decimal_trace_gets_the_datadog_key():
    plan = _plan_for("13088165645273925280")
    assert plan.identifier_kind == "datadog_decimal_trace"
    assert "x-datadog-trace-id" in plan.likely_key_names


def test_opaque_identifier_is_not_narrowed():
    """Shape tells us nothing, so narrowing would be a guess dressed as fact."""
    plan = _plan_for("sess_ABCdef")
    assert plan.identifier_kind == "opaque"
    assert set(plan.likely_key_names) >= {"x-request-id", "traceparent", "x-datadog-trace-id"}


def test_async_shaped_identifier_gains_the_async_keys():
    plan = _plan_for("msg-6f0a1b2c3d4e")
    assert plan.is_async_shaped is True
    assert {"message_id", "job_id"} <= set(plan.likely_key_names)


def test_non_async_identifier_is_not_offered_the_async_only_keys():
    plan = _plan_for("6f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8")
    assert plan.is_async_shaped is False
    assert "message_id" not in plan.likely_key_names
    assert "job_id" not in plan.likely_key_names


def test_likely_key_names_never_name_a_key_correlate_ids_cannot_extract():
    for identifier in ("6f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8",
                       "4bf92f3577b34da6a3ce929d0e0e4736",
                       "1-5759e988-bd862e3fe1be46a994272793",
                       "13088165645273925280", "sess_ABCdef", "msg-abc123"):
        plan = _plan_for(identifier)
        assert set(plan.likely_key_names) <= set(KEY_PATTERNS.keys())
        assert plan.likely_key_names, identifier
