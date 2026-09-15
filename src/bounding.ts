export const DEFAULT_MAX_CHARS = 12000;

/**
 * JSON.stringify replacer standing in for Python's `json.dumps(default=str)`:
 * values JSON cannot represent are stringified rather than throwing (BigInt) or
 * vanishing (undefined, functions), so bounding never loses a row silently.
 */
function serializeSafe(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (typeof val === "bigint") return val.toString();
    if (typeof val === "function" || typeof val === "symbol") return String(val);
    if (typeof val === "undefined") return null;
    return val;
  });
}

function isRowsShaped(data: unknown): data is Record<string, unknown> & { rows: unknown[] } {
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    Array.isArray((data as Record<string, unknown>).rows)
  );
}

/**
 * Serialize data to JSON, applying tiered truncation if it exceeds maxChars.
 *
 * Tier 1: return as-is if it already fits.
 * Tier 2: if the payload is dict-shaped with a "rows" list, drop rows from the
 * end until it fits, and set truncated=true with an explanatory note — this is
 * the shape queryGenericSource and similar tools return.
 * Tier 3: otherwise, hard-truncate the serialized text and append a directive
 * note telling the caller to narrow the query.
 *
 * NOTE (deliberate difference from the Python original): JSON.stringify emits
 * compact separators (`,` / `:`) where Python's json.dumps defaults to `, ` /
 * `: `. The same data therefore serializes a few percent shorter here and a few
 * more rows survive the same maxChars. The bound exists to protect the host's
 * context window, so fitting more real rows into the same budget is the
 * intended direction; only the exact row count at the boundary differs.
 */
export function boundJson(
  data: unknown,
  maxChars: number = DEFAULT_MAX_CHARS,
): [string, boolean] {
  const text = serializeSafe(data);
  if (text.length <= maxChars) {
    return [text, false];
  }

  if (isRowsShaped(data)) {
    const rows = data.rows;
    const remaining: Record<string, unknown> = { ...data };
    remaining.truncated = true;
    // Reserve the note's cost BEFORE packing rows, so the final serialization
    // already fits and is never sliced mid-token (slicing produced invalid JSON).
    remaining._truncation_note =
      `Response truncated from ${rows.length} rows to stay under ${maxChars} ` +
      "chars. Narrow the query (smaller time_range, more specific filter) " +
      "rather than treating this count as complete.";

    const kept: unknown[] = [];
    for (const row of rows) {
      const trial = { ...remaining, rows: [...kept, row] };
      if (serializeSafe(trial).length > maxChars) break;
      kept.push(row);
    }
    remaining.rows = kept;
    return [serializeSafe(remaining), true];
  }

  const note =
    `..."_truncation_note": "Response hard-truncated at ${maxChars} ` +
    'chars. Narrow the query and retry."';
  return [text.slice(0, maxChars - note.length) + note, true];
}
