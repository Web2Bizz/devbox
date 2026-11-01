import { ApiProperty } from '@nestjs/swagger';

/** Public user DTO — never carries passwordHash (never logged, never serialized). */
export class AuthUserDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: 'Ada' })
  firstName!: string;

  @ApiProperty({ example: 'Lovelace' })
  lastName!: string;

  @ApiProperty({ example: 'ada@rush-code.local' })
  email!: string;

  @ApiProperty({ example: 'local', enum: ['local', 'sso-oauth', 'github-app'] })
  provider!: string;

  @ApiProperty({ example: '2026-10-01T00:00:00.000Z' })
  createdAt!: string;
}

/** Token pair DTO (access + rotating refresh). */
export class AuthTokensDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…' })
  accessToken!: string;

  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…' })
  refreshToken!: string;

  @ApiProperty({ example: 'bearer' })
  tokenType!: string;

  /** Access lifetime in seconds. */
  @ApiProperty({ example: 900 })
  expiresIn!: number;
}

export class AuthSessionDto extends AuthTokensDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}

export class RegisterBodyDto {
  @ApiProperty({ example: 'Ada' })
  firstName!: string;

  @ApiProperty({ example: 'Lovelace' })
  lastName!: string;

  @ApiProperty({ example: 'ada@rush-code.local' })
  email!: string;

  @ApiProperty({ example: 's3cret-p4ss', minLength: 8 })
  password!: string;
}

export class LoginBodyDto {
  @ApiProperty({ example: 'ada@rush-code.local' })
  email!: string;

  @ApiProperty({ example: 's3cret-p4ss', minLength: 8 })
  password!: string;
}

export class RefreshBodyDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…' })
  refreshToken!: string;
}

export class UpdateMeBodyDto {
  @ApiProperty({ required: false, example: 'Ada' })
  firstName?: string;

  @ApiProperty({ required: false, example: 'Lovelace' })
  lastName?: string;
}
