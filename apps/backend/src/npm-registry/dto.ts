import { ApiProperty } from '@nestjs/swagger';

/** GET /api/v1/registry/npm/status — live Verdaccio /-/ping reachability. */
export class NpmRegistryStatusDto {
  @ApiProperty({ enum: ['up'], example: 'up' })
  status!: string;

  @ApiProperty({ example: 'https://npm.registry.web2bizz.team' })
  url!: string;

  @ApiProperty({ example: '@web2bizz' })
  scope!: string;
}

/** npm registry reachability flag for GET /health. */
export class NpmRegistryHealthDto {
  @ApiProperty({ enum: ['up', 'down', 'skipped'], example: 'up' })
  status!: string;
}
