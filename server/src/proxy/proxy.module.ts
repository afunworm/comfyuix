import { Module } from "@nestjs/common";
import { ProxyController } from "./proxy.controller";
import { TunnelModule } from "../tunnel/tunnel.module";
import { DatabaseModule } from "../database/database.module";

@Module({
	imports: [TunnelModule, DatabaseModule],
	controllers: [ProxyController],
})
export class ProxyModule {}
