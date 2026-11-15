import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import path from 'node:path';
import { fromUnknown } from '@common/external/external-error';
import { AppLogger } from '@common/logger';
import { WorkspacePathService } from '@common/storage/workspace-path.service';
import { OpencodeHostService } from '../../../opencode/opencode-host.service';
import { SessionHistoryRepository } from '../../session-history.repository';
import type { SessionMessage } from '../../sessions.dto';
import type { SessionTurnInput } from '../../sessions.types';
import {
  formatShellOutput,
  parseCreateFileCommand,
  parseReadFileCommand,
  parseShellCommand,
} from '../../utils/session-commands';
import { SessionFrameBufferService } from '../events/session-frame-buffer.service';
import { SessionRuntimeStateService } from '../state/session-runtime-state.service';
import { TurnWorkspaceService } from '../workspace/turn-workspace.service';

/** Answer text cap for file/shell output echoed into the durable thread. */
const ANSWER_MAX_CHARS: number = 8000;
/** Shell command cap (one line, same bound as the harness). */
const SHELL_COMMAND_MAX_CHARS: number = 500;
/** Chunk size of the contract-narrowed delta frames. */
const SSE_CHUNK: number = 200;

/**
 * FileCommandTurnService — deterministic jailed file/shell commands.
 *
 * Minimal file/shell toolset for the text-only direct path (the runner has no
 * tools and no working directory, so a "создай файл …" prompt would otherwise
 * answer text without touching `content/`). Commands run against the
 * ALREADY-gated project content dir (`resolveProjectDirectory` upstream — the
 * same jail `create()` passes as the embedded host session location), never
 * against tmpdir or the host root:
 *
 * - create/write: «создай файл <name> [с текстом <text>]» /
 *   "create file <name> [with text <text>]" → jailed writeFile (+mkdir -p
 *   for nested dirs), durable user+assistant rows, SSE frames buffered;
 * - read: «прочитай|покажи файл <name>» / "read|show file <name>" →
 *   jailed readFile, content echoed in the assistant row (missing file is an
 *   honest text answer, not a 404);
 * - shell: «выполни <cmd>» / "run <cmd>" / "shell: <cmd>" → ephemeral host
 *   session in the same jail via OpencodeHostService.sessionShell
 *   (SandboxProvider pattern), stdout echoed truncated in the assistant row.
 *
 * Traversal (`..`, absolute paths, null bytes) answers 403 via the same
 * lexical jail WorkspacePathService enforces; disk/shell outages map to
 * EXTERNAL_* (never a mock). Returns null when the text is not a file/shell
 * command, or when the jail primitives are not wired (hand-wired specs).
 */
@Injectable()
export class FileCommandTurnService {
  constructor(
    private readonly host: OpencodeHostService,
    private readonly history: SessionHistoryRepository,
    private readonly workspace: TurnWorkspaceService,
    private readonly state: SessionRuntimeStateService,
    private readonly buffer: SessionFrameBufferService,
    @Optional() private readonly paths?: WorkspacePathService,
    private readonly logger: AppLogger = new AppLogger(FileCommandTurnService.name),
  ) {}

  /** Handle a deterministic file/shell command, or null for a regular prompt. */
  async tryHandle(input: SessionTurnInput): Promise<SessionMessage | null> {
    const paths: WorkspacePathService | undefined = this.paths;
    if (!paths) return null;
    const { userId, sessionId, body, directory, agentId, correlationId } = input;
    const text: string = body.text ?? '';
    const created: { filename: string; content: string } | null = parseCreateFileCommand(text);
    const readCommand: { filename: string } | null = created ? null : parseReadFileCommand(text);
    const shellCommand: string | null = created || readCommand ? null : parseShellCommand(text);
    if (!created && !readCommand && !shellCommand) return null;
    // Jail first: a traversal escape answers 403 with NO durable side effects
    // (no staged user row for a rejected command).
    const createdAbsolutePath: string | null = created
      ? this.jailFile(directory, created.filename)
      : null;
    const readAbsolutePath: string | null =
      !created && readCommand ? this.jailFile(directory, readCommand.filename) : null;
    if (body.agentId !== undefined) {
      await this.history.setAgent(sessionId, body.projectId, agentId);
    }
    const receipt: SessionMessage = {
      id: Bun.randomUUIDv7(),
      type: 'user',
      createdAt: new Date().toISOString(),
      text: body.text,
      parentId: await this.history.resolveAppendParent(sessionId, body.parentId),
    };
    await this.history.appendMessage({
      id: receipt.id,
      sessionId,
      userId,
      role: 'user',
      agentId,
      text: body.text,
      createdAt: receipt.createdAt,
      parentId: receipt.parentId ?? null,
    });
    await this.workspace.captureBeforeTurn(directory, sessionId, receipt.id, correlationId);
    this.state.markBusy(sessionId);
    // Real deterministic tool behind this turn (registry names, never the
    // agent id): create → `write`, read → `read` (readonly), shell → `shell`.
    // The lifecycle frames below carry exactly this name so the chat timeline
    // shows the real call — a `tool: '<agentId>'` frame would be a fake.
    const toolName: string = created ? 'write' : readCommand ? 'read' : 'shell';
    this.bufferDirectLifecycleStart(sessionId, toolName, receipt.id);
    try {
      let answer: string;
      if (created && createdAbsolutePath) {
        const absolutePath: string = createdAbsolutePath;
        await paths.ensureDir(path.dirname(absolutePath));
        try {
          await paths.writeFile(absolutePath, created.content);
        } catch (error) {
          throw fromUnknown('opencode', 'sessionFileWrite', error);
        }
        this.logger.info('[sessions] file created', correlationId);
        answer = `Файл ${created.filename} создан.`;
      } else if (readCommand && readAbsolutePath) {
        const absolutePath: string = readAbsolutePath;
        try {
          const content: string = await paths.readFile(absolutePath);
          answer =
            content.length > 0 ? content.slice(0, ANSWER_MAX_CHARS) : '(пустой файл)';
        } catch {
          answer = `Файл ${readCommand.filename} не найден.`;
        }
        this.logger.info('[sessions] file read', correlationId);
      } else {
        const shellOutput: unknown = await this.host.sessionShell(
          directory,
          (shellCommand as string).slice(0, SHELL_COMMAND_MAX_CHARS),
        );
        answer = formatShellOutput(shellOutput).slice(0, ANSWER_MAX_CHARS) || '(без вывода)';
        this.logger.info('[sessions] shell executed', correlationId);
      }
      // Durable chain (0012): one kind=tool link (real registry name) with
      // parent=receipt, the assistant text closes the chain on the tool.
      // Detail is a redacted single-line 500-char snippet, never secrets.
      const toolId: string = Bun.randomUUIDv7();
      const assistant: SessionMessage = {
        id: Bun.randomUUIDv7(),
        type: 'assistant',
        createdAt: new Date().toISOString(),
        text: answer,
        parentId: toolId,
      };
      await this.history.appendMessage({
        id: toolId,
        sessionId,
        userId,
        role: 'tool',
        agentId,
        text: answer.slice(0, 2000) || null,
        createdAt: new Date().toISOString(),
        parentId: receipt.id,
        kind: 'tool',
        name: toolName,
        status: 'done',
        detail: this.toSafeDetail(answer),
      });
      await this.history.appendMessage({
        id: assistant.id,
        sessionId,
        userId,
        role: 'assistant',
        agentId,
        text: answer,
        createdAt: assistant.createdAt,
        parentId: toolId,
      });
      this.bufferDirectFrames(sessionId, assistant);
      this.bufferDirectLifecycleEnd(sessionId, toolName, receipt.id);
      this.bufferDirectIdle(sessionId);
      return receipt;
    } finally {
      this.state.clearBusy(sessionId);
    }
  }

  /**
   * Lexical jail for a file-tool target: the absolute target must stay
   * inside the gated project content dir (the same jail `create()` passes
   * as the host session location). Escapes answer 403 — never tmpdir, never
   * the host root.
   */
  private jailFile(directory: string, filename: string): string {
    const absolutePath: string = path.resolve(directory, filename);
    if (absolutePath !== directory && !absolutePath.startsWith(directory + path.sep)) {
      throw new ForbiddenException('Path traversal is forbidden');
    }
    return absolutePath;
  }

  /**
   * Live-only lifecycle markers for the deterministic turn: one reasoning
   * pair plus the REAL tool call (`write`/`read`/`shell` — the registry name
   * of the command that actually ran, never the agent id). Markers ride the
   * same bounded frame buffer (project-scoped via data.sessionID, filtered
   * by streamEvents like text), never durable. The readonly `read` call is
   * the ask-mode-visible proof that real readonly tools keep their real
   * names end-to-end (text answer untouched — tool payloads never enter the
   * text frames below).
   */
  private bufferDirectLifecycleStart(
    sessionId: string,
    toolName: string,
    parentId?: string | null,
  ): void {
    this.buffer.push('session.reasoning.started', {
      sessionID: sessionId,
      ...(parentId ? { parentId } : {}),
    });
    this.buffer.push('session.tool.called', {
      sessionID: sessionId,
      tool: toolName,
      ...(parentId ? { parentId } : {}),
    });
  }

  /**
   * Closing markers for a completed turn (live-only, same scope as the start
   * markers above): real tool success + reasoning end, before the terminal
   * session.idle. Never durable, never chat text — the frontend projects them
   * to activeToolName + additive tool/reasoning trace rows.
   */
  private bufferDirectLifecycleEnd(
    sessionId: string,
    toolName: string,
    parentId?: string | null,
  ): void {
    this.buffer.push('session.tool.success', {
      sessionID: sessionId,
      tool: toolName,
      ...(parentId ? { parentId } : {}),
    });
    this.buffer.push('session.reasoning.ended', {
      sessionID: sessionId,
      ...(parentId ? { parentId } : {}),
    });
  }

  /**
   * Terminal frame for a completed turn: the frontend useChat send()
   * finalizes (clears sending) only on session.idle.
   */
  private bufferDirectIdle(sessionId: string): void {
    this.buffer.push('session.idle', { sessionID: sessionId });
  }

  /**
   * Chunk an answer into contract-narrowed token frames (delta slices + the
   * absolute snapshot) for the SSE buffer. The frontend already parses exactly
   * these two variants (useChat frameText) — no client change.
   */
  private bufferDirectFrames(sessionId: string, assistant: SessionMessage): void {
    const text: string = assistant.text ?? '';
    if (!text) return;
    const partID: string = `prt_${assistant.id}`;
    const parentId: string | null | undefined = assistant.parentId ?? undefined;
    for (let index: number = 0; index < text.length; index += SSE_CHUNK) {
      this.buffer.push('message.part.delta', {
        sessionID: sessionId,
        messageID: assistant.id,
        partID,
        field: 'text',
        delta: text.slice(index, index + SSE_CHUNK),
        ...(parentId ? { parentId } : {}),
      });
    }
    this.buffer.push('message.part.updated', {
      sessionID: sessionId,
      ...(parentId ? { parentId } : {}),
      part: { id: partID, type: 'text', text },
    });
  }

  /**
   * Redacted single-line 500-char detail (turns-local copy, no shared util —
   * no new files per CoC). Shell/file output may echo secrets; key=value and
   * token prefixes collapse to `[redacted]`.
   */
  private toSafeDetail(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    const text: string =
      typeof raw === 'string' ? raw : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (text.length === 0) return null;
    const single: string = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (single.length === 0) return null;
    return single
      .replace(
        /(api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer|cookie|session[_-]?id)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
        '$1=[redacted]',
      )
      .replace(/\bsk-[A-Za-z0-9-_]{10,}\b/g, '[redacted]')
      .replace(/\bghp_[A-Za-z0-9]{10,}\b/g, '[redacted]');
  }
}
