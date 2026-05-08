import {
	Controller,
	Get,
	Post,
	Put,
	Delete,
	Param,
	Body,
	Request,
	Headers,
	UseGuards,
} from "@nestjs/common";
import { FlowsService, CreateFlowDto, UpdateFlowDto } from "./flows.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OptionalJwtAuthGuard } from "../auth/optional-jwt-auth.guard";

@Controller("books/:bookId/flows")
export class FlowsController {
	constructor(private flowsService: FlowsService) {}

	@UseGuards(OptionalJwtAuthGuard)
	@Get()
	findAll(
		@Param("bookId") bookId: string,
		@Request() req,
		@Headers("x-book-password") bookPassword?: string,
	) {
		return this.flowsService.findAll(bookId, req.user?.id, bookPassword);
	}

	@UseGuards(OptionalJwtAuthGuard)
	@Get(":id")
	findOne(
		@Param("bookId") bookId: string,
		@Param("id") id: string,
		@Request() req,
		@Headers("x-book-password") bookPassword?: string,
	) {
		return this.flowsService.findOne(bookId, id, req.user?.id, bookPassword);
	}

	@UseGuards(JwtAuthGuard)
	@Post()
	create(
		@Param("bookId") bookId: string,
		@Request() req,
		@Body() dto: CreateFlowDto,
	) {
		return this.flowsService.create(bookId, req.user.id, dto);
	}

	@UseGuards(JwtAuthGuard)
	@Put(":id")
	update(
		@Param("bookId") bookId: string,
		@Param("id") id: string,
		@Request() req,
		@Body() dto: UpdateFlowDto,
	) {
		return this.flowsService.update(bookId, id, req.user.id, dto);
	}

	@UseGuards(JwtAuthGuard)
	@Delete(":id")
	remove(
		@Param("bookId") bookId: string,
		@Param("id") id: string,
		@Request() req,
	) {
		return this.flowsService.remove(bookId, id, req.user.id);
	}
}
