/**
 * Deterministic JSON (sorted object keys, recursive) for content hashes.
 * Postgres jsonb reorders object keys on read, so hashing JSON.stringify
 * directly would produce a different digest after a round-trip.
 * Arrays keep order; primitives pass through; Date → ISO-8601.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) return encode(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return encode(value);
    case 'bigint':
      return encode(value.toString());
    case 'object': {
      const objectValue: Record<string, unknown> = value as Record<string, unknown>;
      const entries: Array<string> = Object.keys(objectValue)
        .sort()
        .filter((key) => objectValue[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key])}`);
      return `{${entries.join(',')}}`;
    }
    default:
      // undefined / function / symbol — keep the output a string so callers
      // can always hash it; the array branch maps undefined to null too.
      return encode(value);
  }
}

/** JSON.stringify with a guaranteed string result (undefined → 'null'). */
function encode(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}
