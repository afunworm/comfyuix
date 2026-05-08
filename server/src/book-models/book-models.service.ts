import { Injectable, NotFoundException, ForbiddenException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { DatabaseService } from "../database/database.service";

export interface ServerModelDto {
	name: string;
	dest: string;
	source: "huggingface" | "civitai" | "other";
	url: string;
	is_active?: number;
}

@Injectable()
export class BookModelsService {
	private readonly db;

	constructor(databaseService: DatabaseService) {
		this.db = databaseService.db;
	}

	private assertOwner(serverId: string, userId: number) {
		const server = this.db
			.prepare("SELECT user_id FROM server WHERE id = ?")
			.get(serverId) as any;
		if (!server) throw new NotFoundException("Server not found");
		if (server.user_id !== userId) throw new ForbiddenException("You do not own this server");
	}

	findAll(serverId: string, userId: number) {
		this.assertOwner(serverId, userId);
		return this.db
			.prepare(
				"SELECT * FROM server_model WHERE server_id = ? ORDER BY created_at ASC",
			)
			.all(serverId);
	}

	create(serverId: string, userId: number, dto: ServerModelDto) {
		this.assertOwner(serverId, userId);
		const id = randomUUID();
		this.db
			.prepare(
				"INSERT INTO server_model (id, server_id, name, dest, source, url) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(id, serverId, dto.name, dto.dest, dto.source, dto.url);
		return this.db.prepare("SELECT * FROM server_model WHERE id = ?").get(id);
	}

	update(serverId: string, modelId: string, userId: number, dto: Partial<ServerModelDto>) {
		this.assertOwner(serverId, userId);
		const model = this.db
			.prepare("SELECT * FROM server_model WHERE id = ? AND server_id = ?")
			.get(modelId, serverId) as any;
		if (!model) throw new NotFoundException("Model entry not found");

		const name = dto.name !== undefined ? dto.name : model.name;
		const dest = dto.dest !== undefined ? dto.dest : model.dest;
		const source = dto.source !== undefined ? dto.source : model.source;
		const url = dto.url !== undefined ? dto.url : model.url;
		const is_active = dto.is_active !== undefined ? dto.is_active : model.is_active;

		this.db
			.prepare(
				"UPDATE server_model SET name = ?, dest = ?, source = ?, url = ?, is_active = ? WHERE id = ?",
			)
			.run(name, dest, source, url, is_active, modelId);
		return this.db.prepare("SELECT * FROM server_model WHERE id = ?").get(modelId);
	}

	remove(serverId: string, modelId: string, userId: number) {
		this.assertOwner(serverId, userId);
		const model = this.db
			.prepare("SELECT id FROM server_model WHERE id = ? AND server_id = ?")
			.get(modelId, serverId);
		if (!model) throw new NotFoundException("Model entry not found");
		this.db.prepare("DELETE FROM server_model WHERE id = ?").run(modelId);
		return { deleted: true };
	}

	exportManifest(serverId: string, userId: number) {
		this.assertOwner(serverId, userId);
		const models = this.db
			.prepare(
				"SELECT name, dest, source, url FROM server_model WHERE server_id = ? ORDER BY created_at ASC",
			)
			.all(serverId);
		return { version: 1, models };
	}

	importManifest(
		serverId: string,
		userId: number,
		manifest: { version: number; models: ServerModelDto[] },
		mode: "merge" | "replace" = "merge",
	) {
		this.assertOwner(serverId, userId);
		if (mode === "replace") {
			this.db.prepare("DELETE FROM server_model WHERE server_id = ?").run(serverId);
		}

		const insert = this.db.prepare(
			"INSERT OR IGNORE INTO server_model (id, server_id, name, dest, source, url) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const insertMany = this.db.transaction((models: ServerModelDto[]) => {
			for (const m of models) {
				insert.run(randomUUID(), serverId, m.name, m.dest, m.source ?? "other", m.url);
			}
		});
		insertMany(manifest.models ?? []);
		return this.findAll(serverId, userId);
	}
}
