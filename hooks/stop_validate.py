#!/usr/bin/env python3
"""Claude Code Stop hook: validates the just-finished turn's RCA envelope
against rcanalyst's validate_rca gates before allowing the session to stop.

Input: JSON on stdin per Claude Code's Stop hook contract. Prefers
`last_assistant_message`; falls back to walking `transcript_path` (that file is
written asynchronously and can lag the current turn, so it is the fallback, not
the primary source).
Output: on a blocking gap, prints {"decision": "block", "reason": "..."} to
stdout. If no RCA envelope is present in the last assistant turn at all, this
hook does not block — an ordinary non-RCA turn is not forced to emit one.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from rcanalyst.tools.validate_rca import validate_rca  # noqa: E402

# Match the fenced block first, then parse what's inside it. A single regex that
# also had to match balanced JSON would silently fail to match malformed JSON —
# which is exactly the case that most needs to be reported.
BLOCK_PATTERN = re.compile(
    r"BEGIN_RCANALYST_RESULT_JSON(.*?)END_RCANALYST_RESULT_JSON", re.DOTALL
)


def _last_assistant_text(transcript_path: str) -> str | None:
    try:
        lines = Path(transcript_path).read_text().splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") == "assistant":
            content = entry.get("message", {}).get("content", [])
            texts = [c.get("text", "") for c in content if c.get("type") == "text"]
            if texts:
                return "\n".join(texts)
    return None


def main() -> None:
    raw_stdin = sys.stdin.read() or "{}"
    payload = json.loads(raw_stdin)

    # Without this guard, a blocking verdict re-triggers this hook forever.
    if payload.get("stop_hook_active"):
        return

    text = payload.get("last_assistant_message")
    if not text:
        transcript_path = payload.get("transcript_path")
        text = _last_assistant_text(transcript_path) if transcript_path else None
    if not text:
        return

    match = BLOCK_PATTERN.search(text)
    if not match:
        return

    try:
        claim_json = json.loads(match.group(1).strip())
    except json.JSONDecodeError:
        print(json.dumps({
            "decision": "block",
            "reason": "RCA result block is present but is not valid JSON. Fix and re-emit it.",
        }))
        return

    result = validate_rca(claim_json, investigation_log=[])
    if not result.approved:
        reasons = "; ".join(f"[{g.name}] {g.detail}" for g in result.gaps if g.severity == "blocking")
        print(json.dumps({"decision": "block", "reason": f"validate_rca rejected this RCA: {reasons}"}))


if __name__ == "__main__":
    main()
