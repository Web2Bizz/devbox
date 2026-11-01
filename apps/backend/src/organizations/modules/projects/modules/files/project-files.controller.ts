import { Controller, Get, Headers, Param, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../../auth/jwt-auth.guard';
import { ReqUser } from '../../../../../auth/req-user.decorator';
import type { RequestIdentity } from '../../../../../auth/identity.service';
import { NoIndexInterceptor } from '../../../../../common/http/noindex.interceptor';
import { ZodValidationPipe } from '../../../../../common/validation';
import { FileNodeDto, filesQuerySchema, type FilesQuery } from './dto';
import { ProjectFilesService, type FileNode } from './project-files.service';

/**
 * Readonly project file listing — Bearer-guarded (JwtAuthGuard, legacy
 * mock fallback in dev). Scopes through
 * ProjectAccessService.assertProjectAccess (Card 5): org-linked projects
 * admit any member of a linked org, user-space projects admit only the
 * owner; strangers get 404 (existence is not leaked). Jail/traversal and
 * 503 storage semantics are unchanged.
 */
@ApiTags('project-files')
@Controller('projects/:projectId/files')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(NoIndexInterceptor)
export class ProjectFilesController {
  constructor(private readonly files: ProjectFilesService) {}

  @Get()
  @ApiOperation({ summary: 'Readonly project file listing (path + depth, jailed, depth 0-5)' })
  @ApiQuery({ name: 'path', required: false, example: '.' })
  @ApiQuery({ name: 'depth', required: false, example: 1 })
  @ApiResponse({ status: 200, type: FileNodeDto })
  @ApiResponse({ status: 404, description: 'not found (or no access)' })
  @ApiResponse({ status: 503, description: 'storage unconfigured (EXTERNAL_UNAVAILABLE, Retry-After)' })
  async tree(
    @Param('projectId') projectId: string,
    @Query(new ZodValidationPipe(filesQuerySchema)) query: FilesQuery,
    @ReqUser() identity: RequestIdentity,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<FileNode> {
    return this.files.tree(projectId, query.path ?? '.', Number(query.depth ?? 1), correlationId, identity.id);
  }
}
