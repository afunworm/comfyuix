import {
	Controller,
	Get,
	Post,
	Patch,
	Delete,
	Param,
	Body,
	Query,
	Request,
	UseGuards,
	ParseIntPipe,
} from "@nestjs/common";
import { AssetsService, CreateAssetDto, MoveToFolderDto } from "./assets.service";
import type { AssetType } from "./assets.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@Controller("assets")
@UseGuards(JwtAuthGuard)
export class AssetsController {
	constructor(private assetsService: AssetsService) {}

	/** GET /assets?type=input */
	@Get()
	findByUser(@Request() req, @Query("type") type?: AssetType) {
		return this.assetsService.findByUser(req.user.id, type);
	}

	/** GET /assets/:id — returns full record including layer_data */
	@Get(':id')
	findById(@Param('id', ParseIntPipe) id: number, @Request() req) {
		return this.assetsService.findById(id, req.user.id);
	}

	@Post()
	create(@Request() req, @Body() dto: CreateAssetDto) {
		return this.assetsService.create(req.user.id, dto);
	}

	@Patch(":id/folder")
	moveToFolder(
		@Param("id", ParseIntPipe) id: number,
		@Request() req,
		@Body() dto: MoveToFolderDto,
	) {
		return this.assetsService.moveToFolder(id, req.user.id, dto.folderId);
	}

	@Delete(":id")
	remove(@Param("id", ParseIntPipe) id: number, @Request() req) {
		return this.assetsService.remove(id, req.user.id);
	}
}
