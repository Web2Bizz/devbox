// Dev env bridge — replaces the pm2 `ecosystem.config.cjs` injection.
// Loads the repo-root `.env` into process.env (shell wins > file, file wins
// over built-in defaults) and execs the given command (nx dev targets).
//
// Why this exists: nx runs each target with cwd={projectRoot}, so
// apps/backend dotenv and `next dev` would never see the repo-root `.env`.
// The old pm2 setup solved it by parsing the root `.env` and injecting it
// before spawn — this launcher does the same, minus the supervisor.
//
// Parser semantics (ported from the removed ecosystem.config.cjs, no new
// syntax invented): KEY=VALUE lines, `#` comments, optional quotes,
// ${VAR} / ${VAR:-default} expansion resolved whole-file (order-independent,
// cycle-guarded), lookup order process.env > file > nothing. In particular
// this is NOT `set -a; source .env`: shell sourcing would expand `$` inside
// passwords and resolve top-down (CORS_ORIGINS uses NEXT_PUBLIC_PORT defined
// further below), both of which break parity.
//
// Deliberately NO autorestart/backoff here: nest --watch, `next dev` and
// tsc --watch already watch their own sources; the outer pm2 `watch` is gone
// with pm2, so the double-watch inotify crash-loop source is removed at the
// root cause instead of being papered over with restarts. A crashing dev
// server exits non-zero and nx tears down the parallel run — fix the crash,
// then rerun. Logs stream prefixed per project (--output-style=stream).
// Secrets are never printed — only the count of injected keys on debug.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOTENV_PATH = join(ROOT, '.env');

/** Minimal .env parser (KEY=VALUE, # comments, optional quotes). No deps. */
function parseDotEnvFile(filePath: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const isQuoted =
      (value.startsWith('"') && value.includes('"', 1)) ||
      (value.startsWith("'") && value.includes("'", 1)) ||
      value.startsWith('`');
    if (!isQuoted) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('`') && value.endsWith('`'))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/** Expand ${VAR} and ${VAR:-default}. Lookup: process.env > fileEnv. */
function expandValue(
  value: string,
  fileEnv: Record<string, string>,
  seen: Set<string>,
): string {
  if (typeof value !== 'string' || !value.includes('${')) return value;
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
  let out = value;
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    out = out.replace(pattern, (match, name, def) => {
      if (seen.has(name)) return match;
      let resolved: string | undefined;
      if (process.env[name] !== undefined && process.env[name] !== '') {
        resolved = process.env[name];
      } else if (fileEnv[name] !== undefined && fileEnv[name] !== '') {
        resolved = fileEnv[name];
      } else if (def !== undefined) {
        resolved = def;
      } else {
        return match;
      }
      seen.add(name);
      const nested = expandValue(String(resolved), fileEnv, seen);
      seen.delete(name);
      if (nested !== match) changed = true;
      return nested;
    });
    if (!changed) break;
  }
  return out;
}

function main(): void {
  const cmd = process.argv.slice(2);
  if (cmd.length === 0) {
    console.error('usage: bun scripts/dev/with-env.ts <command> [args...]');
    process.exit(2);
  }
  const rawFileEnv = parseDotEnvFile(DOTENV_PATH);
  let injected = 0;
  for (const key of Object.keys(rawFileEnv)) {
    // Shell wins: never override an already-set non-empty variable.
    if (process.env[key] !== undefined && process.env[key] !== '') continue;
    const expanded = expandValue(rawFileEnv[key], rawFileEnv, new Set([key]));
    process.env[key] = expanded;
    injected++;
  }
  if (process.env['DEV_ENV_DEBUG']) {
    console.error(`[with-env] injected ${injected} keys from ${DOTENV_PATH}`);
  }
  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: 'inherit',
    cwd: ROOT,
    env: process.env,
  });
  // Ctrl+C must reach the nx child (and its dev servers), not just us.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      if (!child.kill(sig)) process.exit(128 + 2);
    });
  }
  child.on('error', (err) => {
    console.error(`[with-env] spawn failed: ${(err as Error).message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.exit(128 + 2);
    process.exit(code ?? 1);
  });
}

main();
