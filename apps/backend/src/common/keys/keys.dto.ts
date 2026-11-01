import { ApiProperty } from "@nestjs/swagger";

/** PUT /api/v1/key request body (the raw key — never echoed back). */
export class OpencodeKeyBodyDto {
  @ApiProperty({ example: "opencode_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", minLength: 20 })
  apiKey!: string;
}

/** PUT /api/v1/key result (carries no secret). */
export class OpencodeKeyResultDto {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty({ example: "2026-10-13T00:00:00.000Z" })
  updatedAt!: string;
}

/** DELETE /api/v1/key result (idempotent, no timestamp). */
export class OpencodeKeyDeleteResultDto {
  @ApiProperty({ example: true })
  ok!: boolean;
}

/** GET /api/v1/key — whether the caller has a key stored. */
export class OpencodeKeyStatusDto {
  @ApiProperty({ example: true })
  configured!: boolean;

  @ApiProperty({ required: false, example: "2026-10-13T00:00:00.000Z" })
  updatedAt?: string;
}

/** Single usage bucket — real `used/limit` pair from upstream (no derivation). */
export class OpencodeLimitBucketDto {
  @ApiProperty({ example: 12.5 })
  used!: number;

  @ApiProperty({ example: 100 })
  limit!: number;
}

/** GET /api/v1/usage — live Zen Go usage (percent windows mapped to used/limit 100). */
export class OpencodeUsageDto {
  @ApiProperty({ required: false, example: 42.5 })
  balance?: number;

  @ApiProperty({ required: false, example: 7.25 })
  usage?: number;

  /** ISO-8601 time of the upstream response (no cache/TTL in this iteration). */
  @ApiProperty({ example: "2026-10-13T00:00:00.000Z" })
  updatedAt!: string;

  /**
   * Zen Go windows mapped to used/limit (percent → { used: percent, limit: 100 }).
   * `rolling` is the Zen 5-hour window; legacy `daily` is kept for old payloads.
   * Present only when upstream carries finite numbers — never derived.
   */
  @ApiProperty({ required: false, type: OpencodeLimitBucketDto })
  rolling?: OpencodeLimitBucketDto;

  @ApiProperty({ required: false, type: OpencodeLimitBucketDto })
  daily?: OpencodeLimitBucketDto;

  @ApiProperty({ required: false, type: OpencodeLimitBucketDto })
  weekly?: OpencodeLimitBucketDto;

  @ApiProperty({ required: false, type: OpencodeLimitBucketDto })
  monthly?: OpencodeLimitBucketDto;
}
