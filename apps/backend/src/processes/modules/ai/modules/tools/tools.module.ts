import { Module } from '@nestjs/common';
import { WorkspacePathService } from '../../../../../common/storage/workspace-path.service';
import { EditTool } from './edit.tool';
import { GlobTool } from './glob.tool';
import { GrepTool } from './grep.tool';
import { PatchTool } from './patch.tool';
import { ReadTool } from './read.tool';
import { ShellTool } from './shell.tool';
import { TodoTool } from './todo.tool';
import { ToolDispatchService } from './tool-dispatch.service';
import { ToolRegistryService } from './tool-registry.service';
import { ToolsBootstrapService } from './tools.bootstrap';
import { WriteTool } from './write.tool';

/**
 * ToolsModule — MVP tool layer (read/write/edit/glob/grep/shell/patch/todo).
 *
 * Every fs primitive rides WorkspacePathService (single jail, REPOS_ROOT);
 * the registry lists prompt-facing definitions and dispatch settles calls
 * into model-readable results. No PTY, no MCP resources, no plugin host —
 * those stay in the second queue.
 */
@Module({
  providers: [
    WorkspacePathService,
    ToolRegistryService,
    ToolDispatchService,
    ReadTool,
    WriteTool,
    EditTool,
    GlobTool,
    GrepTool,
    ShellTool,
    PatchTool,
    TodoTool,
    ToolsBootstrapService,
  ],
  exports: [ToolRegistryService, ToolDispatchService],
})
export class ToolsModule {}
