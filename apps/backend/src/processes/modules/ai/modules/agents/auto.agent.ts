import { Injectable } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import { JevService, type JevClassifyResult } from '@common/zen/jev.service';
import { AskAgent } from './ask.agent';
import { BackendAgent } from './backend.agent';
import { FrontendAgent } from './frontend.agent';
import { FullstackAgent } from './fullstack.agent';

/** Верхняя граница числа шагов цепочки (декомпозиция + выполнение). */
const MAX_STEPS: number = 5;

/** Бюджет накопленного контекста предыдущих шагов в промпте шага. */
const CONTEXT_LIMIT: number = 6000;

/** Честный ответ на непонятный запрос — фиксированный текст, без гадания. */
export const UNCLEAR_REQUEST_MESSAGE: string =
  'Не понял запрос: непонятно, это backend, frontend или fullstack-задача. Уточни: что сделать, где (сервис/страница/оба) и что должно получиться.';

/** Сквозное требование файлового результата (CARD-4 harden, итерация 1). */
export const AUTO_FILES_REQUIREMENT: string =
  'Результат — файлы в workspace проекта плюс краткая сводка; ответ только в markdown без файлов запрещён.';

type DomainExecutor = BackendAgent | FrontendAgent | FullstackAgent;

/**
 * Выделяет пронумерованные шаги из ответа декомпозиции
 * (строки вида "1. …" / "2) …"), пустые отбрасывает, режет до MAX_STEPS.
 */
export function parseSteps(plan: string): Array<string> {
  return plan
    .split('\n')
    .filter((line) => /^\s*\d+[.)]\s+/.test(line))
    .map((line) => line.replace(/^\s*\d+[.)]\s+/, '').trim())
    .filter((step) => step.length > 0)
    .slice(0, MAX_STEPS);
}

/**
 * Auto agent — роутит запрос через Jev на backend|frontend|fullstack|ask и
 * выполняет цепочку выбранным доменным исполнителем (декомпозиция, шаги и
 * синтез — все доменным взглядом, прямых вызовов runner здесь нет).
 * 'ask' → прямой ответ AskAgent без декомпозиции/цепочки.
 * 'unclear' → фиксированный честный текст без гадания. Fail-fast доменного
 * агента (404/401 ключа) пробрасывается как есть; падение шага обрывает
 * цепочку (без частичных ответов-моков).
 */
@Injectable()
export class AutoAgent {
  readonly id: 'auto' = 'auto';
  readonly name: 'Auto' = 'Auto';
  readonly description: string =
    'Router mode: classifies the request and runs the backend, frontend or fullstack workflow';

  constructor(
    private readonly backend: BackendAgent,
    private readonly frontend: FrontendAgent,
    private readonly fullstack: FullstackAgent,
    private readonly jev: JevService,
    private readonly askAgent: AskAgent,
    private readonly logger: AppLogger = new AppLogger(AutoAgent.name),
  ) {}

  async ask(question: string, userId: string, correlationId?: string): Promise<string> {
    // STEP 0 — paid Jev router (System One, choice-only, jev-1.13: +1 billed
    // call per Auto request): backend|frontend|fullstack → chain via that
    // domain executor; 'ask' → direct AskAgent answer (no chain);
    // 'unclear' → fixed honest text (no guessing).
    // The returned chat text stays clean — the route is visible only in logs.
    const routing: JevClassifyResult = await this.jev.classify(question, userId, {
      correlationId,
    });
    this.logger.info(
      `[agents] auto route=${routing.route} confidence=${routing.confidence ?? 'none'} provider=${routing.provider}`,
      correlationId,
    );
    if (routing.route === 'ask') {
      this.logger.info('[agents] auto route=ask direct', correlationId);
      return this.askAgent.ask(question, userId, correlationId);
    }
    if (routing.route === 'unclear') {
      this.logger.info('[agents] auto route=unclear honest-answer', correlationId);
      return UNCLEAR_REQUEST_MESSAGE;
    }
    const executor: DomainExecutor = this.executorFor(routing.route);
    return this.runChain(question, userId, correlationId, executor);
  }

  private executorFor(route: 'backend' | 'frontend' | 'fullstack'): DomainExecutor {
    if (route === 'frontend') return this.frontend;
    if (route === 'fullstack') return this.fullstack;
    return this.backend;
  }

  private async runChain(
    question: string,
    userId: string,
    correlationId: string | undefined,
    execute: DomainExecutor,
  ): Promise<string> {
    this.logger.info('[agents] auto decompose', correlationId);
    const plan: string = await execute.ask(
      `Разбей задачу на пронумерованные шаги (не более ${MAX_STEPS}), только список без лишнего текста. ${AUTO_FILES_REQUIREMENT} Задача: ${question}`,
      userId,
      correlationId,
    );
    let steps: Array<string> = parseSteps(plan);
    if (steps.length === 0) {
      this.logger.info('[agents] auto single-step fallback', correlationId);
      steps = [question];
    } else {
      this.logger.info(`[agents] auto steps count=${steps.length}`, correlationId);
    }

    const results: Array<string> = [];
    for (let index = 0; index < steps.length; index++) {
      this.logger.info(
        `[agents] auto step start index=${index + 1} total=${steps.length}`,
        correlationId,
      );
      const context: string = results.join('\n').slice(-CONTEXT_LIMIT);
      try {
        const stepResult: string = await execute.ask(
          `Исходная задача: ${question}\nШаг ${index + 1}/${steps.length}: ${steps[index]}\nПредыдущие результаты:\n${context}\nВыполни этот шаг. ${AUTO_FILES_REQUIREMENT}`,
          userId,
          correlationId,
        );
        results.push(stepResult);
        this.logger.info(
          `[agents] auto step done index=${index + 1} total=${steps.length}`,
          correlationId,
        );
      } catch (error) {
        this.logger.warn(
          `[agents] auto step failed index=${index + 1} total=${steps.length}`,
          correlationId,
        );
        throw error;
      }
    }

    this.logger.info('[agents] auto synthesize', correlationId);
    return execute.ask(
      `Исходная задача: ${question}\nРезультаты шагов:\n${results.join('\n').slice(-CONTEXT_LIMIT)}\nСобери итоговый ответ: перечисли созданные или изменённые файлы в workspace проекта и дай краткую сводку. ${AUTO_FILES_REQUIREMENT}`,
      userId,
      correlationId,
    );
  }
}
