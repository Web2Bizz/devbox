import { Module } from '@nestjs/common';
import { ApiController } from './api.controller';
import { ProxyService } from './proxy.service';
import { OpencodeModule } from '../opencode/opencode.module';

@Module({
  imports: [OpencodeModule],
  controllers: [ApiController],
  providers: [ProxyService],
})
export class ApiModule {}
