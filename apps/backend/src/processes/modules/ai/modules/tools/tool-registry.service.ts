import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../../common/logger';
import type { ToolDefinition, ToolHandler } from './tool.types';

/**
 * Registry of AI tools: one handler per full name (`name` or
 * `namespace.name`), registration is idempotent per name (last wins, logged
 * once) and listing feeds the prompt. Unknown names resolve to null — the
 * dispatcher answers an error-result instead of throwing.
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger: AppLogger = new AppLogger(ToolRegistryService.name);
  private readonly tools = new Map<string, ToolHandler>();

  register(tool: ToolHandler): void {
    if (this.tools.has(tool.fullName)) {
      this.logger.warn(`[tools] duplicate registration name=${tool.fullName}`);
    }
    this.tools.set(tool.fullName, tool);
  }

  registerAll(tools: ReadonlyArray<ToolHandler>): void {
    for (const tool of tools) this.register(tool);
  }

  listForPrompt(): Array<ToolDefinition> {
    return Array.from(this.tools.values()).map((tool) => tool.definition);
  }

  names(): Array<string> {
    return Array.from(this.tools.keys());
  }

  resolve(name: string): ToolHandler | null {
    return this.tools.get(name) ?? null;
  }
}
