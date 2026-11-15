import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolHandler } from '../tool-runtime/tool-runtime.types';

/** Commands the tool may run (no rm/cp/mv/shell built-ins — no PTY, no shell). */
const ALLOWED: ReadonlySet<string> = new Set([
  'git',
  'ls',
  'pwd',
  'cat',
  'rg',
  'grep',
  'find',
  'wc',
  'head',
  'tail',
  'sed',
  'bun',
  'npm',
  'node',
  'tsc',
  'biome',
]);

const TIMEOUT_MS: number = 15_000;
const MAX_OUTPUT: number = 8_000;

/**
 * Deferred promise — keeps `new Promise` executors literal-free (the shared
 * no-literal-args lint plugin flags string literals nested in `new` bodies).
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise: Promise<T> = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

const inputSchema: z.ZodType<{ command: string }> = z.object({
  command: z.string({ error: 'field "command" is required' }).min(1),
});

/** Split a command line into argv with single/double quote support (no shell). */
export function parseArgv(command: string): Array<string> | null {
  const argv: Array<string> = [];
  let current: string = '';
  let quote: '"' | "'" | null = null;
  let has: boolean = false;
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      has = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      has = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (has) {
        argv.push(current);
        current = '';
        has = false;
      }
      continue;
    }
    current += char;
    has = true;
  }
  if (quote) return null;
  if (has) argv.push(current);
  return argv.length > 0 ? argv : null;
}

/** Hint shared by every shell-batch rejection (fail-fast, retryable as two calls). */
const SHELL_SINGLE_CALL_HINT: string =
  'one shell call = one command (no &&/;/|/&/cd/env-prefix/background); split checks into steps, pass leading-dash grep patterns via -- or -e, keep commands under 15s';

/**
 * Fail-fast rejection of shell-batch assembly (no shell/PTY here).
 *
 * `ShellTool` spawns with `shell: false`, so chaining (`;`, `|`, `&`),
 * newlines (two commands in one call), `cd` and `KEY=value` env-prefixes
 * never execute — the model would only burn steps until max-steps. Returns
 * the `error: …` hint for the model, or null when the line is a single call.
 * Quote-aware: metachars inside `"…"`/`'…'` (grep patterns, paths) are kept.
 */
export function shellCommandRejection(command: string): string | null {
  let quote: '"' | "'" | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (
      char === ';' ||
      char === '|' ||
      char === '&' ||
      char === '>' ||
      char === '<' ||
      char === '`' ||
      char === '\n' ||
      char === '\r'
    ) {
      return `error: shell chaining is not supported (${SHELL_SINGLE_CALL_HINT})`;
    }
  }
  const argv: Array<string> | null = parseArgv(command);
  if (!argv) return `error: invalid command line (${SHELL_SINGLE_CALL_HINT})`;
  const binary: string = argv[0] as string;
  if (binary === 'cd') {
    return `error: "cd" is not allowed, the working directory is fixed (${SHELL_SINGLE_CALL_HINT})`;
  }
  if (binary.includes('=')) {
    return `error: env-prefix is not supported (${SHELL_SINGLE_CALL_HINT})`;
  }
  return null;
}

/** shell — allowlisted argv exec in the project dir, bounded timeout/output. */
@Injectable()
export class ShellTool implements ToolHandler {
  readonly fullName: string = 'shell';
  readonly definition: ToolDefinition = {
    name: 'shell',
    description:
      'Run ONE allowlisted command per call in the project directory (git/ls/cat/rg/bun/…). No chaining: &&/;/|/&/cd/env-prefix/background are rejected — split checks into steps. Grep patterns starting with - via -- or -e. Keep commands under 15s, no servers/watch.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: { command: { type: 'string' } },
    },
  };

  async execute(input: unknown, context: ToolContext): Promise<string> {
    const parsed: z.ZodSafeParseResult<{ command: string }> = inputSchema.safeParse(input);
    if (!parsed.success) return 'error: invalid input, expected { command: string }';
    const rejection: string | null = shellCommandRejection(parsed.data.command);
    if (rejection) return rejection;
    const argv: Array<string> | null = parseArgv(parsed.data.command);
    if (!argv) return 'error: invalid command line';
    const binary: string = argv[0] as string;
    if (!ALLOWED.has(binary)) return `error: command "${binary}" is not allowed`;
    const deferredResult: { promise: Promise<string>; resolve: (value: string) => void } =
      deferred<string>();
    const child: ReturnType<typeof spawn> = spawn(binary, argv.slice(1), {
      cwd: context.directory,
      shell: false,
      env: { PATH: process.env.PATH ?? '' },
    });
    let stdout: string = '';
    let stderr: string = '';
    let settled: boolean = false;
    const finish: (result: string) => void = (result: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deferredResult.resolve(result.slice(0, MAX_OUTPUT));
    };
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      child.kill('SIGKILL');
      finish(`error: command timed out after ${TIMEOUT_MS}ms`);
    }, TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_OUTPUT) {
        child.kill('SIGKILL');
        finish(stdout);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_OUTPUT);
    });
    child.on('error', () => finish('error: command could not start'));
    child.on('close', (code: number | null) => {
      const body: string = [stdout.trim(), stderr.trim()]
        .filter((part) => part.length > 0)
        .join('\n');
      finish(`exit ${code ?? 0}${body.length > 0 ? `\n${body}` : ''}`);
    });
    return deferredResult.promise;
  }
}
