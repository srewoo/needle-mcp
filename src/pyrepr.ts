/**
 * Python-style `repr` for the small value shapes that appear inside
 * validateRca gap details.
 *
 * These strings are operator-facing and are surfaced verbatim by the Stop hook,
 * so they are reproduced exactly as the Python implementation emitted them —
 * single-quoted, `, `-separated — rather than as JSON. Keeping them identical
 * means existing runbooks, tests and log greps still match.
 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return String(value);
}

/**
 * Python's `type(x).__name__` for the types that reach a gap detail. Kept so
 * "must be of type list, got dict" reads the same as it always has.
 */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  switch (typeof value) {
    case "string":
      return "str";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    case "object":
      return "dict";
    default:
      return typeof value;
  }
}

/** Python `sorted()` over strings: code-point order, matching ASCII sort. */
export function pySorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
