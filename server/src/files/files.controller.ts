import {
	Controller,
	Get,
	Post,
	Delete,
	Body,
	Param,
	Query,
	UseGuards,
	Request,
	Sse,
	MessageEvent,
} from "@nestjs/common";
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { FilesService } from "./files.service";

@Controller("files")
export class FilesController {
	constructor(private readonly filesService: FilesService) {}

	@UseGuards(JwtAuthGuard)
	@Get(":serverId/ls")
	list(
		@Param("serverId") serverId: string,
		@Request() req,
		@Query("path") path = "",
		@Query("recursive") recursive?: string,
	) {
		return this.filesService.list(serverId, req.user.id, path, recursive === "true");
	}

	@UseGuards(JwtAuthGuard)
	@Delete(":serverId")
	delete(
		@Param("serverId") serverId: string,
		@Request() req,
		@Query("path") path: string,
	) {
		return this.filesService.delete(serverId, req.user.id, path);
	}

	@UseGuards(JwtAuthGuard)
	@Post(":serverId/mkdir")
	mkdir(
		@Param("serverId") serverId: string,
		@Request() req,
		@Body() body: { path: string },
	) {
		return this.filesService.mkdir(serverId, req.user.id, body.path);
	}

	@UseGuards(JwtAuthGuard)
	@Post(":serverId/rename")
	rename(
		@Param("serverId") serverId: string,
		@Request() req,
		@Body() body: { from: string; to: string },
	) {
		return this.filesService.rename(serverId, req.user.id, body.from, body.to);
	}

	@UseGuards(JwtAuthGuard)
	@Get(":serverId/meta")
	readMeta(
		@Param("serverId") serverId: string,
		@Request() req,
		@Query("path") path: string,
	) {
		return this.filesService.readMeta(serverId, req.user.id, path);
	}

	@UseGuards(JwtAuthGuard)
	@Get(":serverId/model-info")
	getModelInfo(
		@Param("serverId") serverId: string,
		@Request() req,
		@Query("path") path: string,
	) {
		return this.filesService.getModelInfo(serverId, req.user.id, path);
	}

	@UseGuards(JwtAuthGuard)
	@Post(":serverId/fetch")
	startFetch(
		@Param("serverId") serverId: string,
		@Request() req,
		@Body() body: { url: string; dest: string },
	) {
		return this.filesService.startFetch(serverId, req.user.id, body.url, body.dest);
	}

	@UseGuards(JwtAuthGuard)
	@Get(":serverId/fetch-status/:fetchId")
	getFetchStatus(
		@Param("serverId") serverId: string,
		@Param("fetchId") fetchId: string,
		@Request() req,
	) {
		return this.filesService.getFetchStatus(serverId, req.user.id, fetchId);
	}

	@UseGuards(JwtAuthGuard)
	@Delete(":serverId/fetch/:fetchId")
	cancelFetch(
		@Param("serverId") serverId: string,
		@Param("fetchId") fetchId: string,
		@Request() req,
	) {
		return this.filesService.cancelFetch(serverId, req.user.id, fetchId);
	}

	@UseGuards(JwtAuthGuard)
	@Sse(":serverId/fetch-stream/:fetchId")
	streamFetch(
		@Param("serverId") serverId: string,
		@Param("fetchId") fetchId: string,
		@Request() req,
	): Observable<MessageEvent> {
		return this.filesService
			.streamFetch(serverId, req.user.id, fetchId)
			.pipe(map((data) => ({ data }) as MessageEvent));
	}
}
