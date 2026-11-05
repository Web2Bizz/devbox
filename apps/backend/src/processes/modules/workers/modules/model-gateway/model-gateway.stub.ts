import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../../common/logger';
import { ModelGateway, type ModelEvent, type ModelRequest } from './model-gateway';

/**
 * StubModelGateway — the prototype's only provider.
 *
 * A real transport is out of scope here: the point is the run engine, not the
 * model. The stub answers one fixed turn; the NORMALIZED response (text +
 * usage) is journaled as the llm.call step result, which is exactly the shape
 * a real provider will fill later.
 */
@Injectable()
export class StubModelGateway extends ModelGateway {
  constructor(private readonly logger: AppLogger = new AppLogger(StubModelGateway.name)) {
    super();
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    this.logger.info(`[workers] llm.call model=${req.model} tools=${req.tools?.length ?? 0}`);
    yield { type: 'delta', text: 'stub-turn' };
    yield { type: 'done', usage: { in: 0, out: 1 } };
  }
}
