import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { BooksService } from '../books/books.service';

@Injectable()
export class MultirunPresetsService {
	private readonly db;

	constructor(
		databaseService: DatabaseService,
		private booksService: BooksService,
	) {
		this.db = databaseService.db;
	}

	private parse(row: any) {
		if (!row) return null;
		return { ...row, presetData: JSON.parse(row.preset_data), preset_data: undefined };
	}

	async findAll(bookId: string, userId?: number, bookPassword?: string) {
		await this.booksService.findOne(bookId, userId, bookPassword);
		const rows = this.db
			.prepare('SELECT * FROM multirun_preset WHERE book_id = ? ORDER BY created_at ASC')
			.all(bookId);
		return rows.map((r: any) => this.parse(r));
	}

	async create(bookId: string, userId: number, dto: { name: string; presetData: any }) {
		const book = this.db
			.prepare('SELECT id FROM book WHERE id = ? AND user_id = ?')
			.get(bookId, userId);
		if (!book) throw new ForbiddenException('Book not found or you are not the owner');

		const id = randomUUID();
		this.db
			.prepare(
				'INSERT INTO multirun_preset (id, book_id, user_id, name, preset_data) VALUES (?, ?, ?, ?, ?)',
			)
			.run(id, bookId, userId, dto.name.trim(), JSON.stringify(dto.presetData));

		return this.parse(
			this.db.prepare('SELECT * FROM multirun_preset WHERE id = ?').get(id),
		);
	}

	async remove(bookId: string, id: string, userId: number) {
		const book = this.db
			.prepare('SELECT id FROM book WHERE id = ? AND user_id = ?')
			.get(bookId, userId);
		if (!book) throw new ForbiddenException('Book not found or you are not the owner');

		const row = this.db
			.prepare('SELECT id FROM multirun_preset WHERE id = ? AND book_id = ?')
			.get(id, bookId);
		if (!row) throw new NotFoundException('Preset not found');

		this.db.prepare('DELETE FROM multirun_preset WHERE id = ?').run(id);
		return { deleted: true };
	}
}
