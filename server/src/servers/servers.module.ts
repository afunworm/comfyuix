import { Module } from "@nestjs/common";
import { ServersService } from "./servers.service";
import { ServersController } from "./servers.controller";
import { DatabaseModule } from "../database/database.module";
import { TunnelModule } from "../tunnel/tunnel.module";

@Module({
	imports: [DatabaseModule, TunnelModule],
	providers: [ServersService],
	controllers: [ServersController],
	exports: [ServersService],
})
export class ServersModule {}
