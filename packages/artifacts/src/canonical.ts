/**
 * Canonical JSON (RFC 8785 / JCS subset): object keys sorted by UTF-16 code unit, no
 * whitespace, ECMAScript number formatting. The same value always yields the same bytes,
 * so hashes of JSON are stable across machines, runtimes and key insertion order.
 */

export function canonicalJson(value: unknown): string {
  return write(value, 0);
}

const MAX_DEPTH = 64;

function write(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError("canonicalJson: value nested too deeply");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      // -0 and 0 must hash identically.
      return JSON.stringify(value === 0 ? 0 : value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => write(v, depth + 1)).join(",")}]`;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError("canonicalJson: only plain objects and arrays are allowed");
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${write(v, depth + 1)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}
