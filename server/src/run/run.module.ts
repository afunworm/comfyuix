import { Module } from '@nestjs/common';
import { RunService } from './run.service';
import { RunController } from './run.controller';
import { TunnelModule } from '../tunnel/tunnel.module';
import { AssetsService } from '../assets/assets.service';

@Module({
	imports: [TunnelModule],
	providers: [RunService, AssetsService],
	controllers: [RunController],
})
export class RunModule {}
