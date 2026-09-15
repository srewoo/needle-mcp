const DECIMAL_ONLY = /^\d+$/;
const HEX_ONLY = /^[0-9a-fA-F]+$/;

/**
 * Return every spelling this identifier may appear under across vendors:
 * dash-stripped, lowercased, and decimal<->hex for numeric/hex trace ids.
 *
 * Uses BigInt, not Number. A Datadog decimal trace id such as
 * 9925525482204591653 exceeds Number.MAX_SAFE_INTEGER (2^53-1), so parsing it
 * as a double silently rounds and yields a hex form that matches nothing in any
 * vendor's index — the failure mode is an empty search result, not an error,
 * which is the worst kind.
 *
 * Exported because planInvestigation reuses it in the other direction.
 */
export function normalizeIdentifier(value: string): string[] {
  const forms = new Set<string>([value, value.toLowerCase()]);
  const stripped = value.replace(/-/g, "");
  forms.add(stripped.toLowerCase());

  if (DECIMAL_ONLY.test(stripped)) {
    const asInt = BigInt(stripped);
    forms.add(asInt.toString(16));
    forms.add(asInt.toString(16).padStart(32, "0"));
  } else if (HEX_ONLY.test(stripped)) {
    const asInt = BigInt(`0x${stripped}`);
    forms.add(asInt.toString(10));
  }

  return [...forms].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
