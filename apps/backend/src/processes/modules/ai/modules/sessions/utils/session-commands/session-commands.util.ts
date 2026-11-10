/**
 * Deterministic parse/format helpers for the jailed file/shell command bridge
 * ("создай файл …", "прочитай файл …", "выполни …"). Pure functions — no
 * transport, no storage, no harness imports.
 */

/** Strip wrapping quotes/backticks and trailing sentence punctuation. */
export function cleanFileToken(rawValue: string): string {
  return rawValue
    .trim()
    .replace(/^["'`«»]+|["'`«»]+$/g, '')
    .replace(/[,.;:!?]+$/g, '')
    .trim();
}

/** "создай файл <name> [с текстом <text>]" / "create file <name> …". */
export function parseCreateFileCommand(
  text: string,
): { filename: string; content: string } | null {
  const head: RegExpMatchArray | null = text.match(
    /(?:создай|создать|create)\s+(?:файл|file)\s+([^\s]+)([\s\S]*)$/i,
  );
  if (!head) return null;
  const filename: string = cleanFileToken(head[1] ?? '');
  if (!filename || filename.includes('\0')) return null;
  const tail: string = (head[2] ?? '').trim();
  if (!tail) return { filename, content: '' };
  const marker: RegExpMatchArray | null = tail.match(
    /(?:с\s+текстом|с\s+содержимым|with\s+text|with\s+content)\s*:?\s*([\s\S]*)$/i,
  );
  const rawContent: string = (marker?.[1] ?? tail.replace(/^:\s*/, '')).trim();
  const content: string = rawContent.replace(/^["'`«»]+|["'`«»]+$/g, '').trim();
  return { filename, content };
}

/** "прочитай|покажи файл <name>" / "read|show file <name>". */
export function parseReadFileCommand(text: string): { filename: string } | null {
  const match: RegExpMatchArray | null = text.match(
    /(?:прочитай|покажи|показать|read|show)\s+(?:файл|file)\s+([^\s]+)/i,
  );
  if (!match) return null;
  const filename: string = cleanFileToken(match[1] ?? '');
  if (!filename || filename.includes('\0')) return null;
  return { filename };
}

/** "выполни|запусти <cmd>" / "run <cmd>" / "shell: <cmd>". */
export function parseShellCommand(text: string): string | null {
  const match: RegExpMatchArray | null = text.trim().match(
    /^(?:выполни|запусти|run|shell)\s*:?\s+([\s\S]+)$/i,
  );
  if (!match) return null;
  const command: string = (match[1] ?? '').trim();
  return command.length > 0 ? command : null;
}

/** Best-effort text projection of the host shell payload (shape-agnostic). */
export function formatShellOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (typeof output !== 'object' || output === null) return '';
  const record: Record<string, unknown> = output as Record<string, unknown>;
  for (const key of ['output', 'stdout', 'text', 'content', 'result'] as const) {
    const value: unknown = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return '';
  }
}
