import { Module } from '@nestjs/common';
import { ApiController } from './api.controller.js';
import { ProxyService } from './proxy.service.js';
import { OpencodeModule } from '../opencode/opencode.module.js';

@Module({
  imports: [OpencodeModule],
  controllers: [ApiController],
  providers: [ProxyService],
})
export class ApiModule {}
