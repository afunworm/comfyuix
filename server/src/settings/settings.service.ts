import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class SettingsService {
	constructor(private db: DatabaseService) {}

	get(key: string): string | undefined {
		const row = this.db.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		return row?.value;
	}

	set(key: string, value: string): void {
		this.db.db
			.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
			.run(key, value);
	}

	getSignupsEnabled(): boolean {
		return this.get("signups_enabled") !== "0";
	}
}
