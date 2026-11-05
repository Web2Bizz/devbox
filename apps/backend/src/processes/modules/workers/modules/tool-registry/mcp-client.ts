import { AppLogger } from '../../../../../common/logger';

export type McpToolDescriptor = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly?: boolean;
};

type RpcReply = { result: unknown; sessionId: string | null };

type RpcEnvelope = { result?: unknown; error?: unknown };

/**
 * McpClient — stateless MCP consumption (D5): every call is a single JSON-RPC
 * POST, the only carried state is the optional `mcp-session-id` header the
 * server hands back on initialize.
 *
 * TODO(mcp-dual-era): the prototype speaks the streamable-HTTP transport
 * only (JSON or `text/event-stream` answer). Legacy SSE transports and
 * reconnects are out of scope; a server that rejects the modern handshake is
 * probed exactly once with the legacy initialize → `notifications/initialized`
 * sequence (`fallbackUsed` keeps it to one attempt, so a broken server cannot
 * loop us).
 */
export class McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private initialized = false;
  private fallbackUsed = false;

  constructor(
    private readonly url: string,
    private readonly logger: AppLogger = new AppLogger(McpClient.name),
  ) {}

  /** Modern handshake: `initialize` then the best-effort initialized notification. */
  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'rush-code-harness', version: '0.1.0' },
    });
    await this.notify('notifications/initialized');
  }

  /** Lists the server tools (projection only — never invoked here). */
  async listTools(): Promise<Array<McpToolDescriptor>> {
    const { result } = await this.rpc('tools/list', {});
    const tools = (result as { tools?: unknown } | null)?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.map((raw) => {
      const tool = (raw ?? {}) as Record<string, unknown>;
      const annotations = (tool.annotations ?? {}) as Record<string, unknown>;
      return {
        name: typeof tool.name === 'string' ? tool.name : '',
        ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(tool.inputSchema !== null && typeof tool.inputSchema === 'object'
          ? { inputSchema: tool.inputSchema as Record<string, unknown> }
          : {}),
        readOnly: Boolean(annotations?.readOnlyHint),
      };
    });
  }

  /** Invokes one tool; the raw result object is the tool output. */
  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { result } = await this.rpc('tools/call', { name, arguments: args });
    if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return { content: result };
  }

  /** One JSON-RPC round trip (no retry — the MCP source registers what it got). */
  private async rpc(method: string, params: Record<string, unknown>): Promise<RpcReply> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(Number(process.env.REQUEST_TIMEOUT_MS ?? 30000)),
    });

    // One legacy handshake attempt: a modern-only server answers 400 to a
    // session-less call before initialize, so re-handshake once and replay.
    if (res.status === 400 && !this.fallbackUsed && method !== 'initialize') {
      this.fallbackUsed = true;
      await this.initializeLegacy();
      return this.rpc(method, params);
    }
    if (!res.ok) throw new Error(`mcp ${method} status=${res.status}`);

    const contentType = res.headers.get('content-type') ?? '';
    const sessionId = res.headers.get('mcp-session-id') ?? this.sessionId;

    let envelope: RpcEnvelope;
    if (contentType.includes('text/event-stream')) {
      const text = await res.text();
      const dataLines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'));
      const last = dataLines[dataLines.length - 1];
      if (!last) throw new Error(`mcp ${method} empty event stream`);
      envelope = JSON.parse(last.slice('data:'.length).trim()) as RpcEnvelope;
    } else {
      envelope = (await res.json()) as RpcEnvelope;
    }
    if (envelope.error !== undefined) throw new Error('mcp rpc error');

    if (method === 'initialize') {
      this.sessionId = sessionId;
      this.initialized = true;
    }
    return { result: envelope.result, sessionId };
  }

  /** Legacy probe: fresh handshake (drop a stale session header) + initialized note. */
  private async initializeLegacy(): Promise<void> {
    this.logger.debug('[workers] mcp legacy initialize fallback', '');
    this.sessionId = null;
    this.initialized = false;
    await this.initialize();
  }

  /** Fire-and-forget notification (no id, no result) — never breaks the source. */
  private async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: AbortSignal.timeout(Number(process.env.REQUEST_TIMEOUT_MS ?? 30000)),
      });
    } catch {
      // Best-effort: a server without the notification still answers tools/list.
    }
  }
}
