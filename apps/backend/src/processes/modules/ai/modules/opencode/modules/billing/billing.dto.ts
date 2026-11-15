import { ApiProperty } from "@nestjs/swagger";

/**
 * GET /api/v1/usage Swagger DTOs (billing domain).
 *
 * Entity/wire types live in BillingService (BillingUsage/BillingLimitBucket);
 * these classes only decorate the OpenAPI surface.
 */

/** Single usage bucket — real `used/limit` pair from upstream (no derivation). */
export class BillingLimitBucketDto {
  @ApiProperty({ example: 12.5 })
  used!: number;

  @ApiProperty({ example: 100 })
  limit!: number;
}

/** GET /api/v1/usage — live Zen Go usage (percent windows mapped to used/limit 100). */
export class BillingUsageDto {
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
  @ApiProperty({ required: false, type: BillingLimitBucketDto })
  rolling?: BillingLimitBucketDto;

  @ApiProperty({ required: false, type: BillingLimitBucketDto })
  daily?: BillingLimitBucketDto;

  @ApiProperty({ required: false, type: BillingLimitBucketDto })
  weekly?: BillingLimitBucketDto;

  @ApiProperty({ required: false, type: BillingLimitBucketDto })
  monthly?: BillingLimitBucketDto;
}
