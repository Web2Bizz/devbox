import { ApiProperty } from '@nestjs/swagger';

/**
 * Organizations DTO — single source of truth is @devbox/contracts
 * (verbatim min/max, uuid shapes, defaults + error strings). Swagger DTO
 * classes below stay as thin @nestjs/swagger wrappers for
 * contracts/openapi.yaml parity. Runtime validation via ZodValidationPipe.
 * All contracts here are NEW (additive): no existing schema is modified.
 */
export {
  acceptInviteSchema,
  addMemberSchema,
  createInviteSchema,
  createOrganizationSchema,
  orgRoleSchema,
  updateMemberRoleSchema,
  updateOrganizationSchema,
  type AcceptInviteInput,
  type AddMemberInput,
  type CreateInviteInput,
  type CreateOrganizationInput,
  type OrgRole,
  type UpdateMemberRoleInput,
  type UpdateOrganizationInput,
} from '@devbox/contracts';

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
