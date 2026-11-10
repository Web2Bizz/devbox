/**
 * Minimal glob matcher: `**` crosses path separators, `*`/`?` stay inside one
 * segment. A pattern without `/` matches the basename (files anywhere).
 */
export function matchGlob(pattern: string, relative: string): boolean {
  const normalized: string = pattern.replace(/^\.\//, '');
  const target: string = normalized.includes('/')
    ? relative
    : relative.slice(relative.lastIndexOf('/') + 1);
  const source: RegExp = globToRegExp(normalized);
  return source.test(target);
}

function globToRegExp(pattern: string): RegExp {
  let output: string = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char: string = pattern[index] as string;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          output += '(?:.*/)?';
        } else {
          output += '.*';
        }
      } else {
        output += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      output += '[^/]';
      continue;
    }
    if ('\\^$+?.()|{}[]'.includes(char)) {
      output += `\\${char}`;
      continue;
    }
    output += char;
  }
  return new RegExp(`^${output}$`);
}
