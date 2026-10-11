import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * Organizations DTO — zod@4 source of truth, swagger DTOs for parity
 * with contracts/openapi.yaml. Runtime validation via ZodValidationPipe.
 * All contracts here are NEW (additive): no existing schema is modified.
 */

export const orgRoleSchema = z.enum(['maintainer', 'user'], {
  error: 'role must be maintainer or user',
});

export type OrgRole = z.infer<typeof orgRoleSchema>;

export const createOrganizationSchema = z.object({
  name: z.string({ error: 'Field "name" is required' }).min(1).max(200),
  description: z.string().max(2000).optional(),
  isPrivate: z.boolean().optional().default(true),
});

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  isPrivate: z.boolean().optional(),
});

export const addMemberSchema = z.object({
  userId: z.string({ error: 'Field "userId" is required' }).uuid({ error: 'userId must be a uuid' }),
  role: orgRoleSchema.optional().default('user'),
});

export const updateMemberRoleSchema = z.object({
  role: orgRoleSchema,
});

export const createInviteSchema = z.object({
  role: orgRoleSchema.optional().default('user'),
});

export const acceptInviteSchema = z.object({
  token: z.string({ error: 'Field "token" is required' }).min(1).max(500),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export class CreateOrganizationDto {
  @ApiProperty({ example: 'acme' })
  name!: string;

  @ApiProperty({ required: false, example: 'Acme team org' })
  description?: string;

  @ApiProperty({ required: false, default: true })
  isPrivate?: boolean;
}

export class UpdateOrganizationDto {
  @ApiProperty({ required: false })
  name?: string;

  @ApiProperty({ required: false, nullable: true })
  description?: string | null;

  @ApiProperty({ required: false })
  isPrivate?: boolean;
}

export class OrganizationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ required: false, nullable: true })
  description!: string | null;

  @ApiProperty({ required: false, nullable: true })
  ownerId!: string | null;

  @ApiProperty({ default: true })
  isPrivate!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class OrganizationMemberDto {
  @ApiProperty({ format: 'uuid' })
  orgId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ enum: ['maintainer', 'user'] })
  role!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AddMemberDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ required: false, enum: ['maintainer', 'user'], default: 'user' })
  role?: string;
}

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: ['maintainer', 'user'] })
  role!: string;
}

export class OrganizationInviteDto {
  @ApiProperty({ description: 'Single-use bearer token (never logged)' })
  token!: string;

  @ApiProperty({ format: 'uuid' })
  orgId!: string;

  @ApiProperty({ enum: ['maintainer', 'user'] })
  role!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}

export class CreateInviteDto {
  @ApiProperty({ required: false, enum: ['maintainer', 'user'], default: 'user' })
  role?: string;
}

export class AcceptInviteDto {
  @ApiProperty()
  token!: string;
}
