import { ApiProperty } from "@nestjs/swagger";

/**
 * Users DTO — runtime schemas are re-exported from @rush-code/contracts
 * (single source, CoC §4.1); the swagger class below is docs only and is never
 * used for validation (§4.2/§4.3).
 */
export {
  registerSchema,
  updateMeSchema,
  type RegisterInput,
  type UpdateMeInput,
} from "@rush-code/contracts";

/** Public user DTO — mirrors contracts `AuthUser`; never carries passwordHash. */
export class UserDto {
  @ApiProperty({ example: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })
  id!: string;

  @ApiProperty({ example: "Ada" })
  firstName!: string;

  @ApiProperty({ example: "Lovelace" })
  lastName!: string;

  @ApiProperty({ example: "ada@rush-code.local" })
  email!: string;

  @ApiProperty({ example: "local", enum: ["local", "sso-oauth", "github-app"] })
  provider!: string;

  @ApiProperty({ example: "2026-10-01T00:00:00.000Z", format: "date-time" })
  createdAt!: string;
}
