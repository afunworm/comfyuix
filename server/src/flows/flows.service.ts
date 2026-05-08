import {
	Injectable,
	NotFoundException,
	ForbiddenException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { DatabaseService } from "../database/database.service";
import { BooksService } from "../books/books.service";

export class CreateFlowDto {
	name: string;
	[key: string]: any;
}

export class UpdateFlowDto {
	name: string;
	[key: string]: any;
}

@Injectable()
export class FlowsService {
	private readonly db;

	constructor(
		databaseService: DatabaseService,
		private booksService: BooksService,
	) {
		this.db = databaseService.db;
	}

	private parse(row: any) {
		if (!row) return null;
		const { flow_data, id, ...meta } = row;
		const parsed = JSON.parse(flow_data);
		delete parsed.id;
		return { id, ...meta, ...parsed };
	}

	private async checkAccess(
		bookId: string,
		userId?: number,
		bookPassword?: string,
	) {
		return this.booksService.findOne(bookId, userId, bookPassword);
	}

	async findAll(bookId: string, userId?: number, bookPassword?: string) {
		await this.checkAccess(bookId, userId, bookPassword);
		const rows = this.db
			.prepare(
				`
      SELECT * FROM flow WHERE book_id = ? ORDER BY created_at ASC
    `,
			)
			.all(bookId);
		return rows.map((r: any) => this.parse(r));
	}

	async findOne(
		bookId: string,
		id: string,
		userId?: number,
		bookPassword?: string,
	) {
		await this.checkAccess(bookId, userId, bookPassword);
		const row = this.db
			.prepare(
				`
      SELECT * FROM flow WHERE id = ? AND book_id = ?
    `,
			)
			.get(id, bookId);
		if (!row) throw new NotFoundException("Flow not found");
		return this.parse(row);
	}

	async create(bookId: string, userId: number, dto: CreateFlowDto) {
		const book = this.db
			.prepare("SELECT id FROM book WHERE id = ? AND user_id = ?")
			.get(bookId, userId);
		if (!book)
			throw new ForbiddenException("Book not found or you are not the owner");

		const { id: _ignored, ...flowData } = dto;
		const id = randomUUID();

		this.db
			.prepare(
				`
      INSERT INTO flow (id, book_id, flow_data) VALUES (?, ?, ?)
    `,
			)
			.run(id, bookId, JSON.stringify(flowData));

		return this.parse(this.db.prepare("SELECT * FROM flow WHERE id = ?").get(id));
	}

	async update(bookId: string, id: string, userId: number, dto: UpdateFlowDto) {
		const book = this.db
			.prepare("SELECT id FROM book WHERE id = ? AND user_id = ?")
			.get(bookId, userId);
		if (!book)
			throw new ForbiddenException("Book not found or you are not the owner");

		const row = this.db
			.prepare("SELECT id FROM flow WHERE id = ? AND book_id = ?")
			.get(id, bookId);
		if (!row) throw new NotFoundException("Flow not found");

		const { id: _ignored, ...flowData } = dto;

		this.db
			.prepare(
				`
      UPDATE flow SET flow_data = ?, updated_at = datetime('now') WHERE id = ?
    `,
			)
			.run(JSON.stringify(flowData), id);

		return this.parse(this.db.prepare("SELECT * FROM flow WHERE id = ?").get(id));
	}

	async remove(bookId: string, id: string, userId: number) {
		const book = this.db
			.prepare("SELECT id FROM book WHERE id = ? AND user_id = ?")
			.get(bookId, userId);
		if (!book)
			throw new ForbiddenException("Book not found or you are not the owner");

		const row = this.db
			.prepare("SELECT id FROM flow WHERE id = ? AND book_id = ?")
			.get(id, bookId);
		if (!row) throw new NotFoundException("Flow not found");

		this.db.prepare("DELETE FROM flow WHERE id = ?").run(id);
		return { deleted: true };
	}
}
