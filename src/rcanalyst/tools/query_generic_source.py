from __future__ import annotations
import base64
import json
import os
import urllib.error
import urllib.request
from rcanalyst.bounding import bound_json
from rcanalyst.config import AdapterConfig, resolve_adapter_credential
from rcanalyst.models import GenericQueryResult, TimeRange
from rcanalyst.security import (
    assert_host_allowed, safe_encode_param, assert_url_structure_unchanged,
    HostNotAllowedError,
)

MAX_RESPONSE_BYTES = 2_000_000
REQUEST_TIMEOUT_SECONDS = 15


class _AllowlistRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Blocks an off-allowlist redirect BEFORE the new host is contacted.
    Checking response.geturl() after the fact is too late — the request has
    already been sent to the redirect target."""

    def __init__(self, allowed_hosts: list[str]) -> None:
        self.allowed_hosts = allowed_hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        assert_host_allowed(newurl, self.allowed_hosts)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _build_url(adapter: AdapterConfig, params: dict, time_range: TimeRange, cursor: str | None) -> str:
    substitutions = {"start": time_range.start, "end": time_range.end}
    for key, value in params.items():
        substitutions[key] = safe_encode_param(str(value))
    path = adapter.query_template.format(**substitutions)
    url = adapter.base_url.rstrip("/") + path
    if cursor and adapter.pagination_cursor_param:
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}{adapter.pagination_cursor_param}={safe_encode_param(cursor)}"
    return url


def _build_headers(adapter: AdapterConfig) -> dict[str, str]:
    headers: dict[str, str] = {}
    if adapter.auth_mode == "static_header":
        value = resolve_adapter_credential(adapter)
        headers[adapter.header_name or "Authorization"] = value or ""
    elif adapter.auth_mode == "basic":
        user = os.environ.get(adapter.basic_user_env_var or "", "")
        pw = os.environ.get(adapter.basic_pass_env_var or "", "")
        token = base64.b64encode(f"{user}:{pw}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    return headers


def _extract_rows(payload: dict, response_path: str | None) -> list[dict]:
    if not response_path:
        return payload if isinstance(payload, list) else payload.get("rows", [])
    node: object = payload
    for part in response_path.split("."):
        if isinstance(node, dict):
            node = node.get(part, [])
        else:
            return []
    return node if isinstance(node, list) else []


def query_generic_source(
    adapter: AdapterConfig,
    params: dict,
    time_range: TimeRange,
    allowed_hosts: list[str],
    cursor: str | None = None,
) -> GenericQueryResult:
    try:
        assert_host_allowed(adapter.base_url, allowed_hosts)
        url = _build_url(adapter, params, time_range, cursor)
        assert_url_structure_unchanged(url, adapter.base_url)
        headers = _build_headers(adapter)
        opener = urllib.request.build_opener(_AllowlistRedirectHandler(allowed_hosts))
        request = urllib.request.Request(url, headers=headers)
        with opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except HostNotAllowedError as e:
        return GenericQueryResult(rows=[], truncated=False, returned_count=0, error=str(e))
    except (KeyError, IndexError) as e:
        return GenericQueryResult(
            rows=[], truncated=False, returned_count=0,
            error=(
                f"query_template placeholder not satisfied: {e}. Every {{name}} in the "
                "template must be supplied in params (literal braces must be doubled)."
            ),
        )
    except ValueError as e:
        return GenericQueryResult(rows=[], truncated=False, returned_count=0, error=f"Rejected param: {e}")
    except urllib.error.URLError as e:
        return GenericQueryResult(rows=[], truncated=False, returned_count=0, error=f"query_generic_source failed: {e}")

    if len(raw) > MAX_RESPONSE_BYTES:
        return GenericQueryResult(
            rows=[], truncated=True, returned_count=0,
            error=f"Response exceeded {MAX_RESPONSE_BYTES} byte cap before parsing; narrow the query.",
        )

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        return GenericQueryResult(rows=[], truncated=False, returned_count=0, error=f"Non-JSON response: {e}")

    rows = _extract_rows(payload, adapter.response_path)
    next_cursor = payload.get(adapter.pagination_cursor_field) if adapter.pagination_cursor_field else None
    row_truncated = len(rows) > adapter.max_rows_per_call or bool(next_cursor)
    capped = rows[: adapter.max_rows_per_call]

    # A row cap alone is not enough — a handful of very large rows can still blow
    # the host's context, so apply the character bound too.
    bounded_text, char_truncated = bound_json({
        "rows": capped, "truncated": row_truncated, "returned_count": len(capped),
    })
    bounded = json.loads(bounded_text)

    return GenericQueryResult(
        rows=bounded["rows"],
        truncated=row_truncated or char_truncated,
        returned_count=len(bounded["rows"]),
        next_cursor=next_cursor,
    )


def list_generic_sources(adapters: list[AdapterConfig]) -> list[dict]:
    return [
        {
            "name": a.name,
            "base_url_host": a.base_url.split("://")[-1].split("/")[0],
            "auth_mode": a.auth_mode,
            "covers": a.covers,
        }
        for a in adapters
    ]
