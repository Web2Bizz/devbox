import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';
import type { InstallationWebhookPayload } from './utils/webhook';

/**
 * Github (installation repos) DTO — zod@4 source of truth, swagger DTOs for
 * parity with contracts/openapi.yaml. Runtime validation via ZodValidationPipe.
 *
 * Flow: GitHub App JWT (app) → POST /app/installations/{id}/access_tokens
 * (installation token, in-memory only) → GET /installation/repositories.
 * Required App scopes: metadata:read + contents:read.
 */

export type ListReposQueryInput = {
  page: number;
  per_page: number;
};

export const listReposQuerySchema: z.ZodType<ListReposQueryInput> = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(30),
  // NOTE (C2): no userId — the caller is the Bearer identity (@ReqUser());
  // a ?userId query is stripped by validation and never trusted.
});

export class ListReposQueryDto {
  @ApiProperty({ required: false, minimum: 1, default: 1, example: 1 })
  page?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 30, example: 30 })
  per_page?: number;
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
  @ApiProperty({ example: 'https://github.com/apps/rush-code/installations/new' })
  url!: string;
}

/** GET /projects/github/callback?installation_id=&setup_action=&state= */
export type InstallCallbackQueryInput = {
  installation_id: number;
  setup_action: string;
  state: string;
};

export const installCallbackQuerySchema: z.ZodType<InstallCallbackQueryInput> = z.object({
  installation_id: z.coerce.number().int().positive(),
  setup_action: z.string().trim().min(1).max(50).default('install'),
  state: z.string().trim().min(1),
  // NOTE (C2): no userId — the binding target is the Bearer identity
  // (@ReqUser()); a ?userId query is stripped by validation and never trusted.
});

export class InstallCallbackQueryDto {
  @ApiProperty({ description: 'GitHub installation id from the App setup flow', example: 789012 })
  installation_id!: number;

  @ApiProperty({ required: false, default: 'install', example: 'install' })
  setup_action?: string;

  @ApiProperty({
    required: true,
    description: 'Signed install state issued by GET /projects/github/install-url',
    example: 'eyJ1c2VySWQiOiJhbGljZSIsImV4cCI6MTc2MDAwMDAwMDAwMH0.signature',
  })
  state!: string;
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

/**
 * POST /projects/github/webhook body — minimal lenient shape.
 *
 * GitHub sends many event variants (ping, installation_repositories, …) that
 * must still be acked, so every field is optional and unknown keys are kept
 * (`installation.account.login/type` are read by the handler). Runtime
 * validation runs in the controller AFTER signature verification — unverified
 * payloads never reach it.
 */
export const installationWebhookSchema: z.ZodType<InstallationWebhookPayload> = z
  .object({
    action: z.string().optional(),
    installation: z
      .object({
        id: z.number().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
