import { Injectable, OnApplicationShutdown } from "@nestjs/common";
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
	readonly db: Database.Database;

	constructor() {
		const path = process.env.DB_PATH ?? "./data/db.sqlite";
		console.log("[database] initializing at path:", path);
		mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.initialize();
	}

	private initialize() {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS user (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        username                    TEXT NOT NULL UNIQUE,
        email                       TEXT NOT NULL UNIQUE,
        password_hash               TEXT NOT NULL,
        email_verified              INTEGER NOT NULL DEFAULT 0,
        role                        TEXT NOT NULL DEFAULT 'user',
        is_disabled                 INTEGER NOT NULL DEFAULT 0,
        pending_email               TEXT,
        verification_token          TEXT,
        verification_token_expires  TEXT,
        magic_link_token            TEXT,
        magic_link_token_expires    TEXT,
        refresh_token_hash          TEXT,
        refresh_token_expires       TEXT,
        password_reset_token        TEXT,
        password_reset_token_expires TEXT,
        created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS book (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        description         TEXT NOT NULL DEFAULT '',
        endpoint_base       TEXT NOT NULL,
        is_public           INTEGER NOT NULL DEFAULT 1,
        book_password_hash  TEXT,
        user_id             INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS flow (
        id         TEXT PRIMARY KEY,
        book_id    TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
        flow_data  TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS asset_folder (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL CHECK(type IN ('input', 'output')),
        user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS asset (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        url        TEXT NOT NULL,
        type       TEXT NOT NULL CHECK(type IN ('input', 'output')),
        folder_id  INTEGER,
        api_data   TEXT,
        book_id    TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS quick_flow_group (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS quick_flow (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id                  INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        group_id                 INTEGER REFERENCES quick_flow_group(id) ON DELETE SET NULL,
        name                     TEXT NOT NULL,
        api_data                 TEXT NOT NULL,
        image_node_id            TEXT NOT NULL,
        seed_node_id             TEXT,
        positive_prompt_node_id  TEXT,
        sort_order               INTEGER NOT NULL DEFAULT 0,
        created_at               TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT OR IGNORE INTO settings (key, value) VALUES ('signups_enabled', '1');
    `);

		// ── Asset metadata columns ───────────────────────────────────────────────
		for (const col of ['prompt_positive TEXT', 'prompt_negative TEXT', 'seed TEXT']) {
			try {
				this.db.exec(`ALTER TABLE asset ADD COLUMN ${col}`);
			} catch (e: any) {
				if (!e.message.includes('duplicate column name')) throw e;
			}
		}
		// One-time migration: unwrap legacy api_data blob { version, apiData, meta }
		// into raw graph + the three new columns.
		{
			const assets = this.db
				.prepare('SELECT id, api_data FROM asset WHERE api_data IS NOT NULL')
				.all() as any[];
			const update = this.db.prepare(
				'UPDATE asset SET api_data = ?, prompt_positive = ?, prompt_negative = ?, seed = ? WHERE id = ?',
			);
			for (const asset of assets) {
				try {
					const parsed = JSON.parse(asset.api_data);
					if (parsed?.version === 1 && parsed.apiData) {
						const meta = parsed.meta ?? {};
						let seedVal: string | null = null;
						if (meta.seed != null) {
							seedVal = String(meta.seed);
						} else if (
							meta.seedNodeId &&
							parsed.apiData[meta.seedNodeId]?.inputs?.seed != null
						) {
							seedVal = String(parsed.apiData[meta.seedNodeId].inputs.seed);
						}
						update.run(
							JSON.stringify(parsed.apiData),
							meta.positivePrompt ?? null,
							meta.negativePrompt ?? null,
							seedVal,
							asset.id,
						);
					}
				} catch {
					/* skip malformed rows */
				}
			}
		}

		// Additive migrations for columns added after initial schema
		try {
			this.db.exec(`ALTER TABLE book ADD COLUMN tunnel_token TEXT`);
		} catch (e: any) {
			if (!e.message.includes("duplicate column name")) throw e;
		}
		try {
			this.db.exec(`CREATE UNIQUE INDEX idx_book_tunnel_token ON book (tunnel_token) WHERE tunnel_token IS NOT NULL`);
		} catch (e: any) {
			if (!e.message.includes("already exists")) throw e;
		}
		try {
			this.db.exec(`ALTER TABLE book ADD COLUMN models_path TEXT`);
		} catch (e: any) {
			if (!e.message.includes("duplicate column name")) throw e;
		}
		try {
			this.db.exec(`ALTER TABLE user ADD COLUMN hf_token TEXT`);
		} catch (e: any) {
			if (!e.message.includes("duplicate column name")) throw e;
		}
		try {
			this.db.exec(`ALTER TABLE user ADD COLUMN civitai_token TEXT`);
		} catch (e: any) {
			if (!e.message.includes("duplicate column name")) throw e;
		}
		try {
			this.db.exec(`ALTER TABLE quick_flow ADD COLUMN preset_options TEXT NOT NULL DEFAULT '[]'`);
		} catch (e: any) {
			if (!e.message.includes("duplicate column name")) throw e;
		}
		try {
			this.db.exec(`ALTER TABLE quick_flow ADD COLUMN ask_on_run TEXT NOT NULL DEFAULT '[]'`);
		} catch (e: any) {
			if (!e.message.includes("duplicate column name")) throw e;
		}
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS book_model (
        id         TEXT PRIMARY KEY,
        book_id    TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        dest       TEXT NOT NULL,
        source     TEXT NOT NULL CHECK(source IN ('huggingface', 'civitai', 'other')),
        url        TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

		// ── Server entity (ComfyUI machine with tunnel) ──────────────────────────
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS server (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        user_id      INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        tunnel_token TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
		try {
			this.db.exec(
				`CREATE UNIQUE INDEX idx_server_tunnel_token ON server (tunnel_token) WHERE tunnel_token IS NOT NULL`,
			);
		} catch (e: any) {
			if (!e.message.includes("already exists")) throw e;
		}

		// Models belong to servers, not books
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS server_model (
        id         TEXT PRIMARY KEY,
        server_id  TEXT NOT NULL REFERENCES server(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        dest       TEXT NOT NULL,
        source     TEXT NOT NULL CHECK(source IN ('huggingface', 'civitai', 'other')),
        url        TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

		try {
			this.db.exec(`ALTER TABLE server_model ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
		} catch (e: any) {
			if (!e.message.includes("duplicate column name")) throw e;
		}

		// Books now link to a server
		try {
			this.db.exec(`ALTER TABLE book ADD COLUMN server_id TEXT REFERENCES server(id) ON DELETE SET NULL`);
		} catch (e: any) {
			if (!e.message.includes("duplicate column name")) throw e;
		}

		// Folders are now book-scoped
		try {
			this.db.exec(`ALTER TABLE asset_folder ADD COLUMN book_id TEXT REFERENCES book(id) ON DELETE CASCADE`);
		} catch (e: any) {
			if (!e.message.includes("duplicate column name")) throw e;
		}

		// Data migration: for each book with tunnel_token, create a server and link it
		{
			const serverCount = (this.db.prepare("SELECT COUNT(*) as c FROM server").get() as any).c;
			if (serverCount === 0) {
				const booksWithTunnel = this.db
					.prepare(
						"SELECT id, name, user_id, tunnel_token FROM book WHERE tunnel_token IS NOT NULL",
					)
					.all() as any[];
				for (const book of booksWithTunnel) {
					const serverId = randomUUID();
					this.db
						.prepare(
							"INSERT INTO server (id, name, user_id, tunnel_token) VALUES (?, ?, ?, ?)",
						)
						.run(serverId, book.name, book.user_id, book.tunnel_token);
					this.db
						.prepare("UPDATE book SET server_id = ? WHERE id = ?")
						.run(serverId, book.id);
					// Migrate book_model entries
					const models = this.db
						.prepare("SELECT * FROM book_model WHERE book_id = ?")
						.all(book.id) as any[];
					for (const model of models) {
						this.db
							.prepare(
								"INSERT OR IGNORE INTO server_model (id, server_id, name, dest, source, url) VALUES (?, ?, ?, ?, ?, ?)",
							)
							.run(randomUUID(), serverId, model.name, model.dest, model.source, model.url);
					}
				}
			}
		}

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS multirun_preset (
        id           TEXT PRIMARY KEY,
        book_id      TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
        user_id      INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        preset_data  TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

		// Editor layer data: link edited assets back to their source + store mask PNG
		try {
			this.db.exec(`ALTER TABLE asset ADD COLUMN source_asset_id INTEGER REFERENCES asset(id) ON DELETE SET NULL`);
		} catch (e: any) {
			if (!e.message.includes('duplicate column name')) throw e;
		}
		try {
			this.db.exec(`ALTER TABLE asset ADD COLUMN layer_data TEXT`);
		} catch (e: any) {
			if (!e.message.includes('duplicate column name')) throw e;
		}
	}

	onApplicationShutdown() {
		this.db.close();
	}
}
