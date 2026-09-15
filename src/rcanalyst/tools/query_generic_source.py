from __future__ import annotations
import base64
import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlparse
from rcanalyst.bounding import bound_json
from rcanalyst.config import AdapterConfig, MissingCredentialError, resolve_adapter_credential
from rcanalyst.models import GenericQueryResult, SourceInfo, TimeRange
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
    # start/end are model-supplied tool arguments (Task 10 passes them straight
    # through), exactly as untrusted as params — encode identically. Raw
    # substitution previously let a value like "2026-09-15T00:00:00Z&admin=true"
    # inject an extra query parameter into the request actually sent, since
    # assert_url_structure_unchanged only checks urlparse().path and ignores
    # everything after '?'.
    substitutions = {
        "start": safe_encode_param(time_range.start),
        "end": safe_encode_param(time_range.end),
    }
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
        # Unset credentials used to produce Basic base64(":") — an empty
        # credential sent to the vendor, which answers 401 and leaves the
        # operator debugging the query rather than their environment. The
        # static_header path has always failed loudly on the same condition;
        # basic auth now matches it.
        for field, env_var in (
            ("basic_user_env_var", adapter.basic_user_env_var),
            ("basic_pass_env_var", adapter.basic_pass_env_var),
        ):
            if not env_var:
                raise MissingCredentialError(
                    f"Adapter '{adapter.name}' is basic auth but has no {field} configured."
                )
            if not os.environ.get(env_var):
                raise MissingCredentialError(
                    f"Env var '{env_var}' ({field}) for adapter '{adapter.name}' is not set."
                )
        user = os.environ[adapter.basic_user_env_var or ""]
        pw = os.environ[adapter.basic_pass_env_var or ""]
        token = base64.b64encode(f"{user}:{pw}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    return headers


def _extract_rows(payload: object, response_path: str | None) -> list[dict]:
    if not response_path:
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            return payload.get("rows", [])
        return []
    node: object = payload
    for part in response_path.split("."):
        if isinstance(node, dict):
            node = node.get(part, [])
        else:
            return []
    return node if isinstance(node, list) else []


def _extract_cursor(payload: object, cursor_field: str | None) -> str | None:
    if not cursor_field or not isinstance(payload, dict):
        return None
    return payload.get(cursor_field)


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
        # The redirect allowlist is scoped to THIS adapter's own host, not the
        # union of every configured adapter's host. urllib carries a request's
        # headers across a redirect, so a redirect from adapter A to adapter B's
        # host would otherwise pass the union allowlist and deliver A's
        # Authorization token to B. A legitimate adapter never needs to redirect
        # to a different vendor mid-query. The pre-request assert_host_allowed
        # above deliberately still checks the FULL allowlist: that one answers
        # "is this a configured source?", this one answers "may this request's
        # credentials travel there?" — different questions, different scopes.
        redirect_hosts = [h for h in (urlparse(adapter.base_url).hostname,) if h]
        opener = urllib.request.build_opener(_AllowlistRedirectHandler(redirect_hosts))
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
    except MissingCredentialError as e:
        # Listed BEFORE the ValueError clause it subclasses. A missing credential
        # is a deployment-environment problem, not a rejected parameter value,
        # and the old "Rejected param: ..." wording pointed operators at the
        # query instead of at their env vars.
        return GenericQueryResult(
            rows=[], truncated=False, returned_count=0,
            error=f"Adapter credential unavailable: {e}",
        )
    except ValueError as e:
        return GenericQueryResult(rows=[], truncated=False, returned_count=0, error=f"Rejected param: {e}")
    except urllib.error.URLError as e:
        return GenericQueryResult(rows=[], truncated=False, returned_count=0, error=f"query_generic_source failed: {e}")
    except Exception as e:
        # Backstop for anything not covered above — e.g. http.client.HTTPException
        # subclasses like IncompleteRead raised by response.read() on a truncated
        # connection, which is not a URLError. Errors from this tool are always a
        # structured GenericQueryResult, never a raw exception.
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
    next_cursor = _extract_cursor(payload, adapter.pagination_cursor_field)
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


def resolve_adapter(source: str, adapters: list[AdapterConfig]) -> AdapterConfig | None:
    """Look up an adapter by name from the configured list. Returns None on a
    miss so the caller can build a structured, schema-conformant error result
    rather than raising."""
    return next((a for a in adapters if a.name == source), None)


def list_generic_sources(adapters: list[AdapterConfig]) -> list[dict]:
    """Built through SourceInfo rather than a hand-rolled dict mirroring it.

    The hand-rolled version derived the host with
    `base_url.split("://")[-1].split("/")[0]`, which KEEPS the port, while
    server._allowed_hosts uses urlparse().hostname, which drops it — so the host
    this tool advertised for an adapter on a non-default port never matched the
    one actually allowlisted. One derivation now, and the model that was defined
    and tested but never used is the shape the tool returns.
    """
    return [
        SourceInfo(
            name=a.name,
            base_url_host=urlparse(a.base_url).hostname or "",
            auth_mode=a.auth_mode,
            covers=a.covers,
        ).model_dump()
        for a in adapters
    ]
