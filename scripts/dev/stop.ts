// Dev stop — terminates stray nx/dev processes left behind by `bun run dev`.
//
// Cross-platform, dependency-free (node: builtins only). Matches ONLY
// processes whose command line looks like our dev stack, and ONLY processes
// owned by the current user — never PID 1, never itself.
//
// Matched command-line patterns:
//   - scripts/dev/with-env (the dev env bridge)
//   - nx ... dev (nx run-many -t dev, nx run backend:dev / frontend:dev)
//   - next dev / next-server (frontend dev server)
//   - nest ... --watch (backend dev server)
//   - contracts watch (tsc --watch under packages/contracts)
// Port holders on 3100/3001 are resolved best-effort (lsof/ss/netstat) and
// killed only if they ALSO look like dev processes, or with --ports=also.
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
      'Stops stray nx/dev processes (with-env bridge, nx dev targets,',
      'next dev, nest --watch, contracts watch) owned by the current user.',
      '',
      '  --dry              list candidates without killing',
      '  --ports=also       (default) report port holders; kill only dev-looking ones',
      '  --ports=kill       also kill unknown processes listening on 3100/3001',
      '  --ports=skip       ignore ports entirely',
      '  --signal NAME      kill signal (default SIGTERM)',
    ].join('\n'),
  );
}

type Proc = { pid: number; user: string; args: string };

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
        out.push({ pid, user, args: `${cols[0]} ${title}` });
      }
      return out;
    }
    const raw = execFileSync('ps', ['-eo', 'pid,user,args'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const me = currentUser();
    const out: Proc[] = [];
    for (const line of raw.split('\n').slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      // Only our own processes — never touch чужие.
      if (me && m[2] !== me) continue;
      out.push({ pid: Number(m[1]), user: m[2], args: m[3] });
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
  if (/\btsc\b/.test(args) && a.includes('--watch') && a.includes('contracts')) return true;
  return false;
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const procs = listProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const targets = new Map<number, string>();

  for (const p of procs) {
    if (p.pid <= 1 || p.pid === process.pid) continue;
    if (isDevProcess(p.args)) targets.set(p.pid, 'dev-cmdline');
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
          console.log(`[stop] port ${port} held by pid ${pid} (not dev — skipped): ${proc?.args ?? 'unknown'}`);
        }
      }
    }
  }

  if (targets.size === 0) {
    console.log('[stop] nothing to stop');
    return;
  }

  for (const [pid, why] of [...targets].sort((a, b) => a[0] - b[0])) {
    const proc = byPid.get(pid);
    const label = proc ? `${pid} [${why}] ${proc.args}` : `${pid} [${why}]`;
    if (args.dry) {
      console.log(`[stop] would kill ${label}`);
      continue;
    }
    try {
      process.kill(pid, args.signal);
      console.log(`[stop] killed ${label}`);
    } catch (err) {
      console.error(`[stop] cannot kill ${label}: ${(err as Error).message}`);
    }
  }
}

main();
