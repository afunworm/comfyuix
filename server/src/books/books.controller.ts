import {
	Controller,
	Get,
	Post,
	Put,
	Delete,
	Body,
	Param,
	UseGuards,
	Request,
	Headers,
	Query,
} from "@nestjs/common";
import { BooksService } from "./books.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OptionalJwtAuthGuard } from "../auth/optional-jwt-auth.guard";
import { TunnelService } from "../tunnel/tunnel.service";

@Controller("books")
export class BooksController {
	constructor(
		private booksService: BooksService,
		private tunnelService: TunnelService,
	) {}

	@UseGuards(OptionalJwtAuthGuard)
	@Get()
	findAll(@Request() req, @Query("self") self?: string) {
		const onlySelf = self === "true";
		return this.booksService.findAll(req.user?.id, onlySelf);
	}

	@UseGuards(OptionalJwtAuthGuard)
	@Get(":id")
	findOne(
		@Param("id") id: string,
		@Request() req,
		@Headers("x-book-password") bookPassword?: string,
	) {
		return this.booksService.findOne(id, req.user?.id, bookPassword);
	}

	@UseGuards(JwtAuthGuard)
	@Post()
	create(@Request() req, @Body() body: any) {
		return this.booksService.create(req.user.id, body);
	}

	@UseGuards(JwtAuthGuard)
	@Put(":id")
	update(@Param("id") id: string, @Request() req, @Body() body: any) {
		return this.booksService.update(id, req.user.id, body);
	}

	@UseGuards(JwtAuthGuard)
	@Delete(":id")
	remove(@Param("id") id: string, @Request() req) {
		return this.booksService.remove(id, req.user.id);
	}

	@UseGuards(JwtAuthGuard)
	@Post(":id/clone")
	clone(@Param("id") id: string, @Request() req) {
		return this.booksService.clone(id, req.user.id);
	}

	/** Kept for backward compat with the book player. Resolves book→server internally. */
	@UseGuards(OptionalJwtAuthGuard)
	@Get(":id/tunnel-status")
	getTunnelStatus(@Param("id") id: string, @Query("since") since?: string) {
		const serverId = this.booksService.getServerIdForBook(id);
		const sinceMs = since ? parseInt(since, 10) : 0;
		if (!serverId) return { connected: false, os: 'linux' as const, tunnelVersion: '', events: [] };
		return {
			connected: this.tunnelService.hasTunnel(serverId),
			os: this.tunnelService.getOs(serverId),
			tunnelVersion: this.tunnelService.getVersion(serverId),
			events: this.tunnelService.getEventsSince(serverId, sinceMs),
		};
	}
}
