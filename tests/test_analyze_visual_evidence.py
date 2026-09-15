import json
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
