import {
	Controller,
	Get,
	Post,
	Patch,
	Delete,
	Body,
	Param,
	UseGuards,
	Request,
	Query,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ServersService } from "./servers.service";
import { TunnelService } from "../tunnel/tunnel.service";

@Controller("servers")
@UseGuards(JwtAuthGuard)
export class ServersController {
	constructor(
		private readonly serversService: ServersService,
		private readonly tunnelService: TunnelService,
	) {}

	@Get()
	findAll(@Request() req) {
		return this.serversService.findAll(req.user.id);
	}

	@Get(":id")
	findOne(@Param("id") id: string, @Request() req) {
		return this.serversService.findOne(id, req.user.id);
	}

	@Post()
	create(@Request() req, @Body() body: any) {
		return this.serversService.create(req.user.id, body);
	}

	@Patch(":id")
	update(@Param("id") id: string, @Request() req, @Body() body: any) {
		return this.serversService.update(id, req.user.id, body);
	}

	@Delete(":id")
	remove(@Param("id") id: string, @Request() req) {
		return this.serversService.remove(id, req.user.id);
	}

	@Get(":id/tunnel-status")
	getTunnelStatus(
		@Param("id") id: string,
		@Request() req,
		@Query("since") since?: string,
	) {
		this.serversService.findOne(id, req.user.id); // ownership check
		const sinceMs = since ? parseInt(since, 10) : 0;
		return {
			connected: this.tunnelService.hasTunnel(id),
			events: this.tunnelService.getEventsSince(id, sinceMs),
		};
	}

	@Get(":id/tunnel-token")
	getTunnelToken(@Param("id") id: string, @Request() req) {
		return this.serversService.getTunnelToken(id, req.user.id);
	}

	@Post(":id/tunnel-token/regenerate")
	regenerateTunnelToken(@Param("id") id: string, @Request() req) {
		return this.serversService.regenerateTunnelToken(id, req.user.id);
	}

	@Patch(":id/tunnel-token/revoke")
	revokeTunnelToken(@Param("id") id: string, @Request() req) {
		return this.serversService.revokeTunnelToken(id, req.user.id);
	}
}
