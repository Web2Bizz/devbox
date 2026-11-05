import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  Version,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { JwtAuthGuard } from '../../../auth/jwt-auth.guard';
import type { RequestIdentity } from '../../../auth/identity.service';
import { ReqUser } from '../../../auth/req-user.decorator';
import { ApiErrorDto } from '../../../common/http/api/api.dto';
import { ZodValidationPipe } from '../../../common/validation';
import { createRunRequestSchema, type CreateRunInput, type RunInfo, type RunInfoList } from './runs.dto';
import { RunsService } from './runs.service';

/**
 * Domain run routes — /api/runs* (VERSION_NEUTRAL under the global 'api'
 * prefix). Prototype API minimum: create, read one, stream its journal, list
 * a project's runs. Interrupt/upgrade-definition are deliberately absent.
 *
 * Auth: every route is JwtAuthGuard + the C4 project gate (strangers → 404
 * with no existence leak; blank projectId → 400 PROJECT_REQUIRED). Guests →
 * 401 before any gate/DB work. Errors follow the shared mapping: honest 4xx
 * for caller mistakes, 503 EXTERNAL_UNAVAILABLE + Retry-After only for real
 * Postgres outages (ApiErrorFilter adds `x-correlation-id`).
 */
@ApiTags('runs')
@ApiBearerAuth()
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  @Version(VERSION_NEUTRAL)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a project run (open status, pinned to the repo HEAD as Forward-Only base)' })
  @ApiResponse({ status: 201, description: 'created domain run (RunInfo)' })
  @ApiResponse({ status: 400, description: 'invalid body (bad_request — our zod), missing projectId (PROJECT_REQUIRED, the C4 gate) or the repo has no commits yet (RUN_REPO_NOT_READY) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 401, description: 'missing/invalid credentials — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'Postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async create(
    @ReqUser() identity: RequestIdentity,
    @Body(new ZodValidationPipe(createRunRequestSchema)) body: CreateRunInput,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<RunInfo> {
    const cid = correlationId ?? '';
    return this.runs.create(identity.id, body, cid);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/events')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Live run journal (SSE; prototype frames {id, type, data, run?}, catch-up from ?cursor=)' })
  @ApiResponse({ status: 200, description: 'text/event-stream of domain RunStreamFrame rows (replayed seq > cursor, then live)' })
  @ApiResponse({ status: 400, description: 'run id is not a uuid or cursor is not a non-negative integer (bad_request) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 401, description: 'missing/invalid credentials — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown run (not_found) or unknown project for this caller (C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'Postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async events(
    @ReqUser() identity: RequestIdentity,
    @Req() req: ExpressRequest,
    @Res({ passthrough: false }) res: ExpressResponse,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<void> {
    const cid = correlationId ?? '';
    await this.runs.streamEvents(identity.id, id, cursor, cid, req, res);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'List project runs (domain rows, newest first)' })
  @ApiResponse({ status: 200, description: 'run rows for this project (always an array; empty when none)' })
  @ApiResponse({ status: 400, description: 'missing projectId (PROJECT_REQUIRED, the C4 gate)', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown project for this caller (not_found, no existence leak — the C4 gate)', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'database unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async list(
    @ReqUser() identity: RequestIdentity,
    @Query('projectId') projectId?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<RunInfoList> {
    return this.runs.list(identity.id, projectId, correlationId ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ summary: 'Read one run by id (C4-gated by its project)' })
  @ApiResponse({ status: 200, description: 'domain run (RunInfo)' })
  @ApiResponse({ status: 400, description: 'run id is not a uuid (bad_request) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 401, description: 'missing/invalid credentials — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 404, description: 'unknown run (not_found) or unknown project for this caller (C4 gate) — no Retry-After', type: ApiErrorDto })
  @ApiResponse({ status: 503, description: 'Postgres unreachable (EXTERNAL_UNAVAILABLE, Retry-After)', type: ApiErrorDto })
  async getOne(
    @ReqUser() identity: RequestIdentity,
    @Param('id') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<RunInfo> {
    const cid = correlationId ?? '';
    return this.runs.getOne(identity.id, id, cid);
  }
}
