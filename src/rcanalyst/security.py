from __future__ import annotations
from urllib.parse import urlparse, quote

DEFAULT_HEADER_ALLOWLIST = {
    "content-type", "x-request-id", "traceparent", "x-datadog-trace-id",
    "x-amzn-trace-id", "x-correlation-id", "request-id", "server-timing",
    "date", "cache-control",
}

NEVER_RETURN_HEADERS = {"authorization", "cookie", "set-cookie"}


def redact_headers(headers: dict[str, str], allowlist: set[str] | None = None) -> dict[str, str]:
    """Keep only allowlisted headers; NEVER_RETURN_HEADERS are dropped even if
    explicitly allowlisted by the caller — this is a hard floor, not a default."""
    allow = {h.lower() for h in (allowlist if allowlist is not None else DEFAULT_HEADER_ALLOWLIST)}
    out: dict[str, str] = {}
    for key, value in headers.items():
        lower = key.lower()
        if lower in NEVER_RETURN_HEADERS:
            continue
        if lower in allow:
            out[key] = value
    return out


def redact_url(url: str) -> str:
    """Strip the query string (may carry tokens/PII); keep scheme+host+path."""
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"


class HostNotAllowedError(ValueError):
    pass


def assert_host_allowed(url: str, allowed_hosts: list[str]) -> None:
    host = urlparse(url).hostname or ""
    if host not in allowed_hosts:
        raise HostNotAllowedError(
            f"Host '{host}' is not in the configured allowlist {allowed_hosts}. "
            "Add it to adapters.yaml if this is intentional."
        )


def safe_encode_param(value: str) -> str:
    """Percent-encode a param value for safe substitution into a query template.

    Deliberately does NOT reject values containing '://' or '..': searching logs
    for a URL ("https://api.example.com/checkout") or an ES range is a core RCA
    query, and quote(safe="") already renders those inert — an encoded value
    cannot escape its query-string position. Structural safety is enforced after
    the URL is built, by assert_url_structure_unchanged().
    """
    if value.startswith("//"):
        raise ValueError(
            f"Param value '{value}' starts with '//' (protocol-relative) and was rejected."
        )
    return quote(value, safe="")


def assert_url_structure_unchanged(built_url: str, base_url: str) -> None:
    """Confirm a template-built URL still points at the adapter's own host and
    did not gain a scheme/host/path-prefix change from substituted values."""
    built = urlparse(built_url)
    base = urlparse(base_url)
    if built.scheme != base.scheme or built.hostname != base.hostname or built.port != base.port:
        raise HostNotAllowedError(
            f"Built URL '{built_url}' does not match adapter base '{base_url}' "
            "in scheme/host/port; refusing to send it."
        )
    if not built.path.startswith(base.path.rstrip("/")):
        raise HostNotAllowedError(
            f"Built URL path '{built.path}' escapes the adapter's base path; refusing to send it."
        )
    if ".." in built.path.split("/"):
        raise HostNotAllowedError(
            f"Built URL path '{built.path}' contains a '..' path segment; refusing to send it."
        )
