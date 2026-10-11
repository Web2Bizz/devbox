import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * Github (installation repos) DTO — zod@4 source of truth, swagger DTOs for
 * parity with contracts/openapi.yaml. Runtime validation via ZodValidationPipe.
 *
 * Flow: GitHub App JWT (app) → POST /app/installations/{id}/access_tokens
 * (installation token, in-memory only) → GET /installation/repositories.
 * Required App scopes: metadata:read + contents:read.
 */

export const listReposQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(30),
  /**
   * MVP mock user key (fallback when the x-user-id header is absent).
   * Header wins over query; both fall back to the 'default' dev user.
   */
  userId: z.string().trim().min(1).max(100).optional(),
});

export type ListReposQueryInput = z.infer<typeof listReposQuerySchema>;

export class ListReposQueryDto {
  @ApiProperty({ required: false, minimum: 1, default: 1, example: 1 })
  page?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 30, example: 30 })
  per_page?: number;

  @ApiProperty({
    required: false,
    description: 'MVP mock user key (x-user-id header wins over this query param)',
    example: 'dev-1',
  })
  userId?: string;
}

export class GithubRepoDto {
  @ApiProperty({ example: 1296269 })
  id!: number;

  @ApiProperty({ example: 'acme' })
  owner!: string;

  @ApiProperty({ example: 'my-app' })
  name!: string;

  @ApiProperty({ example: 'acme/my-app' })
  fullName!: string;

  @ApiProperty({ example: false })
  private!: boolean;

  @ApiProperty({ example: 'main' })
  defaultBranch!: string;

  @ApiProperty({ example: 'https://github.com/acme/my-app' })
  url!: string;
}

/** GET /projects/github/install-url → where the user installs the App. */
export class GithubInstallUrlDto {
  @ApiProperty({ example: 'https://github.com/apps/devbox/installations/new' })
  url!: string;
}

/** GET /projects/github/callback?installation_id=&setup_action=[&userId=] */
export const installCallbackQuerySchema = z.object({
  installation_id: z.coerce.number().int().positive(),
  setup_action: z.string().trim().min(1).max(50).default('install'),
  userId: z.string().trim().min(1).max(100).optional(),
});

export type InstallCallbackQueryInput = z.infer<typeof installCallbackQuerySchema>;

export class InstallCallbackQueryDto {
  @ApiProperty({ description: 'GitHub installation id from the App setup flow', example: 789012 })
  installation_id!: number;

  @ApiProperty({ required: false, default: 'install', example: 'install' })
  setup_action?: string;

  @ApiProperty({
    required: false,
    description: 'MVP mock user key (x-user-id header wins over this query param)',
    example: 'dev-1',
  })
  userId?: string;
}

export class GithubCallbackResultDto {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty({ example: 789012 })
  installationId!: number;
}

export class GithubWebhookAckDto {
  @ApiProperty({ example: true })
  ok!: boolean;
}
