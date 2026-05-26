import {
	Injectable,
	NotFoundException,
	ForbiddenException,
	ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { TunnelService } from '../tunnel/tunnel.service';
import { AssetsService } from '../assets/assets.service';

export interface SyncImportResult {
	created: number;
	skipped: number;
}

export interface SyncCleanResult {
	deleted: number;
	skipped: number;
}

export type SyncCleanEvent =
	| { phase: 'listing' }
	| { phase: 'deleting'; total: number; deleted: number }
	| { phase: 'done'; deleted: number; skipped: number }
	| { phase: 'error'; message: string };

@Injectable()
export class SyncService {
	private readonly db;

	constructor(
		databaseService: DatabaseService,
		private readonly tunnelService: TunnelService,
		private readonly assetsService: AssetsService,
	) {
		this.db = databaseService.db;
	}

	async syncImport(bookId: string, userId: number): Promise<SyncImportResult> {
		const serverId = this.resolveBook(bookId, userId);
		const serverFiles = await this.listBookOutputFiles(serverId, bookId);
		const existingFilenames = this.getExistingAssetFilenames(bookId);

		let created = 0;
		for (const file of serverFiles) {
			const { filename, subfolder } = this.parseOutputEntry(file);
			if (existingFilenames.has(filename)) continue;

			const subfolderPart = subfolder ? `&subfolder=${encodeURIComponent(subfolder)}` : '';
			const url = `/proxy/${bookId}/view?filename=${encodeURIComponent(filename)}${subfolderPart}&type=output`;
			this.assetsService.create(userId, { url, type: 'output', bookId });
			created++;
		}

		return { created, skipped: serverFiles.length - created };
	}

	async *syncCleanStream(bookId: string, userId: number): AsyncGenerator<SyncCleanEvent> {
		const serverId = this.resolveBook(bookId, userId);

		yield { phase: 'listing' };

		const serverFiles = await this.listBookOutputFiles(serverId, bookId);
		const existingFilenames = this.getExistingAssetFilenames(bookId);
		const toDelete = serverFiles.filter(
			(file) => !existingFilenames.has(this.parseOutputEntry(file).filename),
		);

		const total = toDelete.length;
		yield { phase: 'deleting', total, deleted: 0 };

		let deleted = 0;
		const BATCH = 20;
		for (let i = 0; i < toDelete.length; i += BATCH) {
			const batch = toDelete.slice(i, i + BATCH);
			const results = await Promise.allSettled(
				batch.map((file) => this.tunnelService.fsDelete(serverId, file.path)),
			);
			deleted += results.filter((r) => r.status === 'fulfilled').length;
			yield { phase: 'deleting', total, deleted };
		}

		yield { phase: 'done', deleted, skipped: serverFiles.length - deleted };
	}

	private resolveBook(bookId: string, userId: number): string {
		const book = this.db
			.prepare('SELECT server_id, user_id FROM book WHERE id = ?')
			.get(bookId) as any;
		if (!book) throw new NotFoundException('Book not found');
		if (book.user_id !== userId) throw new ForbiddenException('You do not own this book');

		const serverId: string | null = book.server_id ?? null;
		if (!serverId || !this.tunnelService.hasTunnel(serverId)) {
			throw new ServiceUnavailableException('No tunnel connected for this book');
		}
		return serverId;
	}

	private async listBookOutputFiles(serverId: string, bookId: string): Promise<any[]> {
		const entries: any[] = await this.tunnelService.fsList(serverId, '../output', true, 300_000);
		return entries.filter(
			(e) => e.type === 'file' && (e.name as string).startsWith(bookId + '-'),
		);
	}

	private getExistingAssetFilenames(bookId: string): Set<string> {
		const assets = this.db
			.prepare("SELECT url FROM asset WHERE book_id = ? AND type = 'output'")
			.all(bookId) as any[];

		const filenames = new Set<string>();
		for (const asset of assets) {
			const filename = this.filenameFromUrl(asset.url);
			if (filename) filenames.add(filename);
		}
		return filenames;
	}

	private filenameFromUrl(url: string): string | null {
		try {
			const qs = url.includes('?') ? url.split('?')[1] : '';
			return new URLSearchParams(qs).get('filename');
		} catch {
			return null;
		}
	}

	private parseOutputEntry(entry: any): { filename: string; subfolder: string } {
		const normalized = (entry.path as string).replace(/\\/g, '/');
		// strip everything up to and including the "output/" segment
		const outputIdx = normalized.indexOf('output/');
		const afterOutput = outputIdx >= 0 ? normalized.slice(outputIdx + 'output/'.length) : normalized;
		const lastSlash = afterOutput.lastIndexOf('/');
		const filename = lastSlash >= 0 ? afterOutput.slice(lastSlash + 1) : afterOutput;
		const subfolder = lastSlash >= 0 ? afterOutput.slice(0, lastSlash) : '';
		return { filename, subfolder };
	}
}
