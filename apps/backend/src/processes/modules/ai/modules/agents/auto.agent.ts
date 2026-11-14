import { Injectable } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import { JevService, type JevClassifyResult } from '@common/zen/jev.service';
import { AskAgent } from './ask.agent';
import { BackendAgent } from './backend.agent';
import { FrontendAgent } from './frontend.agent';
import { FullstackAgent } from './fullstack.agent';
import { WorkflowsService } from '../workflows/workflows.service';

/** Честный ответ на непонятный запрос — фиксированный текст, без гадания. */
export const UNCLEAR_REQUEST_MESSAGE: string =
  'Не понял запрос: непонятно, это backend, frontend или fullstack-задача. Уточни: что сделать, где (сервис/страница/оба) и что должно получиться.';

/** Совместимость: переэкспорт цепочных примитивов из WORKFLOWS-слоя. */
export {
  AUTO_FILES_REQUIREMENT,
  parseSteps,
} from '../workflows/utils/chain-steps';

type DomainExecutorClass = BackendAgent | FrontendAgent | FullstackAgent;

/**
 * Auto agent — EXECUTOR of the 'routed-chain' workflow (MODES: 'auto' mode
 * selects this workflow, it never selects itself). Роутит запрос через Jev на
 * backend|frontend|fullstack|ask и выполняет цепочку выбранным доменным
 * исполнителем через WorkflowsService (декомпозиция, шаги и синтез — все
 * доменным взглядом, прямых вызовов runner здесь нет).
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
    private readonly workflows: WorkflowsService,
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
    const executor: DomainExecutorClass = this.executorFor(routing.route);
    return this.workflows.runRoutedChain(executor, question, userId, correlationId);
  }

  private executorFor(route: 'backend' | 'frontend' | 'fullstack'): DomainExecutorClass {
    if (route === 'frontend') return this.frontend;
    if (route === 'fullstack') return this.fullstack;
    return this.backend;
  }
}
