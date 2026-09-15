import pytest
from rcanalyst.security import (
    redact_headers, redact_url, assert_host_allowed, safe_encode_param,
    assert_url_structure_unchanged, HostNotAllowedError,
    DEFAULT_HEADER_ALLOWLIST, NEVER_RETURN_HEADERS,
)


def test_redact_headers_keeps_allowlisted():
    headers = {"X-Request-Id": "abc", "Content-Type": "application/json"}
    out = redact_headers(headers)
    assert out == {"X-Request-Id": "abc", "Content-Type": "application/json"}


def test_redact_headers_drops_non_allowlisted():
    headers = {"X-Request-Id": "abc", "X-Custom-Internal": "secret-shape"}
    out = redact_headers(headers)
    assert "X-Custom-Internal" not in out
    assert out == {"X-Request-Id": "abc"}


def test_redact_headers_never_returns_auth_even_if_allowlisted():
    headers = {"Authorization": "Bearer xyz", "Cookie": "session=abc"}
    out = redact_headers(headers, allowlist={"authorization", "cookie"})
    assert out == {}


def test_redact_url_strips_query_string():
    url = "https://api.example.com/checkout?token=secret&user=alice"
    assert redact_url(url) == "https://api.example.com/checkout"


def test_assert_host_allowed_passes_for_allowed_host():
    assert_host_allowed("https://loki.example.internal/api", ["loki.example.internal"])


def test_assert_host_allowed_raises_for_disallowed_host():
    with pytest.raises(HostNotAllowedError):
        assert_host_allowed("https://evil.example.com/api", ["loki.example.internal"])


def test_safe_encode_param_encodes_normal_value():
    assert safe_encode_param("checkout service") == "checkout%20service"


def test_safe_encode_param_allows_url_valued_query():
    """Searching logs FOR a URL is a core RCA query and must not be rejected;
    encoding renders it inert in query-string position."""
    encoded = safe_encode_param("https://api.example.com/checkout")
    assert "://" not in encoded
    assert encoded == "https%3A%2F%2Fapi.example.com%2Fcheckout"


def test_safe_encode_param_allows_dots_in_range_syntax():
    """The '..' substring must NOT be rejected — ES range syntax and version
    strings contain it, and an encoded value cannot escape its query-string
    position anyway. A raise here would be the regression."""
    try:
        encoded = safe_encode_param("latency..500")
    except ValueError as e:
        pytest.fail(f"safe_encode_param must not reject '..' values, but raised: {e}")
    assert encoded == "latency..500"


def test_safe_encode_param_rejects_protocol_relative():
    with pytest.raises(ValueError):
        safe_encode_param("//attacker.com/steal")


def test_assert_url_structure_unchanged_passes_for_same_host():
    assert_url_structure_unchanged(
        "https://loki.example.internal/api/q?x=1", "https://loki.example.internal"
    )


def test_assert_url_structure_unchanged_rejects_host_swap():
    with pytest.raises(HostNotAllowedError):
        assert_url_structure_unchanged(
            "https://evil.example.com/api/q", "https://loki.example.internal"
        )


def test_assert_url_structure_unchanged_rejects_scheme_downgrade():
    with pytest.raises(HostNotAllowedError):
        assert_url_structure_unchanged(
            "http://loki.example.internal/api/q", "https://loki.example.internal"
        )
