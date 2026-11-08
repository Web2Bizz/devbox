/**
 * draft-stand assertions — чистые проверки R1–R6 (S0).
 *
 * Без I/O, без секретов: на вход — только факты (счётчики, флаги, длины),
 * на выход — вердикт. Значения ключей сюда не передаются никогда.
 */

export type Verdict = 'PASS' | 'FAIL' | 'SKIP';

export type Assertion = {
  id: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';
  status: Verdict;
  /** Без секретов: только коды, длины, пути, поля. */
  detail: string;
};

function verdict(id: Assertion['id'], status: Verdict, detail: string): Assertion {
  return { id, status, detail };
}

/**
 * R1: LLM.stream с tools не исполняет инструменты.
 * dispatchCalls — число вызовов ToolDispatchService за прогон (ожидается 0).
 * sideEffects — были ли побочные эффекты (записи ФС, вызовы инструментов).
 */
export function assertR1(dispatchCalls: number, sideEffects: boolean): Assertion {
  if (dispatchCalls !== 0) {
    return verdict('R1', 'FAIL', `dispatchCalls=${dispatchCalls} expected=0`);
  }
  if (sideEffects) {
    return verdict('R1', 'FAIL', 'sideEffects=true expected=false');
  }
  return verdict('R1', 'PASS', 'dispatchCalls=0 sideEffects=false');
}

/**
 * R2: @opencode/ai напрямую с точной версией.
 * directVersion — значение из apps/backend/package.json dependencies
 * (ожидается точный пин без ^/~, например 2.2.5).
 */
export function assertR2(directVersion: string | null, expected: string): Assertion {
  if (directVersion === null) {
    return verdict('R2', 'FAIL', `missing direct dep expected=${expected}`);
  }
  if (directVersion !== expected) {
    return verdict('R2', 'FAIL', `direct=${directVersion} expected=${expected}`);
  }
  if (/^[\^~]/.test(directVersion)) {
    return verdict('R2', 'FAIL', `direct=${directVersion} not-pinned`);
  }
  return verdict('R2', 'PASS', `direct=${directVersion} pinned`);
}

/**
 * R3: сборка LanguageModel из (провайдер, модель) + ключ пользователя,
 * без opencode.json и без глобального env.
 */
export function assertR3(input: {
  hasPerCallKey: boolean;
  readOpencodeJson: boolean;
  usedGlobalEnvKey: boolean;
}): Assertion {
  if (!input.hasPerCallKey) {
    return verdict('R3', 'SKIP', 'no per-call key (auth.json missing)');
  }
  if (input.readOpencodeJson) {
    return verdict('R3', 'FAIL', 'opencode.json was read');
  }
  if (input.usedGlobalEnvKey) {
    return verdict('R3', 'FAIL', 'global env key was used');
  }
  return verdict('R3', 'PASS', 'per-call key no-config no-global-env');
}

/**
 * R4: git status и файлы не меняются.
 */
export function assertR4(input: {
  before: string | null;
  after: string | null;
}): Assertion {
  if (input.before === null || input.after === null) {
    return verdict('R4', 'SKIP', 'git status unavailable');
  }
  if (input.before !== input.after) {
    return verdict('R4', 'FAIL', 'git status changed');
  }
  return verdict('R4', 'PASS', 'git status unchanged');
}

/**
 * R5: tool_calls в нашем формате, стрим и usage приходят.
 * toolCalls — число распознанных вызовов; streamChunks — число SSE-дельт;
 * hasUsage — пришёл ли usage; badArgs — число битых аргументов.
 */
export function assertR5(input: {
  called: boolean;
  toolCalls: number;
  streamChunks: number;
  hasUsage: boolean;
  badArgs: number;
}): Assertion {
  if (!input.called) {
    return verdict('R5', 'SKIP', 'model not called (no key or dry)');
  }
  if (input.streamChunks < 1) {
    return verdict('R5', 'FAIL', `streamChunks=${input.streamChunks} expected>=1`);
  }
  if (!input.hasUsage) {
    return verdict('R5', 'FAIL', 'usage missing');
  }
  if (input.badArgs > 0) {
    return verdict('R5', 'FAIL', `badArgs=${input.badArgs}`);
  }
  if (input.toolCalls < 1) {
    return verdict('R5', 'FAIL', `toolCalls=${input.toolCalls} expected>=1`);
  }
  return verdict(
    'R5',
    'PASS',
    `toolCalls=${input.toolCalls} streamChunks=${input.streamChunks} usage=yes`,
  );
}

/**
 * R6: модели с tools — из каталога в процессе, не статика.
 */
export function assertR6(input: {
  called: boolean;
  fromCatalog: boolean;
  toolsCapable: number;
}): Assertion {
  if (!input.called) {
    return verdict('R6', 'SKIP', 'catalog not queried (no key or dry)');
  }
  if (!input.fromCatalog) {
    return verdict('R6', 'FAIL', 'models from static list');
  }
  if (input.toolsCapable < 1) {
    return verdict('R6', 'FAIL', `toolsCapable=${input.toolsCapable} expected>=1`);
  }
  return verdict('R6', 'PASS', `catalog=yes toolsCapable=${input.toolsCapable}`);
}
