import { Injectable, Optional } from '@nestjs/common';
import { CryptoService } from '@common/crypto/crypto.service';
import { VaultService } from '@common/vault/vault.service';
import { AppLogger } from '@common/logger';
import { OpencodeModelFetch } from '../opencode/opencode-model-fetch';
import { completeText, type ModelRunResult } from './model-fallback';

/** Domain system prompt for end-to-end tasks (sent as OpenAI-compatible system role). */
export const FULLSTACK_SYSTEM: string =
  'Ты fullstack-разработчик Rush Code: связываешь фронт и бэк через контракты, ведёшь сквозные задачи в порядке бэк, контракт, фронт. Результат — файлы в workspace проекта плюс краткая сводка; ответ только в markdown без файлов запрещён.';

/**
 * Fullstack agent — end-to-end tasks through the model chain router
 * (`completeText` → `runModelChain`, MODEL_CHAIN order) with the domain system
 * prompt. The provider key is loaded per user inside the chain
 * (`loadProviderKey` + CryptoService): no server key, no fallback to another
 * user's or another provider's key. Without a stored key the chain rethrows the
 * honest 404 `opencode_key_missing` as-is.
 */
@Injectable()
export class FullstackAgent {
  readonly id: 'fullstack' = 'fullstack';
  readonly name: 'Fullstack' = 'Fullstack';
  readonly description: string = 'End-to-end tasks across frontend and backend';

  constructor(
    @Optional() private readonly keys?: VaultService,
    @Optional() private readonly crypto?: CryptoService,
    @Optional() private readonly opencodeFetch?: OpencodeModelFetch,
    private readonly logger: AppLogger = new AppLogger(FullstackAgent.name),
  ) {}

  async ask(question: string, userId: string, correlationId?: string): Promise<string> {
    const keys: VaultService | undefined = this.keys;
    const crypto: CryptoService | undefined = this.crypto;
    const opencodeFetch: OpencodeModelFetch | undefined = this.opencodeFetch;
    if (!keys || !crypto || !opencodeFetch) {
      throw new Error('FullstackAgent: model provider dependencies are not wired');
    }
    this.logger.info('[agents] fullstack via router', correlationId);
    const result: ModelRunResult<string> = await completeText({
      userId,
      prompt: question,
      system: FULLSTACK_SYSTEM,
      correlationId,
      keys,
      crypto,
      inprocessFetch: (targetUserId, providerId, targetCorrelationId) =>
        opencodeFetch.create(targetUserId, providerId, targetCorrelationId),
    });
    return result.value;
  }
}
