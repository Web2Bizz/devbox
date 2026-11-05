/** Frontmatter keys that must be normalized to the camelCase form. */
const KEY_ALIASES: Record<string, string> = {
  'allowed-tools': 'allowedTools',
};

/**
 * Parses the leading `---` block of a SKILL.md.
 *
 * Deliberately tiny YAML: `key: value`, inline lists (`[a, b]`) and block lists
 * (`- item`). Skills are repository artifacts pinned by commit, so a full YAML
 * parser would add a dependency without adding safety — anything richer is a
 * malformed skill and must fail loudly.
 */
export function parseFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error('SKILL.md must start with frontmatter');
  return {
    meta: parseHeader(match[1] ?? ''),
    body: match[2] ?? '',
  };
}

function parseHeader(header: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  let listKey: string | null = null;

  for (const line of header.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && listKey) {
      const entries = Array.isArray(meta[listKey]) ? (meta[listKey] as Array<unknown>) : [];
      entries.push(unquote((listItem[1] ?? '').trim()));
      meta[listKey] = entries;
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = normalizeKey(pair[1] ?? '');
    const value = (pair[2] ?? '').trim();

    if (value.length === 0) {
      // `allowed-tools:` with no inline value opens a block list.
      listKey = key;
      meta[key] = [];
      continue;
    }

    listKey = null;
    meta[key] = parseScalar(value);
  }

  return meta;
}

function normalizeKey(key: string): string {
  return KEY_ALIASES[key] ?? key;
}

function parseScalar(value: string): unknown {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((entry) => unquote(entry.trim()))
      .filter((entry) => entry.length > 0);
  }
  return unquote(value);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
