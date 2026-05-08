import { Global, Module } from "@nestjs/common";
import { TunnelService } from "./tunnel.service";

@Global()
@Module({
	providers: [TunnelService],
	exports: [TunnelService],
})
export class TunnelModule {}
