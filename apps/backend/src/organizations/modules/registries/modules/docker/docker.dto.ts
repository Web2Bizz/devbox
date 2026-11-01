import { ApiProperty } from '@nestjs/swagger';

/** GET /api/v1/registry/catalog — live Docker Registry /v2/_catalog. */
export class RegistryCatalogDto {
  @ApiProperty({ example: ['library/nginx', 'team/app'], type: [String] })
  repositories!: string[];
}

/** Registry reachability flag for GET /health. */
export class RegistryHealthDto {
  @ApiProperty({ enum: ['up', 'down', 'skipped'], example: 'up' })
  status!: string;
}
