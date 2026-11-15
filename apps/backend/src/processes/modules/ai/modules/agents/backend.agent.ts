import { Injectable, Optional } from '@nestjs/common';
import { CryptoService } from '@common/crypto/crypto.service';
import { VaultService } from '@common/vault/vault.service';
import { AppLogger } from '@common/logger';
import { OpencodeModelFetch } from '../opencode/opencode-model-fetch';
import { completeText, type ModelRunResult } from './model-fallback';

/** Domain system prompt for backend tasks (sent as OpenAI-compatible system role). */
export const BACKEND_SYSTEM: string =
  'Ты backend-разработчик Rush Code (NestJS+TS+Drizzle+Zod): проектируешь API, сервисы, БД, миграции и контракты границы. Про фронт и вёрстку не рассуждаешь. Результат — файлы в workspace проекта плюс краткая сводка; ответ только в markdown без файлов запрещён.';

/**
 * Backend agent — backend tasks through the model chain router
 * (`completeText` → `runModelChain`, MODEL_CHAIN order) with the domain system
 * prompt. The provider key is loaded per user inside the chain
 * (`loadProviderKey` + CryptoService): no server key, no fallback to another
 * user's or another provider's key. Without a stored key the chain rethrows the
 * honest 404 `opencode_key_missing` as-is.
 */
@Injectable()
export class BackendAgent {
  readonly id: 'backend' = 'backend';
  readonly name: 'Backend' = 'Backend';
  readonly description: string = 'Backend tasks: API, services, database';

  constructor(
    @Optional() private readonly keys?: VaultService,
    @Optional() private readonly crypto?: CryptoService,
    @Optional() private readonly opencodeFetch?: OpencodeModelFetch,
    private readonly logger: AppLogger = new AppLogger(BackendAgent.name),
  ) {}

  async ask(question: string, userId: string, correlationId?: string): Promise<string> {
    const keys: VaultService | undefined = this.keys;
    const crypto: CryptoService | undefined = this.crypto;
    const opencodeFetch: OpencodeModelFetch | undefined = this.opencodeFetch;
    if (!keys || !crypto || !opencodeFetch) {
      throw new Error('BackendAgent: model provider dependencies are not wired');
    }
    this.logger.info('[agents] backend via router', correlationId);
    const result: ModelRunResult<string> = await completeText({
      userId,
      prompt: question,
      system: BACKEND_SYSTEM,
      correlationId,
      keys,
      crypto,
      inprocessFetch: (targetUserId, providerId, targetCorrelationId) =>
        opencodeFetch.create(targetUserId, providerId, targetCorrelationId),
    });
    return result.value;
  }
}
