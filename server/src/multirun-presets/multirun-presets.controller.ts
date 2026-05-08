import { Controller, Get, Post, Delete, Param, Body, Request, Headers, UseGuards } from '@nestjs/common';
import { MultirunPresetsService } from './multirun-presets.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';

@Controller('books/:bookId/multirun-presets')
export class MultirunPresetsController {
	constructor(private service: MultirunPresetsService) {}

	@UseGuards(OptionalJwtAuthGuard)
	@Get()
	findAll(
		@Param('bookId') bookId: string,
		@Request() req,
		@Headers('x-book-password') bookPassword?: string,
	) {
		return this.service.findAll(bookId, req.user?.id, bookPassword);
	}

	@UseGuards(JwtAuthGuard)
	@Post()
	create(
		@Param('bookId') bookId: string,
		@Request() req,
		@Body() dto: { name: string; presetData: any },
	) {
		return this.service.create(bookId, req.user.id, dto);
	}

	@UseGuards(JwtAuthGuard)
	@Delete(':id')
	remove(
		@Param('bookId') bookId: string,
		@Param('id') id: string,
		@Request() req,
	) {
		return this.service.remove(bookId, id, req.user.id);
	}
}
