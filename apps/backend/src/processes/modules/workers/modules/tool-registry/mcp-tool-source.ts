import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppLogger, serializeCause } from '../../../../../common/logger';
import { McpClient } from './mcp-client';
import { ToolRegistry } from './tool-registry';

/** MCP tool id prefix: ids stay '<mcp|skill|native>:<path>' shaped (D3). */
const MCP_TOOL_PREFIX = 'mcp:';

/**
 * McpToolSource — boot-time discovery of an external MCP server's tools.
 *
 * Consumption only (D5): tools are registered as read-only or write-remote
 * descriptors whose handler is a single JSON-RPC call. An unset MCP_SERVER_URL
 * disables the source; any failure during initialize/list is a WARN + debug
 * cause and never breaks boot (the native tools still serve the run).
 */
@Injectable()
export class McpToolSource implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly logger: AppLogger = new AppLogger(McpToolSource.name),
  ) {}

  async onModuleInit(): Promise<void> {
    const url = (process.env.MCP_SERVER_URL ?? '').trim();
    if (!url) {
      this.logger.debug('[workers] mcp source disabled (MCP_SERVER_URL unset)', '');
      return;
    }

    try {
      const client = new McpClient(url);
      await client.initialize();
      const tools = await client.listTools();
      for (const tool of tools) {
        const id = `${MCP_TOOL_PREFIX}${tool.name.toLowerCase().replace(/[^a-z0-9._/-]/g, '-')}`;
        this.registry.register({
          view: {
            id,
            title: tool.title ?? tool.name,
            description: tool.description ?? `MCP tool ${tool.name}`,
            inputSchema: tool.inputSchema ?? { type: 'object' },
          },
          effects: tool.readOnly ? ['read'] : ['write-remote'],
          handler: (input) => client.callTool(tool.name, input),
        });
      }
      this.logger.info(`[workers] mcp tools registered count=${tools.length}`, '');
    } catch (err) {
      // Remote source is optional: unavailable → native tools only, boot stays up.
      this.logger.warn('[workers] mcp source unavailable', '');
      this.logger.debug(serializeCause(err), '');
    }
  }
}
