import { ApiProperty } from "@nestjs/swagger";

/** PUT /api/v1/opencode/key request body (the raw key — never echoed back). */
export class OpencodeKeyBodyDto {
  @ApiProperty({ example: "opencode_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", minLength: 20 })
  apiKey!: string;
}

/** PUT / DELETE /api/v1/opencode/key result (carries no secret). */
export class OpencodeKeyResultDto {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty({ example: "2026-10-13T00:00:00.000Z" })
  updatedAt!: string;
}

/** GET /api/v1/opencode/key — whether the caller has a key stored. */
export class OpencodeKeyStatusDto {
  @ApiProperty({ example: true })
  configured!: boolean;

  @ApiProperty({ required: false, example: "2026-10-13T00:00:00.000Z" })
  updatedAt?: string;
}

/** GET /api/v1/opencode/usage — live upstream balance+usage. */
export class OpencodeUsageDto {
  @ApiProperty({ example: 42.5 })
  balance!: number;

  @ApiProperty({ example: 7.25 })
  usage!: number;

  /** ISO-8601 time of the upstream response (no cache/TTL in this iteration). */
  @ApiProperty({ example: "2026-10-13T00:00:00.000Z" })
  updatedAt!: string;
}
