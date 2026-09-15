import json
from rcanalyst.bounding import bound_json, DEFAULT_MAX_CHARS


def test_small_payload_not_truncated():
    data = {"rows": [{"a": 1}], "truncated": False, "returned_count": 1}
    text, truncated = bound_json(data)
    assert truncated is False
    assert json.loads(text) == data


def test_rows_payload_truncates_by_dropping_rows():
    rows = [{"line": "x" * 100, "i": i} for i in range(500)]
    data = {"rows": rows, "truncated": False, "returned_count": 500}
    text, truncated = bound_json(data, max_chars=2000)
    assert truncated is True
    assert len(text) <= 2000
    parsed = json.loads(text)
    assert parsed["truncated"] is True
    assert len(parsed["rows"]) < 500
    assert "_truncation_note" in parsed


def test_non_rows_payload_hard_truncates_with_note():
    data = {"blob": "y" * 20000}
    text, truncated = bound_json(data, max_chars=1000)
    assert truncated is True
    assert len(text) <= 1000 + 5  # small buffer for the closing quote in the appended note
    assert "_truncation_note" in text or "truncation" in text.lower()


def test_default_max_chars_is_12000():
    assert DEFAULT_MAX_CHARS == 12000
