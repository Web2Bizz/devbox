/** Верхняя граница числа шагов цепочки (декомпозиция + выполнение). */
export const MAX_STEPS: number = 5;

/** Бюджет накопленного контекста предыдущих шагов в промпте шага. */
export const CONTEXT_LIMIT: number = 6000;

/** Сквозное требование файлового результата (CARD-4 harden, итерация 1). */
export const AUTO_FILES_REQUIREMENT: string =
  'Результат — файлы в workspace проекта плюс краткая сводка; ответ только в markdown без файлов запрещён.';

/** Жёсткая дисциплина shell в шаге цепочки: один вызов = одна команда. */
export const SHELL_STEP_RULE: string =
  'Правила shell: один вызов = одна команда; запрещены &&, ;, |, &, cd, env-префиксы вида KEY=value и фоновые процессы; длинные проверки разбивай на шаги; grep-паттерн с ведущим - только через -- или -e; команды короткие (до 15с), серверы/watch не запускать.';

/**
 * Выделяет пронумерованные шаги из ответа декомпозиции
 * (строки вида "1. …" / "2) …"), пустые отбрасывает, режет до MAX_STEPS.
 */
export function parseSteps(plan: string): Array<string> {
  return plan
    .split('\n')
    .filter((line: string) => /^\s*\d+[.)]\s+/.test(line))
    .map((line: string) => line.replace(/^\s*\d+[.)]\s+/, '').trim())
    .filter((step: string) => step.length > 0)
    .slice(0, MAX_STEPS);
}

/** Промпт декомпозиции: только пронумерованный список шагов. */
export function buildDecomposePrompt(question: string): string {
  const prompt: string = `Разбей задачу на пронумерованные шаги (не более ${MAX_STEPS}), только список без лишнего текста. ${AUTO_FILES_REQUIREMENT} Задача: ${question}`;
  return prompt;
}

/** Промпт одного шага цепочки с накопленным контекстом прошлых шагов. */
export function buildStepPrompt(
  question: string,
  stepNumber: number,
  totalSteps: number,
  step: string,
  context: string,
): string {
  const prompt: string = `Исходная задача: ${question}\nШаг ${stepNumber}/${totalSteps}: ${step}\nПредыдущие результаты:\n${context}\nВыполни этот шаг. ${AUTO_FILES_REQUIREMENT} ${SHELL_STEP_RULE}`;
  return prompt;
}

/** Промпт финального синтеза: файлы в workspace плюс краткая сводка. */
export function buildSynthesizePrompt(question: string, resultsText: string): string {
  const prompt: string = `Исходная задача: ${question}\nРезультаты шагов:\n${resultsText}\nСобери итоговый ответ: перечисли созданные или изменённые файлы в workspace проекта и дай краткую сводку. ${AUTO_FILES_REQUIREMENT}`;
  return prompt;
}
