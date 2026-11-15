import { Injectable, NotFoundException } from '@nestjs/common';
import { AppLogger } from '@common/logger';
import { OpencodeHostService, type HostPromptReceipt } from '../../../opencode/opencode-host.service';
import { SessionHistoryRepository } from '../../session-history.repository';
import type { SessionMessage } from '../../sessions.dto';
import type { SessionTurnInput } from '../../sessions.types';
import { AssistantRecorderService } from '../recorder/assistant-recorder.service';
import { SessionRuntimeStateService } from '../state/session-runtime-state.service';
import { TurnWorkspaceService } from '../workspace/turn-workspace.service';

/**
 * HostTurnService — one turn through the bound embedded host session.
 *
 * Resolves the host session id from `metadata.opencodeSessionId`, prompts it,
 * and persists the returned user receipt in the durable thread (so a reload
 * keeps the question even though the answer streams over events). The
 * assistant recorder is subscribed BEFORE the prompt so no early delta is
 * lost; the pre-turn tree is keyed to the host-owned receipt id.
 */
@Injectable()
export class HostTurnService {
  constructor(
    private readonly host: OpencodeHostService,
    private readonly history: SessionHistoryRepository,
    private readonly workspace: TurnWorkspaceService,
    private readonly state: SessionRuntimeStateService,
    private readonly recorder: AssistantRecorderService,
    private readonly logger: AppLogger = new AppLogger(HostTurnService.name),
  ) {}

  /** Prompt the bound host session and answer the mapped user receipt. */
  async send(input: SessionTurnInput): Promise<SessionMessage> {
    const { userId, sessionId, body, directory, agentId, correlationId } = input;
    if (body.agentId !== undefined) {
      await this.history.setAgent(sessionId, body.projectId, agentId);
    }
    const hostSessionId: string | undefined = await this.history.getHostSessionId(
      sessionId,
      body.projectId,
    );
    if (!hostSessionId) {
      throw new NotFoundException({
        code: 'opencode_session_unbound',
        message: 'Session is not bound to the embedded OpenCode host',
      });
    }
    // The assistant recorder must be subscribed BEFORE the prompt so no early
    // delta is lost; a failure there is logged but never blocks the prompt.
    this.state.bindHostSession(hostSessionId, {
      projectId: body.projectId,
      localSessionId: sessionId,
      userId,
    });
    // Busy covers the whole streamed answer (the POST returns the receipt
    // immediately): the recorder clears it on the terminal execution frame,
    // statusMap/stream stay honest while the host bus streams.
    this.state.markBusy(sessionId);
    this.state.setTurnMeta(sessionId, {
      userId,
      projectId: body.projectId,
      agentId,
      // Omitted mode stays undefined (auto): the transport behavior is
      // unchanged, the turn meta only records what the caller asked for.
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
    });
    await this.recorder.ensureStarted();
    void body.model; // model is pinned at create; prompt has no model field
    // Capture BEFORE the prompt: the host owns the user receipt id, so the
    // pre-turn tree is keyed to it once the prompt answers.
    const preTurn: string | undefined = await this.workspace.capture(directory, correlationId);
    let receipt: HostPromptReceipt;
    try {
      receipt = await this.host.sessionPrompt(hostSessionId, body.text);
    } catch (error) {
      // Prompt never started — drop the busy marker so status/stream do not
      // hang; the POST error itself clears the frontend `sending` gate.
      this.state.clearBusy(sessionId);
      throw error;
    }
    if (preTurn) this.workspace.recordTurnStart(sessionId, receipt.id, preTurn);
    this.state.setTurnMeta(sessionId, {
      userId,
      projectId: body.projectId,
      agentId,
      // Host-owned user receipt: the recorder parents the assistant answer
      // to THIS id (current turn), never to findTailId at flush time (which
      // could already be the next turn's user row).
      receiptId: receipt.id,
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
    });
    const userParent: string | null = await this.history.resolveAppendParent(sessionId, body.parentId);
    const mapped: SessionMessage = {
      id: receipt.id,
      type: receipt.type,
      createdAt: new Date(receipt.time.created).toISOString(),
      text:
        typeof receipt.payload.text === 'string' && receipt.payload.text.length > 0
          ? receipt.payload.text
          : null,
      parentId: userParent,
    };
    await this.history.appendMessage({
      id: mapped.id,
      sessionId,
      userId,
      role: 'user',
      agentId,
      text: body.text,
      createdAt: mapped.createdAt,
      parentId: userParent,
    });
    this.logger.info('[sessions] prompt accepted', correlationId);
    return mapped;
  }
}
