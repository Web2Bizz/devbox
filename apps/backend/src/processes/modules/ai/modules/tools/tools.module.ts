import { Module } from '@nestjs/common';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { ToolRuntimeModule } from '../tool-runtime/tool-runtime.module';
import { EditTool } from './edit.tool';
import { GlobTool } from './glob.tool';
import { GrepTool } from './grep.tool';
import { PatchTool } from './patch.tool';
import { ReadTool } from './read.tool';
import { ShellTool } from './shell.tool';
import { TodoTool } from './todo.tool';
import { ToolsBootstrapService } from './tools.bootstrap';
import { WriteTool } from './write.tool';

/**
 * ToolsModule — the MVP tool handlers (read/write/edit/glob/grep/shell/patch/
 * todo) plus their bootstrap, nothing else.
 *
 * Every fs primitive rides WorkspacePathService (single jail, REPOS_ROOT).
 * The runtime itself — the registry and the dispatcher — lives in the sibling
 * `ToolRuntimeModule`: this module imports it, so `ToolsBootstrapService`
 * registers the handlers into the very registry instance the dispatcher and
 * the runner see. No PTY, no MCP resources, no plugin host — those stay in the
 * second queue.
 */
@Module({
  imports: [ToolRuntimeModule],
  providers: [
    WorkspacePathService,
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
})
export class ToolsModule {}
