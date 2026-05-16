import { Controller, Get, Post, Param, Body, Headers, Req, UseGuards } from '@nestjs/common';
import { RunService, RunDto } from './run.service';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';

@Controller('books/:bookId/run')
export class RunController {
	constructor(private readonly runService: RunService) {}

	@UseGuards(OptionalJwtAuthGuard)
	@Post()
	run(
		@Param('bookId') bookId: string,
		@Body() dto: RunDto,
		@Headers('x-book-password') _bookPassword?: string,
	) {
		return this.runService.run(bookId, dto);
	}

	@UseGuards(OptionalJwtAuthGuard)
	@Post('submit')
	submit(
		@Param('bookId') bookId: string,
		@Body() dto: RunDto,
	) {
		return this.runService.submit(bookId, dto);
	}

	@UseGuards(OptionalJwtAuthGuard)
	@Post('wait/:promptId')
	waitResult(
		@Param('bookId') bookId: string,
		@Param('promptId') promptId: string,
		@Req() req: any,
		@Body() body: { apiData?: string; promptPositive?: string; promptNegative?: string; seed?: string },
	) {
		return this.runService.waitResult(bookId, promptId, req.user?.id, body);
	}

	@UseGuards(OptionalJwtAuthGuard)
	@Post('upload/image')
	uploadImage(
		@Param('bookId') bookId: string,
		@Req() req: any,
	) {
		const body: Buffer = req.body ?? Buffer.alloc(0);
		const contentType: string = req.headers['content-type'] ?? 'application/octet-stream';
		const userId: number | undefined = req.user?.id;
		return this.runService.uploadImage(bookId, body, contentType, userId);
	}

	@UseGuards(OptionalJwtAuthGuard)
	@Get('status/:promptId')
	getStatus(
		@Param('bookId') bookId: string,
		@Param('promptId') promptId: string,
	) {
		return this.runService.getStatus(bookId, promptId);
	}

	@UseGuards(OptionalJwtAuthGuard)
	@Post('raw/submit')
	submitRaw(
		@Param('bookId') bookId: string,
		@Body() body: { apiData: Record<string, any> },
	) {
		return this.runService.submitRaw(bookId, body);
	}

	@UseGuards(OptionalJwtAuthGuard)
	@Post('raw')
	runRaw(
		@Param('bookId') bookId: string,
		@Body() body: { apiData: Record<string, any> },
	) {
		return this.runService.runRaw(bookId, body);
	}
}
