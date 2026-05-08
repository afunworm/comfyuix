import {
	Controller,
	Get,
	Post,
	Patch,
	Delete,
	Body,
	Param,
	Query,
	Request,
	UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { BookModelsService } from "./book-models.service";
import type { ServerModelDto } from "./book-models.service";

@Controller("server-models")
@UseGuards(JwtAuthGuard)
export class BookModelsController {
	constructor(private readonly bookModelsService: BookModelsService) {}

	@Get(":serverId")
	findAll(@Param("serverId") serverId: string, @Request() req) {
		return this.bookModelsService.findAll(serverId, req.user.id);
	}

	@Post(":serverId")
	create(
		@Param("serverId") serverId: string,
		@Request() req,
		@Body() body: ServerModelDto,
	) {
		return this.bookModelsService.create(serverId, req.user.id, body);
	}

	@Patch(":serverId/:modelId")
	update(
		@Param("serverId") serverId: string,
		@Param("modelId") modelId: string,
		@Request() req,
		@Body() body: Partial<ServerModelDto>,
	) {
		return this.bookModelsService.update(serverId, modelId, req.user.id, body);
	}

	@Delete(":serverId/:modelId")
	remove(
		@Param("serverId") serverId: string,
		@Param("modelId") modelId: string,
		@Request() req,
	) {
		return this.bookModelsService.remove(serverId, modelId, req.user.id);
	}

	@Get(":serverId/export/manifest")
	exportManifest(@Param("serverId") serverId: string, @Request() req) {
		return this.bookModelsService.exportManifest(serverId, req.user.id);
	}

	@Post(":serverId/import/manifest")
	importManifest(
		@Param("serverId") serverId: string,
		@Request() req,
		@Body() body: { version: number; models: ServerModelDto[] },
		@Query("mode") mode: "merge" | "replace" = "merge",
	) {
		return this.bookModelsService.importManifest(serverId, req.user.id, body, mode);
	}
}
