import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

// SCOPE: Common
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
