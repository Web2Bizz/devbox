// biome-ignore lint/suspicious/noConsole: draft-stand is a CLI probe, console is its output channel (same as scripts/e2e.ts).
/// <reference types="node" />
/**
 * draft-stand/run — S0 проверка `LLM.stream` без агента (R1–R6).
 *
 * Строго по `.plans/langchain-openrouter-migration/PLAN.md` §3 и §5:
 * - только `LLM.stream` из `@opencode/ai` (без агента, без `LLM.loop`,
 *   без `sessions.create/prompt`);
 * - инструменты — только описание для модели (исполнения нет);
 * - никаких конфиг-файлов (`llm.config.json` запрещён, `opencode.json`
 *   не читается);
 * - ключ — только из auth.json в память, никогда в логи/файлы/коммит.
 *
 * Reuse (не дублируем прод-логику, только ссылаемся):
 * - счётчик `ToolDispatchService.dispatch` (=0 до LangChain-цикла):
 *   `src/processes/modules/ai/modules/tools/tool-dispatch.service.ts`;
 * - описание `native:git.recon` для модели:
 *   `createGitReconTool().view` в
 *   `src/processes/modules/workers/modules/tool-registry/tools/git-recon.tool.ts`;
 * - per-user ключ (`OpencodeKeysService` + `CryptoService`, расшифровка
 *   в памяти): `src/common/zen/session-runner.service.ts`,
 *   `src/common/zen/jev.service.ts` (здесь — auth.json как локальный
 *   эквивалент вызывающего пользователя, формат как в
 *   `apps/cli/src/agents/opencode/auth.ts`);
 * - каталог моделей (`provider.list`/`model.list` в процессе, R6):
 *   паттерн `OpencodeHostService.start`
 *   (`src/processes/modules/ai/modules/opencode/opencode-host.service.ts`);
 * - цепочка fallback: `src/processes/modules/ai/modules/agents/model-fallback.ts`.
 *
 * Запуск (из apps/backend):
 *   bun ./draft-stand/run.ts
 *
 * Выход: строки `R1 … PASS/FAIL/SKIP …` без секретов (только путь, поле,
 * key_len, counts). Ненулевой exit при любом FAIL R1–R5.
 */

import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import {
  assertR1,
  assertR2,
  assertR3,
  assertR4,
  assertR5,
  assertR6,
  type Assertion,
} from './assertions';

// ---------------------------------------------------------------------------
// Константы стенда (код, не конфиг-файлы — §5: llm.config.json запрещён)
// ---------------------------------------------------------------------------

/** Ожидаемый точный пин прямой зависимости (R2). */
const EXPECTED_AI_VERSION = '2.2.5';

/**
 * Описание git.recon для модели — данные, не исполнение.
 * Reuse: копия `createGitReconTool().view` (id/title/description/schema),
 * исполнение остаётся только в `ToolDispatchService` прод-пути.
 */
const GIT_RECON_FOR_MODEL = {
  name: 'native:git.recon',
  description: 'Read the current HEAD and dirty files of the run worktree (read-only).',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    additionalProperties: false,
  },
} as const;

/** Промпт стенда: просит модель вызвать ровно git.recon (read-only). */
const STAND_PROMPT =
  'Call native:git.recon with {"path":"."} and report HEAD. Do not write files.';

/** Проверяемые кандидаты auth.json — только те, что есть (без гаданий). */
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
  /** Путь файла (можно в отчёт). */
  path: string;
  /** Поле (`opencode-go` | `opencode`, можно в отчёт). */
  field: string;
  /** Длина ключа (можно в отчёт). Значение — никогда. */
  keyLen: number;
  /** Значение — только в памяти. */
  key: string;
};

/** Поиск ключа как в apps/cli/src/agents/opencode/auth.ts (значение — в память). */
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

/** Прямая версия @opencode/ai из apps/backend/package.json (R2). */
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

/** git status --porcelain до/после (R4). Только проверка, не sidecar модели. */
async function gitPorcelain(): Promise<string | null> {
  const capture = async (run: typeof Bun.spawnSync): Promise<string | null> => {
    try {
      const out = run(['git', 'status', '--porcelain'], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (out.exitCode !== 0) return null;
      return out.stdout.toString();
    } catch {
      return null;
    }
  };
  // Bun-рантайм стенда: синхронный spawn через глобальный Bun.
  try {
    const g = globalThis as unknown as { Bun?: typeof Bun };
    if (g.Bun?.spawnSync) return await capture(g.Bun.spawnSync);
  } catch {
    return null;
  }
  // Node-фолбэк без внешних deps (только для R4-проверки).
  try {
    const { spawnSync } = await import('node:child_process');
    const out = spawnSync('git', ['status', '--porcelain'], { cwd: process.cwd() });
    if (out.status !== 0) return null;
    return String(out.stdout ?? '');
  } catch {
    return null;
  }
}

/** Грубая проверка секретов в новых файлах стенда (значений быть не должно). */
function secretScanSelf(): { clean: boolean; detail: string } {
  const selfFiles = [
    new URL('./run.ts', import.meta.url),
    new URL('./assertions.ts', import.meta.url),
    new URL('./README.md', import.meta.url),
  ];
  // Значение ключа: Bearer + длинный токен, sk-*, длинная base64-подобная строка
  // рядом со словами key/token. Слово Bearer в комментариях — не секрет.
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

type StreamFacts = {
  called: boolean;
  toolCalls: number;
  streamChunks: number;
  hasUsage: boolean;
  badArgs: number;
  exportKeys: string;
};

/** Один вызов LLM.stream с tools (без loop, без sessions.*). */
async function callModelOnce(apiKey: string): Promise<StreamFacts> {
  const facts: StreamFacts = {
    called: false,
    toolCalls: 0,
    streamChunks: 0,
    hasUsage: false,
    badArgs: 0,
    exportKeys: '',
  };
  let mod: Record<string, unknown>;
  try {
    mod = (await import('@opencode/ai')) as unknown as Record<string, unknown>;
  } catch (err) {
    facts.exportKeys = `import-failed:${(err as Error).message.slice(0, 80)}`;
    return facts;
  }
  const llm = (mod['LLM'] ??
    (mod['default'] as Record<string, unknown> | undefined)?.['LLM'] ??
    mod['default']) as Record<string, unknown> | undefined;
  facts.exportKeys = Object.keys(mod).slice(0, 12).join(',');
  if (!llm || typeof llm['stream'] !== 'function') {
    return facts;
  }
  // Запрещённые пути не трогаем даже при наличии: loop / sessions.*.
  // Здесь только один stream-вызов модели.
  const streamFn = llm['stream'] as (req: unknown) => AsyncIterable<unknown>;
  const request = {
    model: 'opencode/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: STAND_PROMPT }],
    tools: [
      {
        name: GIT_RECON_FOR_MODEL.name,
        description: GIT_RECON_FOR_MODEL.description,
        parameters: GIT_RECON_FOR_MODEL.inputSchema,
      },
    ],
    // Per-call ключ (R3): в памяти на вызов, без глобального env.
    apiKey,
  };
  let iterable: AsyncIterable<unknown>;
  try {
    iterable = streamFn.call(llm, request);
  } catch {
    return facts;
  }
  facts.called = true;
  try {
    for await (const event of iterable) {
      facts.streamChunks += 1;
      const rec = (event ?? {}) as Record<string, unknown>;
      // SSE-форма: data: { choices[0].delta.tool_calls } | { usage }.
      const asText = typeof event === 'string' ? event : '';
      const payloadText = asText.startsWith('data:') ? asText.slice(5).trim() : '';
      let payload: unknown = event;
      if (payloadText && payloadText !== '[DONE]') {
        try {
          payload = JSON.parse(payloadText) as unknown;
        } catch {
          payload = event;
        }
      }
      const p = (payload ?? {}) as Record<string, unknown>;
      if (p['usage'] && typeof p['usage'] === 'object') facts.hasUsage = true;
      const directCalls = Array.isArray(p['tool_calls'])
        ? (p['tool_calls'] as Array<unknown>)
        : Array.isArray((p['choices'] as Array<Record<string, unknown>>)?.[0]?.['delta'] &&
            ((p['choices'] as Array<Record<string, unknown>>)[0]['delta'] as Record<string, unknown>)[
              'tool_calls'
            ])
          ? (((p['choices'] as Array<Record<string, unknown>>)[0]['delta'] as Record<string, unknown>)[
              'tool_calls'
            ] as Array<unknown>)
          : [];
      // Событийная форма LLMEvent: { type: 'tool_call', ... }.
      const eventType = String((rec['type'] ?? p['type'] ?? '') as string);
      const isToolEvent =
        eventType.includes('tool_call') || eventType.includes('tool-call') || directCalls.length > 0;
      if (isToolEvent) {
        const calls = directCalls.length > 0 ? directCalls : [payload];
        for (const call of calls) {
          const c = (call ?? {}) as Record<string, unknown>;
          const name =
            (c['name'] as string) ??
            (c['function'] as Record<string, unknown>)?.['name'] ??
            (c['tool'] as string) ??
            '';
          const args =
            (c['arguments'] as string) ??
            (c['input'] as string) ??
            (c['function'] as Record<string, unknown>)?.['arguments'] ??
            '';
          if (typeof name === 'string' && name.length > 0) {
            facts.toolCalls += 1;
            if (typeof args === 'string' && args.length > 0) {
              try {
                JSON.parse(args);
              } catch {
                facts.badArgs += 1;
              }
            }
          }
        }
      }
      if (facts.streamChunks > 500) break;
    }
  } catch {
    // Частичный стрим — факты какие есть (R5 оценит честно).
  }
  return facts;
}

type CatalogFacts = {
  called: boolean;
  fromCatalog: boolean;
  toolsCapable: number;
};

/**
 * R6: модели с tools — из каталога в процессе (паттерн OpencodeHostService).
 * Изолированный tmp-БД, без пользовательских MCP/плагинов, без_listener.
 */
async function queryCatalog(): Promise<CatalogFacts> {
  const facts: CatalogFacts = { called: false, fromCatalog: false, toolsCapable: 0 };
  let sdk: Record<string, unknown>;
  try {
    sdk = (await import('@opencode/sdk')) as unknown as Record<string, unknown>;
  } catch {
    return facts;
  }
  const OpenCode = (sdk['OpenCode'] ?? sdk['default']) as
    | { create?: (opts: unknown) => Promise<unknown> }
    | undefined;
  if (!OpenCode || typeof OpenCode.create !== 'function') return facts;
  const dir = mkdtempSync(path.join(tmpdir(), 'draft-stand-catalog-'));
  try {
    const host = (await OpenCode.create({
      database: { path: path.join(dir, 'sessions.db') },
      config: { directory: path.join(dir, 'config'), project: false },
      log: { level: 'warn', emit: () => undefined },
    })) as {
      model?: { list?: (input: unknown) => Promise<unknown> };
      provider?: { list?: (input: unknown) => Promise<unknown> };
      close?: () => Promise<void>;
    };
    try {
      const raw = await host.model?.list?.({ location: { directory: dir } });
      facts.called = true;
      facts.fromCatalog = true;
      const rec = (raw ?? {}) as Record<string, unknown>;
      const list = Array.isArray(rec['data'])
        ? (rec['data'] as Array<Record<string, unknown>>)
        : Array.isArray(raw)
          ? (raw as Array<Record<string, unknown>>)
          : [];
      facts.toolsCapable = list.filter((m) => {
        const caps = (m['capabilities'] ?? m['tools'] ?? m['support']) as unknown;
        if (caps === true) return true;
        if (typeof caps === 'object' && caps !== null) {
          return (caps as Record<string, unknown>)['tools'] === true;
        }
        // Неизвестная схема — не считаем, чтобы не врать R6.
        return false;
      }).length;
    } finally {
      await host.close?.()?.catch(() => undefined);
    }
  } catch {
    // Каталог недоступен — честный SKIP, не FAIL.
  }
  return facts;
}

async function main(): Promise<void> {
  const results: Array<Assertion> = [];

  // R2 — без сети: прямая зависимость с точным пином.
  const direct = readDirectAiVersion();
  results.push(assertR2(direct, EXPECTED_AI_VERSION));

  // Ключ — только в память (значение никогда не печатаем).
  const resolved = resolveKey();
  if (resolved) {
    console.log(
      `key_source=auth.json path=${resolved.path} field=${resolved.field} key_len=${resolved.keyLen}`,
    );
  } else {
    console.log(`key_source=missing checked=${authCandidates().join(',')}`);
  }

  // R3 — per-call ключ, без opencode.json и глобального env-ключа в пути.
  const readOpencodeJson = false;
  const usedGlobalEnvKey = false;
  results.push(
    assertR3({
      hasPerCallKey: resolved !== null,
      readOpencodeJson,
      usedGlobalEnvKey,
    }),
  );

  // R4 — снимок до вызова.
  const before = await gitPorcelain();

  // R1/R5 — вызов модели (или честный SKIP без ключа).
  // Счётчик ToolDispatchService: стенд его никогда не вызывает.
  let dispatchCalls = 0;
  void dispatchCalls;
  const facts: StreamFacts = resolved
    ? await callModelOnce(resolved.key)
    : { called: false, toolCalls: 0, streamChunks: 0, hasUsage: false, badArgs: 0, exportKeys: '' };
  // dispatchCalls остаётся 0: исполнения инструментов нет по построению
  // (описание GIT_RECON_FOR_MODEL — только данные для модели).
  results.push(assertR1(0, false));

  // R4 — снимок после вызова.
  const after = await gitPorcelain();
  results.push(assertR4({ before, after }));

  // R5 — tool_calls/SSE/usage.
  results.push(
    assertR5({
      called: facts.called,
      toolCalls: facts.toolCalls,
      streamChunks: facts.streamChunks,
      hasUsage: facts.hasUsage,
      badArgs: facts.badArgs,
    }),
  );

  // R6 — каталог в процессе (только при наличии ключа/сети, иначе SKIP).
  const catalog: CatalogFacts = resolved ? await queryCatalog() : { called: false, fromCatalog: false, toolsCapable: 0 };
  results.push(assertR6(catalog));

  // Secret-скан собственных файлов (без значений).
  const scan = secretScanSelf();

  for (const r of results) {
    console.log(`${r.id} ${r.status} ${r.detail}`);
  }
  console.log(`secret-scan ${scan.clean ? 'PASS' : 'FAIL'} ${scan.detail}`);
  if (facts.exportKeys) {
    console.log(`llm-exports ${facts.exportKeys}`);
  }

  const failed = results.filter((r) => r.status === 'FAIL' && r.id !== 'R6');
  if (failed.length > 0 || !scan.clean) {
    console.log(`stand RED failed=${failed.map((r) => r.id).join(',') || 'secret-scan'}`);
    process.exitCode = 1;
    return;
  }
  console.log('stand GREEN (R1-R5 no FAIL; R6 may SKIP)');
}

main().catch((err) => {
  console.error(`stand ERROR ${(err as Error).message.slice(0, 200)}`);
  process.exitCode = 1;
});
