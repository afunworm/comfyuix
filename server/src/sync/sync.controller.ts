import { Controller, Post, Param, Req, UseGuards } from '@nestjs/common';
import { SyncService } from './sync.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('books/:bookId/sync')
export class SyncController {
	constructor(private readonly syncService: SyncService) {}

	@UseGuards(JwtAuthGuard)
	@Post('import')
	syncImport(@Param('bookId') bookId: string, @Req() req: any) {
		return this.syncService.syncImport(bookId, req.user.id);
	}

	@UseGuards(JwtAuthGuard)
	@Post('clean')
	syncClean(@Param('bookId') bookId: string, @Req() req: any) {
		return this.syncService.syncClean(bookId, req.user.id);
	}
}
