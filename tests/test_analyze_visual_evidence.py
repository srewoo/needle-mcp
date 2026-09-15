import json
from rcanalyst.tools import analyze_visual_evidence as ave
from rcanalyst.tools.analyze_visual_evidence import analyze_visual_evidence

SAMPLE_HAR = {
    "log": {
        "entries": [
            {
                "request": {
                    "method": "GET",
                    "url": "https://api.example.com/checkout?token=SECRET123",
                    "headers": [
                        {"name": "x-request-id", "value": "req-abc123"},
                        {"name": "Authorization", "value": "Bearer super-secret-token"},
                        {"name": "Cookie", "value": "session=leak-me"},
                        {"name": "X-Custom-Internal", "value": "not-allowlisted"},
                    ],
                },
                "response": {"status": 500},
                "time": 1500,
            },
            {
                "request": {"method": "GET", "url": "https://api.example.com/ping", "headers": []},
                "response": {"status": 200},
                "time": 20,
            },
        ]
    }
}


def test_har_json_keeps_only_failed_and_slow_entries():
    result = analyze_visual_evidence(context="checkout failure", har_json=json.dumps(SAMPLE_HAR))
    assert len(result.har_entries) == 1
    assert result.har_entries[0].status == 500
    assert result.har_dropped_count == 1


def test_har_json_redacts_url_query_string():
    result = analyze_visual_evidence(context="x", har_json=json.dumps(SAMPLE_HAR))
    assert "SECRET123" not in result.har_entries[0].url
    assert result.har_entries[0].url == "https://api.example.com/checkout"


def test_har_json_never_returns_auth_or_cookie_headers():
    result = analyze_visual_evidence(context="x", har_json=json.dumps(SAMPLE_HAR))
    headers = result.har_entries[0].correlation_headers
    assert "Authorization" not in headers
    assert "Cookie" not in headers


def test_har_json_drops_non_allowlisted_headers():
    result = analyze_visual_evidence(context="x", har_json=json.dumps(SAMPLE_HAR))
    headers = result.har_entries[0].correlation_headers
    assert "X-Custom-Internal" not in headers


def test_har_json_keeps_correlation_header():
    result = analyze_visual_evidence(context="x", har_json=json.dumps(SAMPLE_HAR))
    headers = result.har_entries[0].correlation_headers
    assert headers.get("x-request-id") == "req-abc123"


def test_har_path_reads_from_file(tmp_path):
    p = tmp_path / "sample.har"
    p.write_text(json.dumps(SAMPLE_HAR))
    result = analyze_visual_evidence(context="x", har_path=str(p))
    assert len(result.har_entries) == 1


def test_image_base64_passed_through_with_note():
    result = analyze_visual_evidence(context="x", image_base64="ZmFrZWJhc2U2NA==")
    assert result.image_passthrough == "ZmFrZWJhc2U2NA=="
    assert any("multimodal" in n for n in result.notes)


def test_no_input_returns_empty_result():
    result = analyze_visual_evidence(context="x")
    assert result.har_entries == []
    assert result.image_passthrough is None


def test_mixed_case_correlation_header_is_normalized():
    har = {
        "log": {
            "entries": [
                {
                    "request": {
                        "method": "GET",
                        "url": "https://api.example.com/x",
                        "headers": [{"name": "X-Request-Id", "value": "req-mixed"}],
                    },
                    "response": {"status": 500},
                    "time": 10,
                }
            ]
        }
    }
    result = analyze_visual_evidence(context="x", har_json=json.dumps(har))
    assert result.har_entries[0].correlation_headers.get("x-request-id") == "req-mixed"


def test_string_time_does_not_crash():
    har = {
        "log": {
            "entries": [
                {
                    "request": {"method": "GET", "url": "https://api.example.com/a", "headers": []},
                    "response": {"status": 200},
                    "time": "1500",
                }
            ]
        }
    }
    result = analyze_visual_evidence(context="x", har_json=json.dumps(har))
    assert len(result.har_entries) == 1


def test_null_time_does_not_crash():
    har = {
        "log": {
            "entries": [
                {
                    "request": {"method": "GET", "url": "https://api.example.com/a", "headers": []},
                    "response": {"status": 500},
                    "time": None,
                }
            ]
        }
    }
    result = analyze_visual_evidence(context="x", har_json=json.dumps(har))
    assert len(result.har_entries) == 1
    assert result.har_entries[0].time_ms == 0


def test_string_status_does_not_crash():
    har = {
        "log": {
            "entries": [
                {
                    "request": {"method": "GET", "url": "https://api.example.com/a", "headers": []},
                    "response": {"status": "500"},
                    "time": 100,
                }
            ]
        }
    }
    result = analyze_visual_evidence(context="x", har_json=json.dumps(har))
    assert len(result.har_entries) == 1
    assert result.har_entries[0].status == 500


def test_header_missing_value_does_not_crash():
    har = {
        "log": {
            "entries": [
                {
                    "request": {
                        "method": "GET",
                        "url": "https://api.example.com/a",
                        "headers": [{"name": "x-request-id"}],
                    },
                    "response": {"status": 500},
                    "time": 10,
                }
            ]
        }
    }
    result = analyze_visual_evidence(context="x", har_json=json.dumps(har))
    assert result.har_entries[0].correlation_headers.get("x-request-id") == ""


def test_header_missing_name_does_not_crash():
    har = {
        "log": {
            "entries": [
                {
                    "request": {
                        "method": "GET",
                        "url": "https://api.example.com/a",
                        "headers": [{"value": "orphan-value"}],
                    },
                    "response": {"status": 500},
                    "time": 10,
                }
            ]
        }
    }
    result = analyze_visual_evidence(context="x", har_json=json.dumps(har))
    assert "orphan-value" not in result.har_entries[0].correlation_headers.values()


def test_entry_missing_request_does_not_crash():
    har = {"log": {"entries": [{"response": {"status": 500}, "time": 10}]}}
    result = analyze_visual_evidence(context="x", har_json=json.dumps(har))
    assert len(result.har_entries) == 1
    assert result.har_entries[0].method == "?"


def test_entry_missing_response_does_not_crash():
    har = {
        "log": {
            "entries": [
                {
                    "request": {"method": "GET", "url": "https://api.example.com/a", "headers": []},
                    "time": 1500,
                }
            ]
        }
    }
    result = analyze_visual_evidence(context="x", har_json=json.dumps(har))
    assert len(result.har_entries) == 1
    assert result.har_entries[0].status == 0


# --- Wall-clock anchor (I1) ---------------------------------------------------
#
# time_ms is a DURATION. Without startedDateTime the HAR entry point is the one
# flow that cannot supply the alert_window validate_rca then requires every
# evidence row to sit inside.


def _har_with(started):
    return {"log": {"entries": [{
        "request": {"method": "GET", "url": "https://api.example.com/x", "headers": []},
        "response": {"status": 500}, "time": 10, "startedDateTime": started,
    }]}}


def test_har_entry_carries_the_started_datetime_as_timestamp():
    result = analyze_visual_evidence(
        context="x", har_json=json.dumps(_har_with("2026-09-15T10:00:00.000Z"))
    )
    assert result.har_entries[0].timestamp == "2026-09-15T10:00:00.000Z"


def test_har_entry_timestamp_is_none_when_startedDateTime_is_absent():
    entry = {"request": {"method": "GET", "url": "https://a.example.com/x", "headers": []},
             "response": {"status": 500}, "time": 10}
    result = analyze_visual_evidence(context="x", har_json=json.dumps({"log": {"entries": [entry]}}))
    assert result.har_entries[0].timestamp is None


def test_har_entry_timestamp_tolerates_a_malformed_startedDateTime():
    """A non-string value must not raise — this parser guards malformed HARs
    everywhere else and this field is no exception."""
    for bad in (12345, [], {}, None, ""):
        result = analyze_visual_evidence(context="x", har_json=json.dumps(_har_with(bad)))
        assert result.har_entries[0].timestamp is None


# --- Structured failure instead of a raw MCP tool error (I2) ------------------
#
# Every other tool in this server returns a structured result on failure.
# _load_har used to let OSError/JSONDecodeError escape, so a mistyped path or a
# truncated export surfaced to the host as a raw tool error with no guidance.


def test_missing_har_path_returns_a_note_not_an_exception():
    result = analyze_visual_evidence(context="x", har_path="/nonexistent/does-not-exist.har")
    assert result.har_entries == []
    assert any("does-not-exist.har" in n for n in result.notes)


def test_malformed_har_json_returns_a_note_not_an_exception():
    result = analyze_visual_evidence(context="x", har_json='{"log": {"entries": [')
    assert result.har_entries == []
    assert any("not valid JSON" in n for n in result.notes)


def test_malformed_har_file_returns_a_note_not_an_exception(tmp_path):
    bad = tmp_path / "truncated.har"
    bad.write_text('{"log": {"entries": [')
    result = analyze_visual_evidence(context="x", har_path=str(bad))
    assert result.har_entries == []
    assert any("not valid JSON" in n for n in result.notes)


def test_oversized_har_file_is_refused_with_a_note(tmp_path, monkeypatch):
    monkeypatch.setattr(ave, "MAX_HAR_FILE_BYTES", 10)
    big = tmp_path / "big.har"
    big.write_text(json.dumps(SAMPLE_HAR))
    result = analyze_visual_evidence(context="x", har_path=str(big))
    assert result.har_entries == []
    assert any("byte cap" in n for n in result.notes)


def test_oversized_har_cap_is_generous_enough_for_a_real_export():
    """Spec §4 anticipates 5-50MB HAR exports; the cap must not undercut that."""
    assert ave.MAX_HAR_FILE_BYTES >= 50 * 1000 * 1000


def test_har_input_that_is_not_an_object_returns_a_note():
    result = analyze_visual_evidence(context="x", har_json="[1, 2, 3]")
    assert result.har_entries == []
    assert any("not a HAR document" in n for n in result.notes)


def test_context_is_optional():
    """SKILL.md and README both document calls that omit `context`; it is never
    read by this tool, so requiring it turned those documented calls into
    errors."""
    result = analyze_visual_evidence(har_json=json.dumps(SAMPLE_HAR))
    assert len(result.har_entries) == 1
