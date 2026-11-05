import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import path from 'node:path';
import { DbService } from '../../../common/db/db.service';
import type { RunEventRow, RunRow } from '../../../common/db/schema';
import { ExternalServiceError } from '../../../common/external/external-error';
import { AppLogger } from '../../../common/logger';
import { relaySse } from '../../../common/sse/sse-relay';
import { WorkspacePathService } from '../../../common/storage/workspace-path.service';
import { ProjectAccessService } from '../../../organizations/modules/projects/modules/project-access/project-access.service';
import { resolveHeadOrNull } from '../../../organizations/modules/projects/modules/repository/utils/repos-git';
import type { CreateRunInput, RunInfo, RunInfoList, RunStreamFrame } from './runs.dto';
import { RunEventSource } from './run-event-source';
import { RunsRepository } from './runs.repository';

/** uuid shape check (same rule as ProjectAccessService/WorkspacePathService). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RunsService — domain facade of /api/v1/runs* (agent-harness prototype).
 *
 * Every entry point is C4-gated: POST resolves the project directory through
 * ProjectAccessService (stranger → 404, blank projectId → 400, no leak of
 * existence), GET/SSE load the run row first and gate its projectId.
 *
 * A run is created honest about its Forward-Only base: `baseCommit` is the
 * repo's real HEAD (`resolveHeadOrNull`). A repo without commits answers an
 * honest 400 RUN_REPO_NOT_READY — a sha is never invented, because the whole
 * Forward-Only rule hangs off it. The agent branch/worktree names derive from
 * the server-minted run id, and the worktree is re-asserted inside the
 * REPOS_ROOT jail before it is persisted.
 *
 * Logs are one-liners without URL/body/secret; Postgres failures arrive
 * already normalized by RunsRepository/dbUnavailable.
 */
@Injectable()
export class RunsService {
  constructor(
    private readonly repo: RunsRepository,
    private readonly access: ProjectAccessService,
    private readonly paths: WorkspacePathService,
    private readonly events: RunEventSource,
    private readonly db: DbService,
    private readonly logger: AppLogger = new AppLogger(RunsService.name),
  ) {}

  /** POST /api/v1/runs — create an open run pinned to the project's HEAD. */
  async create(userId: string, body: CreateRunInput, cid: string): Promise<RunInfo> {
    const project = await this.access.resolveProjectDirectory(body.projectId, userId, cid);
    const baseCommit = await resolveHeadOrNull(project.directory);
    if (!baseCommit) {
      throw new BadRequestException({
        code: 'RUN_REPO_NOT_READY',
        message: 'project repository has no commits — create an initial commit first',
      });
    }
    const runId = Bun.randomUUIDv7();
    const branch = `agent/${runId}`;
    const worktree = path.join(project.directory, 'wt', runId);
    await this.paths.assertInsideJail(worktree, await this.paths.realStrictRoot());
    // prototype: active definition set is pinned to the base commit (skills
    // are git artifacts); E5 replaces with the real set hash.
    const definitionSetHash = body.definitionSetHash ?? `sha256:${baseCommit}`;
    const row = await this.repo.createRun({
      runId,
      projectId: body.projectId,
      title: body.title ?? null,
      definitionSetHash,
      baseCommit,
      branch,
      worktree,
      agentId: body.agentId ?? null,
      model: body.model ?? null,
      correlationId: cid,
    });
    this.logger.info('[runs] created status=open', cid);
    return toRunInfo(row);
  }

  /** GET /api/v1/runs/:id — one run, gated by its project (stranger → 404). */
  async getOne(userId: string, id: string, cid: string): Promise<RunInfo> {
    const runId = parseRunId(id);
    const row = await this.repo.findRun(runId, cid);
    if (!row) throw notFound(runId);
    await this.access.assertProjectAccessById(row.projectId, userId, cid);
    return toRunInfo(row);
  }

  /** GET /api/v1/runs?projectId= — C4-scoped live runs, newest first. */
  async list(userId: string, projectId: string | undefined, cid: string): Promise<RunInfoList> {
    if (!projectId || projectId.trim() === '') {
      throw new BadRequestException({
        code: 'PROJECT_REQUIRED',
        message: 'projectId is required — run routes are project-scoped',
      });
    }
    await this.access.assertProjectAccessById(projectId, userId, cid);
    const rows = await this.repo.listRuns(projectId, cid);
    return rows.map(toRunInfo);
  }

  /**
   * GET /api/v1/runs/:id/events?cursor= — SSE over the run journal.
   *
   * The run is loaded (and gate-checked) BEFORE the stream opens so an
   * unknown/foreign run answers an honest 404 JSON instead of a 200 stream
   * that never frames. `cursor` is the last delivered seq; catch-up replays
   * `seq > cursor`, then RunEventSource tails LISTEN/NOTIFY.
   */
  async streamEvents(
    userId: string,
    id: string,
    cursorRaw: string | undefined,
    cid: string,
    req: ExpressRequest,
    res: ExpressResponse,
  ): Promise<void> {
    const runId = parseRunId(id);
    const cursor = parseCursor(cursorRaw);
    const row = await this.repo.findRun(runId, cid);
    if (!row) throw notFound(runId);
    await this.access.assertProjectAccessById(row.projectId, userId, cid);
    await relaySse({
      operation: 'GET /api/v1/runs/:id/events',
      cid,
      req,
      res,
      logger: this.logger,
      prefix: '[runs]',
      probe: () => this.db.checkDb(),
      unreachableError: () => this.unavailableError(),
      subscribeFailedError: (err) =>
        err instanceof ExternalServiceError ? err : this.unavailableError(),
      subscribe: (signal) => this.events.subscribe(runId, cursor, cid, signal),
      mapFrame: (value) => {
        const event = value as RunEventRow;
        const frame: RunStreamFrame = {
          id: String(event.seq),
          // The column is text (the frozen contract owns the union); journal
          // writers only emit the 4 prototype frame types.
          type: event.type as RunStreamFrame['type'],
          data: event.data,
          run: runId,
        };
        return frame;
      },
      filterFrame: (frame) => typeof (frame as RunStreamFrame).run === 'string',
    });
  }

  /** 503 shape for the journal source (fixed message, retryable → Retry-After). */
  private unavailableError(): ExternalServiceError {
    return new ExternalServiceError({
      code: 'EXTERNAL_UNAVAILABLE',
      service: 'db',
      operation: 'runEvents',
      message: 'сервис временно недоступен, повторите позже',
      isRetryable: true,
    });
  }
}

/** Run ids are uuids; anything else is a caller mistake (400, no DB hit). */
function parseRunId(id: string): string {
  if (!UUID_RE.test(id)) {
    throw new BadRequestException({ code: 'bad_request', message: 'run id must be a uuid' });
  }
  return id;
}

/** SSE cursor = last delivered seq; absent/empty starts from the beginning. */
function parseCursor(raw?: string): number {
  if (raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException({
      code: 'bad_request',
      message: 'cursor must be a non-negative integer',
    });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new BadRequestException({
      code: 'bad_request',
      message: 'cursor must be a non-negative integer',
    });
  }
  return value;
}

function notFound(runId: string): NotFoundException {
  return new NotFoundException({ code: 'not_found', message: `Run ${runId} not found` });
}

/** run_runs row → wire shape (nullable keys are explicit, never optional). */
function toRunInfo(row: RunRow): RunInfo {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title ?? null,
    // Column is text; the frozen RunStatus union in @rush-code/contracts owns
    // the enum (same doctrine as the schema comment).
    status: row.status as RunInfo['status'],
    definitionSetHash: row.definitionSetHash,
    baseCommit: row.baseCommit,
    branch: row.branch,
    worktree: row.worktree,
    sandboxId: row.sandboxId ?? null,
    agentId: row.agentId ?? null,
    model: (row.model as RunInfo['model']) ?? null,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : new Date(row.updatedAt).toISOString(),
  };
}
