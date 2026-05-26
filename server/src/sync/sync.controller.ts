import { Controller, Post, Param, Req, Res, UseGuards } from '@nestjs/common';
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
	@Post('purge')
	async syncPurge(@Param('bookId') bookId: string, @Req() req: any, @Res() res: any) {
		res.raw.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		});

		try {
			for await (const event of this.syncService.syncPurgeStream(bookId, req.user.id)) {
				res.raw.write(`data: ${JSON.stringify(event)}\n\n`);
			}
		} catch (err: any) {
			console.error('[SyncPurge] error:', err);
			res.raw.write(`data: ${JSON.stringify({ phase: 'error', message: err.message ?? String(err) })}\n\n`);
		}

		res.raw.end();
	}

	@UseGuards(JwtAuthGuard)
	@Post('clean')
	async syncClean(@Param('bookId') bookId: string, @Req() req: any, @Res() res: any) {
		res.raw.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		});

		try {
			for await (const event of this.syncService.syncCleanStream(bookId, req.user.id)) {
				res.raw.write(`data: ${JSON.stringify(event)}\n\n`);
			}
		} catch (err: any) {
			console.error('[SyncClean] error:', err);
			res.raw.write(`data: ${JSON.stringify({ phase: 'error', message: err.message ?? String(err) })}\n\n`);
		}

		res.raw.end();
	}
}
