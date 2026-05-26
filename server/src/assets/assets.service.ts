import {
	Injectable,
	NotFoundException,
	BadRequestException,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

export class MoveToFolderDto {
	folderId: number | null;
}

export type AssetType = "input" | "output";

export class CreateAssetDto {
	url: string;
	type: AssetType;
	bookId: string;
	apiData?: string;
	promptPositive?: string;
	promptNegative?: string;
	seed?: string;
	sourceAssetId?: number | null;
	layerData?: string | null;
}

@Injectable()
export class AssetsService {
	private readonly db;

	constructor(databaseService: DatabaseService) {
		this.db = databaseService.db;
	}

	create(userId: number, dto: CreateAssetDto) {
		if (!["input", "output"].includes(dto.type)) {
			throw new BadRequestException("type must be 'input' or 'output'");
		}
		const book = this.db
			.prepare("SELECT id FROM book WHERE id = ?")
			.get(dto.bookId);
		if (!book) throw new NotFoundException("Book not found");

		const result = this.db
			.prepare(
				`INSERT INTO asset (url, type, book_id, user_id, api_data, prompt_positive, prompt_negative, seed, source_asset_id, layer_data)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				dto.url,
				dto.type,
				dto.bookId,
				userId,
				dto.apiData ?? null,
				dto.promptPositive ?? null,
				dto.promptNegative ?? null,
				dto.seed ?? null,
				dto.sourceAssetId ?? null,
				dto.layerData ?? null,
			);

		return this.db
			.prepare("SELECT * FROM asset WHERE id = ?")
			.get(result.lastInsertRowid);
	}

	findById(id: number, userId: number) {
		const row = this.db
			.prepare('SELECT * FROM asset WHERE id = ? AND user_id = ?')
			.get(id, userId);
		if (!row) throw new NotFoundException('Asset not found or not yours');
		return row;
	}

	findByUser(userId: number, type?: AssetType) {
		if (type) {
			return this.db
				.prepare(`SELECT * FROM asset WHERE user_id = ? AND type = ? ORDER BY created_at DESC`)
				.all(userId, type);
		}
		return this.db
			.prepare(`SELECT * FROM asset WHERE user_id = ? ORDER BY created_at DESC`)
			.all(userId);
	}

	remove(id: number, userId: number) {
		const asset = this.db
			.prepare("SELECT id FROM asset WHERE id = ? AND user_id = ?")
			.get(id, userId);
		if (!asset) throw new NotFoundException("Asset not found or not yours");
		this.db.prepare("DELETE FROM asset WHERE id = ?").run(id);
		return { deleted: true };
	}

	getOrphanedCount(userId: number): { total: number } {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) as total FROM asset WHERE user_id = ? AND book_id NOT IN (SELECT id FROM book)`,
			)
			.get(userId) as any;
		return { total: row.total };
	}

	deleteOrphaned(userId: number): { deleted: number } {
		const result = this.db
			.prepare(
				`DELETE FROM asset WHERE user_id = ? AND book_id NOT IN (SELECT id FROM book)`,
			)
			.run(userId);
		return { deleted: result.changes };
	}

	moveToFolder(id: number, userId: number, folderId: number | null) {
		const asset = this.db
			.prepare("SELECT id FROM asset WHERE id = ? AND user_id = ?")
			.get(id, userId);
		if (!asset) throw new NotFoundException("Asset not found or not yours");

		if (folderId !== null) {
			const folder = this.db
				.prepare("SELECT id FROM asset_folder WHERE id = ? AND user_id = ?")
				.get(folderId, userId);
			if (!folder) throw new NotFoundException("Folder not found or not yours");
		}

		this.db
			.prepare("UPDATE asset SET folder_id = ? WHERE id = ?")
			.run(folderId, id);
		return this.db.prepare("SELECT * FROM asset WHERE id = ?").get(id);
	}
}
