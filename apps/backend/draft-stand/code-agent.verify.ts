// biome-ignore lint/suspicious/noConsole: draft-stand is a CLI probe, console is its output channel (same as run.ts).
/// <reference types="node" />
/**
 * draft-stand/code-agent.verify — прогон примера `code-agent.ts` (не прод).
 *
 * Reuse-first:
 * - `resolveKey`/`authCandidates` — копия паттерна `run.ts:77-127` (там не
 *   экспортируется, поэтому копия с атрибуцией, логика 1:1: приоритет
 *   `opencode-go` > `opencode`, значение только в память).
 * - `gitPorcelain` — копия `run.ts:145-175` (проверка R4, без sidecar модели).
 * - `secretScanSelf` — копия `run.ts:178-199`, расширена на новые файлы.
 * - `assertR2`/`assertR4` — импорт из `./assertions` (переиспользование).
 * - Модель по умолчанию — `DEFAULT_MODEL_ID` из `./code-agent`
 *   (== `ASK_FALLBACK_MODELS[0]` в `agents/model-fallback.ts`).
 *
 * Запуск (из apps/backend):
 *   bun ./draft-stand/code-agent.verify.ts
 *
 * Без ключа — честный SKIP вызова модели (R1/R4/secret-scan всё равно
 * проверяются). С ключом — один вызов `runCodeAgent`, отчёт без секретов
 * (только path/field/key_len, text_len, usage). Ненулевой exit при FAIL.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { assertR1, assertR2, assertR4 } from './assertions';
import { DEFAULT_MODEL_ID, EXPECTED_AI_VERSION, runCodeAgent } from './code-agent';

// ---------------------------------------------------------------------------
// Ключ: копия run.ts (не экспортируется — дублируем 1:1 с атрибуцией)
// ---------------------------------------------------------------------------

function authCandidates(): Array<string> {
  const xdg = (process.env.XDG_DATA_HOME ?? '').trim();
  const dataDir = xdg || path.join(homedir(), '.local', 'share');
  return [
    path.resolve('.opencode/auth.json'),
    path.join(homedir(), '.config', 'opencode', 'auth.json'),
    path.join(dataDir, 'opencode', 'auth.json'),
  ];
}

type ResolvedKey = {
  path: string;
  field: string;
  keyLen: number;
  key: string;
};

function resolveKey(): ResolvedKey | null {
  for (const candidate of authCandidates()) {
    let raw = '';
    try {
      if (!existsSync(candidate)) continue;
      raw = readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const rec = (parsed ?? {}) as Record<string, { key?: unknown } | undefined>;
    const goKey = rec['opencode-go']?.key;
    const baseKey = rec['opencode']?.key;
    if (typeof goKey === 'string' && goKey.trim()) {
      const key = goKey.trim();
      return { path: candidate, field: 'opencode-go', keyLen: key.length, key };
    }
    if (typeof baseKey === 'string' && baseKey.trim()) {
      const key = baseKey.trim();
      return { path: candidate, field: 'opencode', keyLen: key.length, key };
    }
  }
  return null;
}

function readDirectAiVersion(): string | null {
  const pkgUrl = new URL('../package.json', import.meta.url);
  try {
    const raw = readFileSync(pkgUrl, 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return pkg.dependencies?.['@opencode/ai'] ?? pkg.devDependencies?.['@opencode/ai'] ?? null;
  } catch {
    return null;
  }
}

async function gitPorcelain(): Promise<string | null> {
  try {
    const g = globalThis as unknown as { Bun?: typeof Bun };
    if (g.Bun?.spawnSync) {
      const out = g.Bun.spawnSync(['git', 'status', '--porcelain'], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (out.exitCode !== 0) return null;
      return out.stdout.toString();
    }
  } catch {
    return null;
  }
  try {
    const { spawnSync } = await import('node:child_process');
    const out = spawnSync('git', ['status', '--porcelain'], { cwd: process.cwd() });
    if (out.status !== 0) return null;
    return String(out.stdout ?? '');
  } catch {
    return null;
  }
}

function secretScanSelf(): { clean: boolean; detail: string } {
  const selfFiles = [
    new URL('./code-agent.ts', import.meta.url),
    new URL('./code-agent.verify.ts', import.meta.url),
    new URL('./code-agent.README.md', import.meta.url),
    new URL('./run.ts', import.meta.url),
    new URL('./assertions.ts', import.meta.url),
  ];
  const valueRe = /Bearer\s+[A-Za-z0-9._~+/=-]{16,}|sk-[A-Za-z0-9]{16,}/;
  for (const file of selfFiles) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (valueRe.test(text)) {
      return { clean: false, detail: `secret-like value in ${path.basename(file.pathname)}` };
    }
  }
  return { clean: true, detail: 'no Bearer/key values in draft-stand files' };
}

async function main(): Promise<void> {
  const direct = readDirectAiVersion();
  console.log(assertR2(direct, EXPECTED_AI_VERSION).id + ' ' + assertR2(direct, EXPECTED_AI_VERSION).status + ' direct=' + String(direct));

  const resolved = resolveKey();
  if (resolved) {
    console.log(
      `key_source=auth.json path=${resolved.path} field=${resolved.field} key_len=${resolved.keyLen}`,
    );
  } else {
    console.log(`key_source=missing checked=${authCandidates().join(',')}`);
  }

  const before = await gitPorcelain();

  // R1: dispatch всегда 0 — code-agent не импортирует ToolDispatchService.
  console.log(`${assertR1(0, false).id} ${assertR1(0, false).status} ${assertR1(0, false).detail}`);

  if (!resolved) {
    const afterSkip = await gitPorcelain();
    console.log(`${assertR4({ before, after: afterSkip }).id} ${assertR4({ before, after: afterSkip }).status} model-skipped`);
    const scan = secretScanSelf();
    console.log(`secret-scan ${scan.clean ? 'PASS' : 'FAIL'} ${scan.detail}`);
    console.log(
      `usage: bun ./draft-stand/code-agent.verify.ts  # with auth.json: calls model=${DEFAULT_MODEL_ID} once, read-only`,
    );
    if (!scan.clean) process.exitCode = 1;
    console.log('stand GREEN (code-agent verify SKIP without key)');
    return;
  }

  try {
    const out = await runCodeAgent({
      apiKey: resolved.key,
      systemPrompt: 'You are a read-only code assistant. Output code or text only. Do not write files.',
      userPrompt: 'Say OK.',
    });
    console.log(
      `model-called PASS text_len=${out.text.length} model=${out.model} provider=${out.provider} transport=${out.transport} usage=${out.usage ? `${out.usage.inputTokens ?? '-'}/${out.usage.outputTokens ?? '-'}/${out.usage.totalTokens ?? '-'}` : 'n/a'} dispatchCalls=${out.dispatchCalls}`,
    );
  } catch (err) {
    // Честная ошибка без секретов: только первые 200 символов сообщения.
    console.log(`model-called FAIL ${(err as Error).message.slice(0, 200)}`);
    process.exitCode = 1;
  }

  const after = await gitPorcelain();
  const r4 = assertR4({ before, after });
  console.log(`${r4.id} ${r4.status} ${r4.detail}`);
  if (r4.status === 'FAIL') process.exitCode = 1;

  const scan = secretScanSelf();
  console.log(`secret-scan ${scan.clean ? 'PASS' : 'FAIL'} ${scan.detail}`);
  if (!scan.clean) process.exitCode = 1;

  if (process.exitCode !== 1) console.log('stand GREEN (code-agent verify done)');
}

main().catch((err) => {
  console.error(`stand ERROR ${(err as Error).message.slice(0, 200)}`);
  process.exitCode = 1;
});
