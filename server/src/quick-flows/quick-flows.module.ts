import { Module } from '@nestjs/common';
import { QuickFlowsService } from './quick-flows.service';
import { QuickFlowsController } from './quick-flows.controller';

@Module({
  providers: [QuickFlowsService],
  controllers: [QuickFlowsController],
})
export class QuickFlowsModule {}
