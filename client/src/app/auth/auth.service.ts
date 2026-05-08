import { Injectable, inject, signal, computed } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { Router } from "@angular/router";
import { firstValueFrom } from "rxjs";
import { ComfyUIDatabaseService } from "../comfyui/comfyui-database.service";

export interface AuthUser {
	userId: number;
	username: string;
	role: string;
}

interface TokenPayload {
	sub: number;
	username: string;
	role: string;
	exp: number;
}

interface AuthResponse {
	access_token: string;
	userId: number;
	username: string;
	role: string;
}

const ACCESS_TOKEN_KEY = "access_token";

@Injectable({ providedIn: "root" })
export class AuthService {
	private http = inject(HttpClient);
	private router = inject(Router);
	private db = inject(ComfyUIDatabaseService);

	private _user = signal<AuthUser | null>(null);

	/** The currently authenticated user, or null if not logged in. */
	readonly user = this._user.asReadonly();

	/** True when a user is logged in. */
	readonly isLoggedIn = computed(() => this._user() !== null);

	/** True when the logged-in user has the admin role. */
	readonly isAdmin = computed(() => this._user()?.role === 'admin');

	constructor() {
		this.restoreSession();
	}

	// ── Public API ────────────────────────────────────────────────────────────

	async login(identifier: string, password: string): Promise<void> {
		const res = await firstValueFrom(
			this.http.post<AuthResponse>(`${this.db.httpEndpoint()}/auth/login`, {
				identifier,
				password,
			}),
		);
		this.handleAuthResponse(res);
	}

	async signup(username: string, email: string, password: string): Promise<void> {
		await firstValueFrom(
			this.http.post(`${this.db.httpEndpoint()}/auth/signup`, { username, email, password }),
		);
	}

	async sendMagicLink(email: string): Promise<void> {
		await firstValueFrom(
			this.http.post(`${this.db.httpEndpoint()}/auth/magic-link`, { email }),
		);
	}

	async confirmMagicLink(token: string): Promise<void> {
		const res = await firstValueFrom(
			this.http.get<AuthResponse>(
				`${this.db.httpEndpoint()}/auth/magic-link/confirm`,
				{ params: { token } },
			),
		);
		this.handleAuthResponse(res);
	}

	async requestPasswordReset(email: string): Promise<void> {
		await firstValueFrom(
			this.http.post(`${this.db.httpEndpoint()}/auth/forgot-password`, { email }),
		);
	}

	async resetPasswordWithToken(token: string, newPassword: string): Promise<void> {
		await firstValueFrom(
			this.http.post(`${this.db.httpEndpoint()}/auth/forgot-password/confirm`, {
				token,
				newPassword,
			}),
		);
	}

	async changeEmail(currentPassword: string, newEmail: string): Promise<void> {
		await firstValueFrom(
			this.http.post(`${this.db.httpEndpoint()}/auth/change-email`, {
				currentPassword,
				newEmail,
			}),
		);
	}

	async confirmEmailChange(token: string): Promise<void> {
		await firstValueFrom(
			this.http.get(`${this.db.httpEndpoint()}/auth/confirm-email-change`, {
				params: { token },
			}),
		);
	}

	async changePassword(currentPassword: string, newPassword: string): Promise<void> {
		await firstValueFrom(
			this.http.post(`${this.db.httpEndpoint()}/auth/reset-password`, {
				currentPassword,
				newPassword,
			}),
		);
	}

	async confirmEmailVerification(token: string): Promise<void> {
		const res = await firstValueFrom(
			this.http.get<AuthResponse>(`${this.db.httpEndpoint()}/auth/verify-email`, {
				params: { token },
			}),
		);
		this.handleAuthResponse(res);
	}

	logout(): void {
		localStorage.removeItem(ACCESS_TOKEN_KEY);
		this._user.set(null);
		this.router.navigate(["/login"]);
	}

	getAccessToken(): string | null {
		return localStorage.getItem(ACCESS_TOKEN_KEY);
	}

	// ── Internal ──────────────────────────────────────────────────────────────

	private restoreSession(): void {
		const token = this.getAccessToken();
		if (!token) return;

		const payload = this.decodeToken(token);
		if (!payload) {
			localStorage.removeItem(ACCESS_TOKEN_KEY);
			return;
		}

		if (payload.exp * 1000 < Date.now()) {
			localStorage.removeItem(ACCESS_TOKEN_KEY);
			return;
		}

		this._user.set({ userId: payload.sub, username: payload.username, role: payload.role ?? 'user' });
	}

	handleAuthResponse(res: AuthResponse): void {
		localStorage.setItem(ACCESS_TOKEN_KEY, res.access_token);
		this._user.set({ userId: res.userId, username: res.username, role: res.role ?? 'user' });
	}

	private decodeToken(token: string): TokenPayload | null {
		try {
			const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
			return JSON.parse(atob(base64)) as TokenPayload;
		} catch {
			return null;
		}
	}
}