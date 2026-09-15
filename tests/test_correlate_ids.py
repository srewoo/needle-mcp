from needle_mcp.tools.correlate_ids import correlate_ids


def test_extracts_named_key_request_id():
    snippets = ['2026-09-15T10:00:00Z ERROR x-request-id=req-abc123 checkout failed']
    result = correlate_ids(snippets)
    assert len(result.candidates) == 1
    assert result.candidates[0].value == "req-abc123"
    assert result.candidates[0].key_name == "x-request-id"


def test_denylists_all_zero_uuid():
    """An all-zero trace id means propagation broke; querying on it returns the
    whole fleet, which reads as a broad incident. It must never be a candidate."""
    snippets = ['trace_id=00000000-0000-0000-0000-000000000000 request failed']
    result = correlate_ids(snippets)
    assert result.candidates == []


def test_short_non_discriminative_values_never_match():
    """'0'/'null' fall below the {6,} length floor, so they never reach DENYLIST."""
    snippets = ['trace_id=0 request failed', 'trace_id=null also failed']
    result = correlate_ids(snippets)
    assert result.candidates == []


def test_cross_snippet_co_occurrence_ranks_high():
    snippets = [
        '2026-09-15T10:00:00Z x-request-id=req-abc123 svc=checkout',
        '2026-09-15T10:00:01Z x-request-id=req-abc123 svc=payment',
    ]
    result = correlate_ids(snippets)
    assert len(result.candidates) == 1
    c = result.candidates[0]
    assert c.confidence == "high"
    assert set(c.seen_in_snippets) == {0, 1}


def test_single_occurrence_ranks_medium():
    snippets = ['x-request-id=req-xyz999 svc=checkout']
    result = correlate_ids(snippets)
    assert result.candidates[0].confidence == "medium"


def test_async_key_gets_forward_widened_window():
    snippets = ['2026-09-15T10:00:00Z message_id=msg-777 published to topic orders']
    result = correlate_ids(snippets)
    c = result.candidates[0]
    assert c.key_name == "message_id"
    assert c.suggested_window is not None
    start, end = c.suggested_window
    assert start < "2026-09-15T10:00:00"
    assert end > "2026-09-15T11:00:00"[:19]  # end is at least ~60 min after


def test_sync_key_gets_tight_symmetric_window():
    snippets = ['2026-09-15T10:00:00Z trace_id=abc123def456 svc=checkout']
    result = correlate_ids(snippets)
    c = result.candidates[0]
    start, end = c.suggested_window
    assert start < "2026-09-15T10:00:00"
    assert end > "2026-09-15T10:00:00"


def test_equivalent_forms_includes_hex_for_numeric_trace_id():
    """Datadog writes a trace id in decimal; W3C traceparent writes the same id in
    hex. Without this conversion the two spellings never intersect."""
    snippets = ['x-datadog-trace-id=4823516278365812 svc=checkout']
    result = correlate_ids(snippets)
    c = result.candidates[0]
    assert format(4823516278365812, "x") in c.equivalent_forms
    assert format(4823516278365812, "032x") in c.equivalent_forms


def test_no_matches_returns_empty_candidates():
    result = correlate_ids(["just a plain log line with no ids"])
    assert result.candidates == []
