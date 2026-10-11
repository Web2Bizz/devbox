import { Controller, Get, Headers, Param, Query, UseGuards, UseInterceptors, Version } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { ReqUser } from '../../auth/req-user.decorator.js';
import type { RequestIdentity } from '../../auth/identity.service.js';
import { NoIndexInterceptor } from '../../common/noindex.interceptor.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { V1Endpoint } from '../../api/version.js';
import { FileNodeDto, filesQuerySchema, type FilesQuery } from './dto.js';
import { ProjectFilesService, type FileNode } from './project-files.service.js';

/**
 * Readonly project file listing — Bearer-guarded (JwtAuthGuard, legacy
 * mock fallback in dev). Scopes through
 * OrganizationsService.assertProjectAccess (Card 5): org-linked projects
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
  @Version('1')
  @V1Endpoint('Readonly project file listing (path + depth, jailed, depth 0-5)')
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
