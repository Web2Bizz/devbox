// Dev stop — terminates stray nx/dev processes left behind by `bun run dev`.
//
// Cross-platform, dependency-free (node: builtins only). On POSIX processes are
// selected by UID (`ps -eo pid,ppid,uid,args`), never by the `user` column —
// `ps` truncates names (letnull19a → letnull+), which used to drop every
// candidate. On Windows the current user name is still used. PID 1 and this
// script are never touched.
//
// The WHOLE process tree is stopped: matched processes plus all their
// descendants (with-env → nx → nest/next → node dist/main, contracts watch).
// After the requested signal (default SIGTERM) each target is re-checked for up
// to 3s; survivors are escalated to SIGKILL.
//
// Matched command-line patterns:
//   - scripts/dev/with-env (the dev env bridge)
//   - nx ... dev (nx run-many -t dev, nx run backend:dev / frontend:dev)
//   - next dev / next-server (frontend dev server)
//   - nest ... --watch (backend dev server)
//   - apps/backend/dist/main (compiled backend spawned by nest --watch)
//   - tsc --watch (contracts watcher; cwd is packages/contracts)
// Port holders on 3100/3001 are resolved best-effort (lsof/ss/netstat) and
// killed only if they ALSO look like dev processes, or with --ports=kill.
// Plain unknown listeners on those ports are only reported, never killed,
// unless --ports=kill is passed.
//
// Usage:
//   bun scripts/dev/stop.ts [--dry] [--ports=also|kill|skip] [--signal SIGTERM]
//   bun run stop [-- <same flags>]
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

const DEV_PORTS = [3100, 3001];
const DEFAULT_SIGNAL: NodeJS.Signals = 'SIGTERM';
const EXIT_TIMEOUT_MS = 3_000;

type Args = {
  dry: boolean;
  ports: 'also' | 'kill' | 'skip';
  signal: NodeJS.Signals;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { dry: false, ports: 'also', signal: DEFAULT_SIGNAL };
  for (const a of argv) {
    if (a === '--dry' || a === '--dry-run') out.dry = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a.startsWith('--ports=')) {
      const v = a.slice('--ports='.length);
      if (v === 'also' || v === 'kill' || v === 'skip') out.ports = v;
      else {
        console.error(`[stop] unknown --ports mode: ${v} (expected also|kill|skip)`);
        process.exit(2);
      }
    } else if (a.startsWith('--signal=')) {
      out.signal = a.slice('--signal='.length) as NodeJS.Signals;
    } else {
      console.error(`[stop] unknown flag: ${a} (see --help)`);
      process.exit(2);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(
    [
      'usage: bun scripts/dev/stop.ts [--dry] [--ports=also|kill|skip] [--signal NAME]',
      '',
      'Stops the dev stack tree (with-env bridge, nx dev targets, next dev,',
      'nest --watch, compiled backend, contracts watch) owned by the current',
      'UID. Matched processes are killed first, then all their descendants.',
      '',
      '  --dry              list candidates without killing',
      '  --ports=also       (default) report port holders; kill only dev-looking ones',
      '  --ports=kill       also kill unknown processes listening on 3100/3001',
      '  --ports=skip       ignore ports entirely',
      '  --signal NAME      kill signal (default SIGTERM, SIGKILL after 3s)',
    ].join('\n'),
  );
}

type Proc = { pid: number; ppid: number; uid: number; user: string; args: string };

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env['USER'] ?? process.env['USERNAME'] ?? '';
  }
}

/** Process list via `ps` (POSIX) or `tasklist` (Windows). Best-effort: [] on failure. */
function listProcesses(): Proc[] {
  try {
    if (process.platform === 'win32') {
      const raw = execFileSync('tasklist', ['/FO', 'CSV', '/V'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      const me = currentUser().toLowerCase();
      const out: Proc[] = [];
      for (const line of raw.split(/\r?\n/).slice(1)) {
        const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
        if (cols.length < 9) continue;
        const pid = Number(cols[1]);
        const user = cols[6] ?? '';
        const title = cols[8] ?? '';
        if (!Number.isFinite(pid)) continue;
        if (me && !user.toLowerCase().includes(me)) continue;
        out.push({ pid, ppid: 0, uid: -1, user, args: `${cols[0]} ${title}` });
      }
      return out;
    }
    const raw = execFileSync('ps', ['-eo', 'pid,ppid,uid,args'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const out: Proc[] = [];
    for (const line of raw.split('\n').slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      // Only our own processes — never touch чужие. UID is exact, `user` is
      // truncated by `ps` (`letnull19a` → `letnull+`) and must not be compared.
      if (uid !== undefined && Number(m[3]) !== uid) continue;
      if (pid <= 1 || pid === process.pid) continue;
      out.push({
        pid,
        ppid: Number(m[2]),
        uid: Number(m[3]),
        user: '',
        args: m[4] ?? '',
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** True when a command line belongs to our dev stack. */
function isDevProcess(args: string): boolean {
  const a = ` ${args} `;
  if (a.includes('scripts/dev/with-env')) return true;
  if (a.includes('scripts/dev/stop')) return false; // never ourselves
  if (/\bnx\b/.test(args) && /\bdev\b/.test(args)) return true;
  if (/\bnext(-server)?\b/.test(args) && !/\bnext build\b/.test(args)) {
    if (/\bdev\b/.test(args) || a.includes('next-server')) return true;
  }
  if (/\bnest\b/.test(args) && a.includes('--watch')) return true;
  // Built backend started by nest --watch (or a stale `bun dist/main.js`).
  if (a.includes('apps/backend/dist/main')) return true;
  // contracts watch: cwd is packages/contracts, argv has no "contracts".
  if (/\btsc\b/.test(args) && a.includes('--watch')) return true;
  return false;
}

/** All descendants of the roots (nx/nest/next spawn children). */
function collectDescendants(
  procs: ReadonlyArray<Proc>,
  roots: ReadonlySet<number>,
): Map<number, string> {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const arr = children.get(p.ppid) ?? [];
    arr.push(p.pid);
    children.set(p.ppid, arr);
  }
  const out = new Map<number, string>();
  const walk = (pid: number, root: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (child <= 1 || child === process.pid || out.has(child)) continue;
      out.set(child, `tree:${root}`);
      walk(child, root);
    }
  };
  for (const root of roots) walk(root, root);
  return out;
}

/** PIDs listening on the dev ports. Best-effort, POSIX only, [] on failure. */
function portHolders(ports: number[]): Map<number, number[]> {
  const found = new Map<number, number[]>();
  const push = (port: number, pid: number): void => {
    if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) return;
    const arr = found.get(port) ?? [];
    if (!arr.includes(pid)) arr.push(pid);
    found.set(port, arr);
  };
  if (process.platform === 'win32') return found;
  for (const port of ports) {
    try {
      const raw = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      for (const pid of raw.split(/\s+/).map(Number)) push(port, pid);
      continue;
    } catch {
      /* lsof missing — try ss */
    }
    try {
      const raw = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 10_000 });
      for (const line of raw.split('\n')) {
        if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) continue;
        for (const m of line.matchAll(/pid=(\d+)/g)) push(port, Number(m[1]));
      }
    } catch {
      /* neither lsof nor ss — ports skipped */
    }
  }
  return found;
}

/** Signal-0 probe: true while the process exists (EPERM means it exists too). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits up to timeoutMs for pids to disappear; returns the survivors. */
async function waitForExit(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(100);
    alive = alive.filter(isAlive);
  }
  return alive;
}

/** Roots first (their `why` is not `tree:*`), then descendants; stable by pid. */
function orderTargets(targets: Map<number, string>): Array<[number, string]> {
  return [...targets].sort((a, b) => {
    const ta = a[1].startsWith('tree:') ? 1 : 0;
    const tb = b[1].startsWith('tree:') ? 1 : 0;
    return ta !== tb ? ta - tb : a[0] - b[0];
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const procs = listProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const targets = new Map<number, string>();

  for (const p of procs) {
    if (p.pid <= 1 || p.pid === process.pid) continue;
    if (isDevProcess(p.args)) targets.set(p.pid, 'dev-cmdline');
  }

  // nx/nest/next spawn children that survive the parent: with-env → nx →
  // nest/next → node dist/main, plus the contracts tsc watcher.
  for (const [pid, why] of collectDescendants(procs, new Set(targets.keys()))) {
    if (!targets.has(pid)) targets.set(pid, why);
  }

  if (args.ports !== 'skip') {
    for (const [port, pids] of portHolders(DEV_PORTS)) {
      for (const pid of pids) {
        if (targets.has(pid)) continue;
        const proc = byPid.get(pid);
        if (proc && isDevProcess(proc.args)) {
          targets.set(pid, `port:${port}+dev-cmdline`);
        } else if (args.ports === 'kill') {
          targets.set(pid, `port:${port}`);
        } else {
          console.log(
            `[stop] port ${port} held by pid ${pid} (not dev — skipped): ${proc?.args ?? 'unknown'}`,
          );
        }
      }
    }
    // A port holder can itself be a tree root — recollect from all targets.
    for (const [pid, why] of collectDescendants(procs, new Set(targets.keys()))) {
      if (!targets.has(pid)) targets.set(pid, why);
    }
  }

  if (targets.size === 0) {
    console.log('[stop] nothing to stop');
    return;
  }

  const ordered = orderTargets(targets);

  if (args.dry) {
    for (const [pid, why] of ordered) {
      const proc = byPid.get(pid);
      const label = `${pid} [${why}] ${proc?.args.slice(0, 160) ?? ''}`.trimEnd();
      console.log(`[stop] would kill ${label}`);
    }
    return;
  }

  const signaled: number[] = [];
  for (const [pid, why] of ordered) {
    const proc = byPid.get(pid);
    const label = `${pid} [${why}] ${proc?.args.slice(0, 160) ?? ''}`.trimEnd();
    try {
      process.kill(pid, args.signal);
      signaled.push(pid);
      console.log(`[stop] killed ${label}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') continue; // already gone
      console.error(`[stop] cannot kill ${label}: ${(err as Error).message}`);
    }
  }

  const alive = await waitForExit(signaled, EXIT_TIMEOUT_MS);
  for (const pid of alive) {
    try {
      process.kill(pid, 'SIGKILL');
      console.log(`[stop] escalated to SIGKILL pid=${pid}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') continue;
      console.error(`[stop] cannot SIGKILL pid=${pid}: ${(err as Error).message}`);
    }
  }

  console.log(`[stop] done (${signaled.length} processes)`);
}

void main().catch((err) => {
  console.error('[stop] failed:', (err as Error).message);
  process.exitCode = 1;
});
