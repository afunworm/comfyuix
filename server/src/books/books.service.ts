import {
	Injectable,
	NotFoundException,
	ForbiddenException,
} from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { DatabaseService } from "../database/database.service";

export class CreateBookDto {
	name: string;
	description?: string;
	isPublic?: boolean;
	bookPassword?: string;
	serverId?: string;
}

export class UpdateBookDto {
	name?: string;
	description?: string;
	isPublic?: boolean;
	bookPassword?: string;
	serverId?: string | null;
}

@Injectable()
export class BooksService {
	private readonly db;

	constructor(databaseService: DatabaseService) {
		this.db = databaseService.db;
	}

	private parseFlows(bookId: string): any[] {
		const rows = this.db
			.prepare(
				`SELECT id, book_id, flow_data, created_at, updated_at
         FROM flow WHERE book_id = ? ORDER BY created_at ASC`,
			)
			.all(bookId);
		return rows.map(({ flow_data, id: flowId, ...meta }: any) => ({
			id: flowId,
			...meta,
			...JSON.parse(flow_data),
		}));
	}

	async create(userId: number, dto: CreateBookDto) {
		const bookPasswordHash =
			dto.isPublic === false && dto.bookPassword
				? await bcrypt.hash(dto.bookPassword, 10)
				: null;

		const id = randomUUID();
		this.db
			.prepare(
				`INSERT INTO book (id, name, description, endpoint_base, is_public, book_password_hash, user_id, server_id)
         VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
			)
			.run(
				id,
				dto.name,
				dto.description ?? "",
				dto.isPublic !== false ? 1 : 0,
				bookPasswordHash,
				userId,
				dto.serverId ?? null,
			);

		const book = this.db
			.prepare(
				`SELECT b.id, b.name, b.description, b.is_public, b.user_id, b.server_id,
                s.name as server_name, b.created_at, b.updated_at
         FROM book b LEFT JOIN server s ON b.server_id = s.id
         WHERE b.id = ?`,
			)
			.get(id);

		return { ...book, flows: [] };
	}

	findAll(userId?: number, onlySelf: boolean = false) {
		if (userId && onlySelf) {
			return this.db
				.prepare(
					`SELECT b.id, b.name, b.description, b.is_public, b.user_id, b.server_id,
                  s.name as server_name, b.created_at, b.updated_at
           FROM book b LEFT JOIN server s ON b.server_id = s.id
           WHERE b.user_id = ?`,
				)
				.all(userId);
		}

		if (userId) {
			return this.db
				.prepare(
					`SELECT b.id, b.name, b.description, b.is_public, b.user_id, b.server_id,
                  s.name as server_name, b.created_at, b.updated_at
           FROM book b LEFT JOIN server s ON b.server_id = s.id
           WHERE b.is_public = 1 OR b.user_id = ?`,
				)
				.all(userId);
		}

		return this.db
			.prepare(
				`SELECT b.id, b.name, b.description, b.is_public, b.user_id, b.server_id,
                s.name as server_name, b.created_at, b.updated_at
         FROM book b LEFT JOIN server s ON b.server_id = s.id
         WHERE b.is_public = 1`,
			)
			.all();
	}

	async findOne(id: string, userId?: number, bookPassword?: string) {
		const book = this.db
			.prepare(
				`SELECT b.id, b.name, b.description, b.is_public, b.book_password_hash,
                b.user_id, b.server_id, s.name as server_name, b.created_at, b.updated_at
         FROM book b LEFT JOIN server s ON b.server_id = s.id
         WHERE b.id = ?`,
			)
			.get(id) as any;
		if (!book) throw new NotFoundException("Book not found");

		if (!book.is_public) {
			if (!userId)
				throw new ForbiddenException("Authentication required to view this book");
			if (book.user_id !== userId) {
				if (!bookPassword) throw new ForbiddenException("Book password required");
				const valid = book.book_password_hash
					? await bcrypt.compare(bookPassword, book.book_password_hash)
					: false;
				if (!valid) throw new ForbiddenException("Invalid book password");
			}
		}

		return { ...book, flows: this.parseFlows(id) };
	}

	async update(id: string, userId: number, dto: UpdateBookDto) {
		const book = this.db
			.prepare(`SELECT * FROM book WHERE id = ? AND user_id = ?`)
			.get(id, userId) as any;
		if (!book) throw new NotFoundException("Book not found or you are not the owner");

		const name = dto.name !== undefined ? dto.name : book.name;
		const description = dto.description !== undefined ? dto.description : book.description;
		const isPublic = dto.isPublic !== undefined ? (dto.isPublic ? 1 : 0) : book.is_public;
		const serverId = "serverId" in dto ? (dto.serverId ?? null) : book.server_id;

		let bookPasswordHash = book.book_password_hash;
		if (dto.bookPassword !== undefined) {
			bookPasswordHash = dto.bookPassword ? await bcrypt.hash(dto.bookPassword, 10) : null;
		}

		this.db
			.prepare(
				`UPDATE book SET name = ?, description = ?, is_public = ?,
                book_password_hash = ?, server_id = ?, updated_at = datetime('now')
         WHERE id = ?`,
			)
			.run(name, description, isPublic, bookPasswordHash, serverId, id);

		return this.findOne(id, userId);
	}

	remove(id: string, userId: number) {
		const book = this.db
			.prepare(`SELECT id FROM book WHERE id = ? AND user_id = ?`)
			.get(id, userId);
		if (!book) throw new NotFoundException("Book not found or you are not the owner");
		this.db.prepare("DELETE FROM book WHERE id = ?").run(id);
		return { deleted: true };
	}

	getServerIdForBook(bookId: string): string | null {
		const book = this.db.prepare("SELECT server_id FROM book WHERE id = ?").get(bookId) as any;
		return book?.server_id ?? null;
	}

	async clone(id: string, userId: number) {
		const originalBook = this.db.prepare("SELECT * FROM book WHERE id = ?").get(id) as any;
		if (!originalBook) throw new NotFoundException("Book not found");

		if (!originalBook.is_public && originalBook.user_id !== userId) {
			throw new ForbiddenException("Cannot clone a private book you don't own");
		}

		const newBookId = randomUUID();
		this.db
			.prepare(
				`INSERT INTO book (id, name, description, endpoint_base, is_public, book_password_hash, user_id, server_id)
         VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
			)
			.run(
				newBookId,
				`${originalBook.name} (Copy)`,
				originalBook.description,
				originalBook.is_public,
				originalBook.book_password_hash,
				userId,
				null, // clones don't inherit server
			);

		const originalFlows = this.db
			.prepare(`SELECT flow_data FROM flow WHERE book_id = ?`)
			.all(id);

		for (const flow of originalFlows as any[]) {
			this.db
				.prepare(`INSERT INTO flow (id, book_id, flow_data) VALUES (?, ?, ?)`)
				.run(randomUUID(), newBookId, flow.flow_data);
		}

		return this.findOne(newBookId, userId);
	}
}
