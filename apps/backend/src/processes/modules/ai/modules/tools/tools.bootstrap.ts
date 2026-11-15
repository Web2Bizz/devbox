import { Injectable } from '@nestjs/common';
import { EditTool } from './edit.tool';
import { GlobTool } from './glob.tool';
import { GrepTool } from './grep.tool';
import { PatchTool } from './patch.tool';
import { ReadTool } from './read.tool';
import { ShellTool } from './shell.tool';
import { TodoTool } from './todo.tool';
import { ToolRegistryService } from '../tool-registry/tool-registry.service';
import type { ToolHandler } from '../tool-runtime/tool-runtime.types';
import { WriteTool } from './write.tool';

/**
 * Registers every provided tool with the registry once at boot. A separate
 * provider (not the registry constructor) keeps the registry dependency-free
 * and lets specs register only the handlers they exercise.
 */
@Injectable()
export class ToolsBootstrapService {
  constructor(
    private readonly registry: ToolRegistryService,
    private readonly read: ReadTool,
    private readonly write: WriteTool,
    private readonly edit: EditTool,
    private readonly glob: GlobTool,
    private readonly grep: GrepTool,
    private readonly shell: ShellTool,
    private readonly patch: PatchTool,
    private readonly todo: TodoTool,
  ) {
    const tools: Array<ToolHandler> = [
      this.read,
      this.write,
      this.edit,
      this.glob,
      this.grep,
      this.shell,
      this.patch,
      this.todo,
    ];
    this.registry.registerAll(tools);
  }
}
