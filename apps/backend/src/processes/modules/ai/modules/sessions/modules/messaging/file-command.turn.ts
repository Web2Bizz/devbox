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
    };
    await this.history.appendMessage({
      id: receipt.id,
      sessionId,
      projectId: body.projectId,
      userId,
      role: 'user',
      agentId,
      text: body.text,
      createdAt: receipt.createdAt,
    });
    await this.workspace.captureBeforeTurn(directory, sessionId, receipt.id, correlationId);
    this.state.markBusy(sessionId);
    this.bufferDirectLifecycleStart(sessionId, agentId);
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
      const assistant: SessionMessage = {
        id: Bun.randomUUIDv7(),
        type: 'assistant',
        createdAt: new Date().toISOString(),
        text: answer,
      };
      await this.history.appendMessage({
        id: assistant.id,
        sessionId,
        projectId: body.projectId,
        userId,
        role: 'assistant',
        agentId,
        text: answer,
        createdAt: assistant.createdAt,
      });
      this.bufferDirectFrames(sessionId, assistant);
      this.bufferDirectLifecycleEnd(sessionId, agentId);
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
   * Live-only lifecycle markers for the deterministic turn: the direct
   * transport has no host tool bus, so without these a turn would stream text
   * with no reasoning/tool steps and the chat would show a mute shimmer.
   * Markers ride the same bounded frame buffer (project-scoped via
   * data.sessionID, filtered by streamEvents like text), never durable.
   */
  private bufferDirectLifecycleStart(sessionId: string, agentId: string): void {
    this.buffer.push('session.reasoning.started', { sessionID: sessionId });
    this.buffer.push('session.tool.called', { sessionID: sessionId, tool: agentId });
  }

  /**
   * Closing markers for a completed turn (live-only, same scope as the start
   * markers above): tool success + reasoning end, before the terminal
   * session.idle. Never durable, never chat text — the frontend projects them
   * to activeToolName + additive tool/reasoning trace rows.
   */
  private bufferDirectLifecycleEnd(sessionId: string, agentId: string): void {
    this.buffer.push('session.tool.success', { sessionID: sessionId, tool: agentId });
    this.buffer.push('session.reasoning.ended', { sessionID: sessionId });
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
    for (let index: number = 0; index < text.length; index += SSE_CHUNK) {
      this.buffer.push('message.part.delta', {
        sessionID: sessionId,
        messageID: assistant.id,
        partID,
        field: 'text',
        delta: text.slice(index, index + SSE_CHUNK),
      });
    }
    this.buffer.push('message.part.updated', {
      sessionID: sessionId,
      part: { id: partID, type: 'text', text },
    });
  }
}
