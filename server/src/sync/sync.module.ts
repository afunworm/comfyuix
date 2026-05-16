import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { AssetsService } from '../assets/assets.service';

@Module({
	providers: [SyncService, AssetsService],
	controllers: [SyncController],
})
export class SyncModule {}
