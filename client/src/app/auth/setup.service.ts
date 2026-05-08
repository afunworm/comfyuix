import { Injectable, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { firstValueFrom } from "rxjs";
import { ComfyUIDatabaseService } from "../comfyui/comfyui-database.service";
import { AuthService } from "./auth.service";

@Injectable({ providedIn: "root" })
export class SetupService {
	private http = inject(HttpClient);
	private db = inject(ComfyUIDatabaseService);
	private authService = inject(AuthService);

	readonly needsSetup = signal<boolean>(false);

	async checkStatus(): Promise<void> {
		try {
			const res = await firstValueFrom(
				this.http.get<{ needsSetup: boolean }>(`${this.db.httpEndpoint()}/setup/status`),
			);
			this.needsSetup.set(res.needsSetup);
		} catch {
			this.needsSetup.set(false);
		}
	}

	async createFirstAccount(
		username: string,
		email: string,
		password: string,
		signupsEnabled: boolean,
	): Promise<void> {
		const res = await firstValueFrom(
			this.http.post<{ access_token: string; userId: number; username: string; role: string }>(
				`${this.db.httpEndpoint()}/setup/init`,
				{ username, email, password, signupsEnabled },
			),
		);
		this.authService.handleAuthResponse(res);
		this.needsSetup.set(false);
	}
}
