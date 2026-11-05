import type { ToolView } from '@rush-code/contracts';
import {
  type ModelEvent,
  type ModelGateway,
  type ModelMessage,
  type ModelRequest,
} from '../model-gateway';

/** Request of one run step (system + skills already resolved by the engine). */
export type ExecutorRequest = {
  model: string;
  system?: string;
  messages: Array<ModelMessage>;
  tools?: Array<ToolView>;
  need: ModelRequest['need'];
};

/** Step-level executor (D-level seam: agents answer steps, ModelGateway is transport). */
export type Executor = {
  readonly id: string;
  stream(req: ExecutorRequest): AsyncIterable<ModelEvent>;
};

/** Default executor: one gateway behind an agent id ('ask' in the prototype). */
export class ModelGatewayExecutor implements Executor {
  constructor(
    readonly id: string,
    private readonly gateway: ModelGateway,
  ) {}

  stream(req: ExecutorRequest): AsyncIterable<ModelEvent> {
    return this.gateway.stream(req);
  }
}
