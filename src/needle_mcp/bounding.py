from __future__ import annotations
import json
from typing import Any

DEFAULT_MAX_CHARS = 12000


def bound_json(data: Any, max_chars: int = DEFAULT_MAX_CHARS) -> tuple[str, bool]:
    """Serialize data to JSON, applying tiered truncation if it exceeds max_chars.

    Tier 1: return as-is if it already fits.
    Tier 2: if the payload is dict-shaped with a "rows" list, drop rows from
    the end until it fits, and set truncated=True with an explanatory note —
    this is the shape query_generic_source and similar tools return.
    Tier 3: otherwise, hard-truncate the serialized text and append a
    directive note telling the caller to narrow the query.
    """
    text = json.dumps(data, default=str)
    if len(text) <= max_chars:
        return text, False

    if isinstance(data, dict) and isinstance(data.get("rows"), list):
        rows = data["rows"]
        remaining = dict(data)
        remaining["truncated"] = True
        # Reserve the note's cost BEFORE packing rows, so the final serialization
        # already fits and is never sliced mid-token (slicing produced invalid JSON).
        remaining["_truncation_note"] = (
            f"Response truncated from {len(rows)} rows to stay under {max_chars} "
            f"chars. Narrow the query (smaller time_range, more specific filter) "
            f"rather than treating this count as complete."
        )
        kept: list[Any] = []
        for row in rows:
            trial = dict(remaining)
            trial["rows"] = kept + [row]
            if len(json.dumps(trial, default=str)) > max_chars:
                break
            kept.append(row)
        remaining["rows"] = kept
        return json.dumps(remaining, default=str), True

    note = (
        f'..."_truncation_note": "Response hard-truncated at {max_chars} '
        'chars. Narrow the query and retry."'
    )
    return text[: max_chars - len(note)] + note, True
