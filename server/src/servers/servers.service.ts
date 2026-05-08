import { Injectable, NotFoundException, ForbiddenException } from "@nestjs/common";
import { randomUUID, randomBytes } from "crypto";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class ServersService {
	private readonly db;

	constructor(databaseService: DatabaseService) {
		this.db = databaseService.db;
	}

	findAll(userId: number) {
		return this.db
			.prepare(
				`SELECT id, name, created_at, updated_at
         FROM server WHERE user_id = ? ORDER BY created_at ASC`,
			)
			.all(userId);
	}

	findOne(id: string, userId: number) {
		const server = this.db
			.prepare(
				`SELECT id, name, user_id, created_at, updated_at
         FROM server WHERE id = ?`,
			)
			.get(id) as any;
		if (!server) throw new NotFoundException("Server not found");
		if (server.user_id !== userId) throw new ForbiddenException("You do not own this server");
		return server;
	}

	create(userId: number, dto: { name: string }) {
		const id = randomUUID();
		this.db
			.prepare(`INSERT INTO server (id, name, user_id) VALUES (?, ?, ?)`)
			.run(id, dto.name, userId);
		return this.db
			.prepare(`SELECT id, name, created_at, updated_at FROM server WHERE id = ?`)
			.get(id);
	}

	update(id: string, userId: number, dto: { name?: string }) {
		const server = this.findOne(id, userId) as any;
		const name = dto.name !== undefined ? dto.name : server.name;
		this.db
			.prepare(`UPDATE server SET name = ?, updated_at = datetime('now') WHERE id = ?`)
			.run(name, id);
		return this.findOne(id, userId);
	}

	remove(id: string, userId: number) {
		this.findOne(id, userId);
		this.db.prepare(`DELETE FROM server WHERE id = ?`).run(id);
		return { deleted: true };
	}

	getTunnelToken(id: string, userId: number) {
		const server = this.db
			.prepare(`SELECT tunnel_token FROM server WHERE id = ? AND user_id = ?`)
			.get(id, userId) as any;
		if (!server) throw new NotFoundException("Server not found or you are not the owner");
		return { tunnelToken: server.tunnel_token ?? null };
	}

	regenerateTunnelToken(id: string, userId: number) {
		const server = this.db
			.prepare(`SELECT id FROM server WHERE id = ? AND user_id = ?`)
			.get(id, userId);
		if (!server) throw new NotFoundException("Server not found or you are not the owner");
		const token = randomBytes(32).toString("hex");
		this.db.prepare(`UPDATE server SET tunnel_token = ? WHERE id = ?`).run(token, id);
		return { tunnelToken: token };
	}

	revokeTunnelToken(id: string, userId: number) {
		const server = this.db
			.prepare(`SELECT id FROM server WHERE id = ? AND user_id = ?`)
			.get(id, userId);
		if (!server) throw new NotFoundException("Server not found or you are not the owner");
		this.db.prepare(`UPDATE server SET tunnel_token = NULL WHERE id = ?`).run(id);
		return { tunnelToken: null };
	}

	/** Returns server_id for a given book. Used internally by the proxy. */
	getServerIdForBook(bookId: string): string | null {
		const book = this.db
			.prepare(`SELECT server_id FROM book WHERE id = ?`)
			.get(bookId) as any;
		return book?.server_id ?? null;
	}
}
