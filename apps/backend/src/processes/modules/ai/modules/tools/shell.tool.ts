import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolContext, ToolHandler } from './tool.types';

/** Commands the tool may run (no rm/cp/mv/shell built-ins — no PTY, no shell). */
const ALLOWED = new Set([
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

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 8_000;

/**
 * Deferred promise — keeps `new Promise` executors literal-free (the shared
 * no-literal-args lint plugin flags string literals nested in `new` bodies).
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const inputSchema = z.object({
  command: z.string({ error: 'field "command" is required' }).min(1),
});

/** Split a command line into argv with single/double quote support (no shell). */
export function parseArgv(command: string): Array<string> | null {
  const argv: Array<string> = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
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

/** shell — allowlisted argv exec in the project dir, bounded timeout/output. */
@Injectable()
export class ShellTool implements ToolHandler {
  readonly fullName = 'shell';
  readonly definition = {
    name: 'shell',
    description: 'Run one allowlisted command (git/ls/cat/rg/bun/…) in the project directory.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: { command: { type: 'string' } },
    },
  };

  async execute(input: unknown, context: ToolContext): Promise<string> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return 'error: invalid input, expected { command: string }';
    const argv = parseArgv(parsed.data.command);
    if (!argv) return 'error: invalid command line';
    const binary = argv[0] as string;
    if (!ALLOWED.has(binary)) return `error: command "${binary}" is not allowed`;
    const { promise, resolve } = deferred<string>();
    const child = spawn(binary, argv.slice(1), {
      cwd: context.directory,
      shell: false,
      env: { PATH: process.env.PATH ?? '' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result.slice(0, MAX_OUTPUT));
    };
    const timer = setTimeout(() => {
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
    child.on('close', (code) => {
      const body = [stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join('\n');
      finish(`exit ${code ?? 0}${body.length > 0 ? `\n${body}` : ''}`);
    });
    return promise;
  }
}
