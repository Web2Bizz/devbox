import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ToolView } from '@rush-code/contracts';
import { canonicalJson } from '@common/canonical-json/canonical-json';
import { AppLogger } from '@common/logger';
import { createGitReconTool } from './tools/git-recon.tool';

export type ToolEffect = 'read' | 'write-local' | 'write-remote' | 'exec';

export type ToolContext = { cwd: string };

export type ToolHandler = (
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<Record<string, unknown>>;

export type ToolDescriptor = {
  view: ToolView;
  effects: ReadonlyArray<ToolEffect>;
  handler: ToolHandler;
};

export type ToolInvokeResult = {
  output: Record<string, unknown>;
  requestHash: string;
  responseHash: string;
  attempt: number;
  durationMs: number;
  bytesIn: number;
  bytesOut: number;
};

/** sha256 hex of an already-serialized payload (canonical JSON for objects). */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * ToolRegistry — the only place a tool is described and invoked.
 *
 * `listViews()` is the model-facing projection (ToolView only, no effects and
 * no handler), so D3 holds by construction: the model can never see or reach
 * policy. `invoke()` hashes the canonical request/response so a replay can be
 * compared byte-for-byte and the step journal records what actually ran.
 */
@Injectable()
export class ToolRegistry {
  private readonly tools: Map<string, ToolDescriptor> = new Map<string, ToolDescriptor>();

  constructor(private readonly logger: AppLogger = new AppLogger(ToolRegistry.name)) {
    this.register(createGitReconTool());
  }

  /** Registers a descriptor; a duplicate id is a programming error, never a silent overwrite. */
  register(tool: ToolDescriptor): void {
    if (this.tools.has(tool.view.id)) {
      throw new Error(`duplicate tool id ${tool.view.id}`);
    }
    this.tools.set(tool.view.id, tool);
    this.logger.debug(`[workers] tool registered id=${tool.view.id}`);
  }

  /** All tool views (projection only — no effects, no handlers). */
  listViews(): Array<ToolView> {
    return Array.from(this.tools.values(), (tool) => tool.view);
  }

  get(id: string): ToolDescriptor | undefined {
    return this.tools.get(id);
  }

  /**
   * Runs one tool attempt. Request/response hashes are canonical sha256
   * digests, so a jsonb round-trip of the recorded result stays verifiable.
   */
  async invoke(
    id: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolInvokeResult> {
    const tool: ToolDescriptor | undefined = this.tools.get(id);
    if (!tool) throw new Error(`unknown tool ${id}`);

    const requestJson: string = canonicalJson({ id, input });
    const requestHash: string = sha256(requestJson);
    const startedAt: number = Date.now();
    const output: Record<string, unknown> = await tool.handler(input, context);
    const durationMs: number = Date.now() - startedAt;
    const responseJson: string = canonicalJson(output);

    return {
      output,
      requestHash,
      responseHash: sha256(responseJson),
      attempt: 1,
      durationMs,
      bytesIn: Buffer.byteLength(requestJson, 'utf8'),
      bytesOut: Buffer.byteLength(responseJson, 'utf8'),
    };
  }
}
