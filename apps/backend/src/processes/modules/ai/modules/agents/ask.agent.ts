import { Injectable, Optional } from '@nestjs/common';
import { CryptoService } from '@common/crypto/crypto.service';
import { VaultService } from '@common/vault/vault.service';
import { AppLogger } from '@common/logger';
import { OpencodeModelFetch } from '../opencode/opencode-model-fetch';
import { completeText, type ModelRunResult } from './model-fallback';

/**
 * Ask agent — answers user questions through the model chain router
 * (`completeText` → `runModelChain`, MODEL_CHAIN order). The provider key is
 * loaded per user inside the chain (`loadProviderKey` + CryptoService): no
 * server key, no fallback to another user's or another provider's key.
 * Without a stored key the chain rethrows the honest 404
 * `opencode_key_missing` (same code as billing) as-is.
 */
@Injectable()
export class AskAgent {
  readonly id: 'ask' = 'ask';
  readonly name: 'Ask' = 'Ask';
  readonly description: string = 'Single-answer mode: one direct answer, no steps';

  constructor(
    @Optional() private readonly keys?: VaultService,
    @Optional() private readonly crypto?: CryptoService,
    @Optional() private readonly opencodeFetch?: OpencodeModelFetch,
    private readonly logger: AppLogger = new AppLogger(AskAgent.name),
  ) {}

  async ask(question: string, userId: string, correlationId?: string): Promise<string> {
    const keys: VaultService | undefined = this.keys;
    const crypto: CryptoService | undefined = this.crypto;
    const opencodeFetch: OpencodeModelFetch | undefined = this.opencodeFetch;
    if (!keys || !crypto || !opencodeFetch) {
      throw new Error('AskAgent: model provider dependencies are not wired');
    }
    this.logger.info('[agents] ask via router', correlationId);
    const result: ModelRunResult<string> = await completeText({
      userId,
      prompt: question,
      correlationId,
      keys,
      crypto,
      inprocessFetch: (targetUserId, providerId, targetCorrelationId) =>
        opencodeFetch.create(targetUserId, providerId, targetCorrelationId),
    });
    return result.value;
  }
}
