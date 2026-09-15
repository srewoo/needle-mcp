/**
 * Minimal stand-in for Python's `str.format(**kwargs)`, covering exactly the
 * subset `query_template` uses: `{name}` placeholders and `{{` / `}}` for
 * literal braces.
 *
 * Exists because query templates are user config carried over verbatim from the
 * Python implementation — reusing their syntax means an existing adapters.yaml
 * keeps working untouched.
 */
export class MissingPlaceholderError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`'${key}'`);
    this.name = "MissingPlaceholderError";
    this.key = key;
  }
}

export function formatTemplate(
  template: string,
  substitutions: Readonly<Record<string, string>>,
): string {
  let out = "";
  let i = 0;

  while (i < template.length) {
    const char = template[i];

    if (char === "{") {
      if (template[i + 1] === "{") {
        out += "{";
        i += 2;
        continue;
      }
      const close = template.indexOf("}", i + 1);
      if (close === -1) {
        throw new SyntaxError("Single '{' encountered in format string");
      }
      const key = template.slice(i + 1, close);
      if (!Object.prototype.hasOwnProperty.call(substitutions, key)) {
        throw new MissingPlaceholderError(key);
      }
      out += substitutions[key];
      i = close + 1;
      continue;
    }

    if (char === "}") {
      if (template[i + 1] === "}") {
        out += "}";
        i += 2;
        continue;
      }
      throw new SyntaxError("Single '}' encountered in format string");
    }

    out += char;
    i += 1;
  }

  return out;
}
