import json
import subprocess
import sys
from pathlib import Path

HOOK_PATH = Path(__file__).parent.parent / "hooks" / "stop_validate.py"


VALID_ENVELOPE = {
    "confidence": "strong_evidence", "status": "success",
    "root_cause": "db timeout", "affected_services": ["svc"],
    "environment": "prod",
    "alert_window": {"start": "2026-09-15T10:00:00Z", "end": "2026-09-15T10:10:00Z"},
    "evidence": [
        {"timestamp": "2026-09-15T10:05:00Z", "text": "conn pool exhausted", "source_ref": "svc/db.go:1", "environment": "prod"},
        {"timestamp": "2026-09-15T10:05:01Z", "text": "500 to caller", "source_ref": "svc/handler.go:2", "environment": "prod"},
    ],
    "hop_trace": {"hop_count": 1, "stop_reason": "terminal"},
}


def _run_hook(payload: dict) -> dict:
    result = subprocess.run(
        [sys.executable, str(HOOK_PATH)], input=json.dumps(payload),
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout) if result.stdout.strip() else {}


def _fenced(envelope_text: str) -> str:
    return (
        "## RCA\nsome prose\n"
        f"BEGIN_RCANALYST_RESULT_JSON\n{envelope_text}\nEND_RCANALYST_RESULT_JSON"
    )


def test_no_envelope_does_not_block():
    out = _run_hook({"last_assistant_message": "Just a normal reply with no RCA in it."})
    assert out == {}


def test_valid_envelope_does_not_block():
    out = _run_hook({"last_assistant_message": _fenced(json.dumps(VALID_ENVELOPE))})
    assert out == {}


def test_invalid_envelope_blocks():
    bad = {"confidence": "strong_evidence", "status": "success", "root_cause": "x",
           "affected_services": ["svc"], "environment": "prod"}
    out = _run_hook({"last_assistant_message": _fenced(json.dumps(bad))})
    assert out.get("decision") == "block"
    assert "reason" in out


def test_malformed_json_envelope_blocks():
    out = _run_hook({"last_assistant_message": _fenced("{not valid json")})
    assert out.get("decision") == "block"


def test_stop_hook_active_short_circuits():
    """Without this guard a blocking hook re-fires forever."""
    bad = {"confidence": "strong_evidence"}
    out = _run_hook({
        "last_assistant_message": _fenced(json.dumps(bad)),
        "stop_hook_active": True,
    })
    assert out == {}


def test_falls_back_to_transcript_when_no_last_assistant_message(tmp_path):
    p = tmp_path / "transcript.jsonl"
    entry = {"type": "assistant", "message": {"content": [
        {"type": "text", "text": _fenced(json.dumps(VALID_ENVELOPE))}
    ]}}
    p.write_text(json.dumps(entry) + "\n")
    out = _run_hook({"transcript_path": str(p)})
    assert out == {}


def test_no_input_at_all_does_not_block():
    out = _run_hook({})
    assert out == {}


def test_malformed_non_empty_stdin_fails_open():
    """Non-empty malformed stdin (not the empty-stdin case `or "{}"` covers)
    must not raise past the top-level guard: the hook should exit 0 and
    print nothing on stdout (fail open), never crash or block."""
    result = subprocess.run(
        [sys.executable, str(HOOK_PATH)], input="not json at all",
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == ""


def test_stop_hook_active_short_circuits_with_wrapper():
    """The fail-open try/except wrapper must not change stop_hook_active
    ordering or behavior: it still short-circuits before any parsing."""
    bad = {"confidence": "strong_evidence"}
    out = _run_hook({
        "last_assistant_message": _fenced(json.dumps(bad)),
        "stop_hook_active": True,
    })
    assert out == {}
