import { ApiProperty } from '@nestjs/swagger';

/**
 * Projects DTO — single source of truth is @rush-code/contracts (verbatim
 * regexes, min/max + error strings, partial-update derivation, link
 * default). Swagger DTO classes below stay as thin @nestjs/swagger
 * wrappers for contracts/openapi.yaml parity.
 * Runtime validation via ZodValidationPipe.
 */
export {
  createProjectSchema,
  githubLinkSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type GithubLinkInput,
  type UpdateProjectInput,
} from '@devbox/contracts';

export class CreateProjectDto {
  @ApiProperty({ example: 'my-app' })
  name!: string;

  @ApiProperty({ required: false, example: 'Devbox backend service' })
  description?: string;

  @ApiProperty({ required: false, example: 'acme' })
  githubOwner?: string;

  @ApiProperty({ required: false, example: 'my-app' })
  githubRepo?: string;

  @ApiProperty({ required: false, example: 'main' })
  githubBranch?: string;

  @ApiProperty({ required: false, example: 'https://github.com/acme/my-app' })
  githubUrl?: string;

  @ApiProperty({ required: false, example: 'user-1' })
  ownerId?: string;
}

export class UpdateProjectDto {
  @ApiProperty({ required: false })
  name?: string;

  @ApiProperty({ required: false })
  description?: string;

  @ApiProperty({ required: false })
  githubOwner?: string;

  @ApiProperty({ required: false })
  githubRepo?: string;

  @ApiProperty({ required: false })
  githubBranch?: string;

  @ApiProperty({ required: false })
  githubUrl?: string;

  @ApiProperty({ required: false })
  ownerId?: string;
}

export class ProjectDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ required: false, nullable: true })
  description!: string | null;

  @ApiProperty({ required: false, nullable: true })
  githubOwner!: string | null;

  @ApiProperty({ required: false, nullable: true })
  githubRepo!: string | null;

  @ApiProperty({ required: false, nullable: true })
  githubBranch!: string | null;

  @ApiProperty({ required: false, nullable: true })
  githubUrl!: string | null;

  @ApiProperty({ required: false, nullable: true })
  ownerId!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({
    description:
      'Computed flag (no DB column): true when the project row exists but the on-disk git repo is missing or invalid',
    example: false,
  })
  corrupted!: boolean;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Machine reason when corrupted (missing-dir, no-git, rev-parse-failed, fsck-failed, timeout, storage-unconfigured, …). storage-unconfigured = REPOS_ROOT empty (required for project writes)',
  })
  corruptedReason?: string | null;
}

export class GithubLinkDto {
  @ApiProperty({ example: 'acme' })
  owner!: string;

  @ApiProperty({ example: 'my-app' })
  repo!: string;

  @ApiProperty({ required: false, example: 'main' })
  branch?: string;
}

export class GithubLinkStatusDto {
  @ApiProperty()
  linked!: boolean;

  @ApiProperty({ required: false, nullable: true })
  owner!: string | null;

  @ApiProperty({ required: false, nullable: true })
  repo!: string | null;

  @ApiProperty({ required: false, nullable: true })
  branch!: string | null;

  @ApiProperty({ required: false, nullable: true })
  url!: string | null;
}
