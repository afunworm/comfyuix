import { Component, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { FormsModule } from "@angular/forms";
import { AuthService } from "../../auth/auth.service";
import { SetupService } from "../../auth/setup.service";
import { ComfyUIDatabaseService } from "../../comfyui/comfyui-database.service";

@Component({
	selector: "app-login",
	standalone: true,
	imports: [FormsModule],
	templateUrl: "./login.html",
	styleUrl: "./login.scss",
})
export class LoginComponent {
	mode: "password" | "code" | "signup" | "forgot" = "password";
	loading = false;
	error = "";

	// Password fields
	username = "";
	password = "";

	// Email/magic-link fields (shared by "code" and "forgot" modes)
	email = "";
	codeSent = false;

	// Signup fields
	signupUsername = "";
	signupEmail = "";
	signupPassword = "";
	signupConfirmPassword = "";
	signupDone = false;

	signupsEnabled = signal(true);

	private router = inject(Router);
	private authService = inject(AuthService);
	private setupService = inject(SetupService);
	private db = inject(ComfyUIDatabaseService);

	constructor() {
		if (this.setupService.needsSetup()) {
			this.router.navigateByUrl("/setup");
		} else if (this.authService.isLoggedIn()) {
			this.router.navigateByUrl("/books");
		} else {
			this.db.getSignupsEnabled().subscribe({
				next: (res) => {
					this.signupsEnabled.set(res.enabled);
					if (!res.enabled && this.mode === "signup") {
						this.mode = "password";
					}
				},
				error: () => {},
			});
		}
	}

	switchMode(mode: "password" | "code" | "signup" | "forgot") {
		this.mode = mode;
		this.error = "";
		this.codeSent = false;
		this.signupDone = false;
	}

	async loginWithPassword() {
		if (!this.username || !this.password) return;

		this.loading = true;
		this.error = "";

		try {
			await this.authService.login(this.username, this.password);
			this.router.navigateByUrl("/books");
		} catch {
			this.error = "Invalid username or password.";
		} finally {
			this.loading = false;
		}
	}

	async sendMagicLink() {
		if (!this.email) return;

		this.loading = true;
		this.error = "";

		try {
			await this.authService.sendMagicLink(this.email);
			this.codeSent = true;
		} catch {
			this.error = "Could not send link. Check your email and try again.";
		} finally {
			this.loading = false;
		}
	}

	async sendPasswordReset() {
		if (!this.email) return;

		this.loading = true;
		this.error = "";

		try {
			await this.authService.requestPasswordReset(this.email);
			this.codeSent = true;
		} catch {
			this.error = "Could not send reset link. Try again later.";
		} finally {
			this.loading = false;
		}
	}

	async signup() {
		if (!this.signupUsername || !this.signupEmail || !this.signupPassword) return;

		if (this.signupPassword !== this.signupConfirmPassword) {
			this.error = "Passwords do not match.";
			return;
		}

		this.loading = true;
		this.error = "";

		try {
			await this.authService.signup(
				this.signupUsername,
				this.signupEmail,
				this.signupPassword,
			);
			this.signupDone = true;
		} catch (err: any) {
			this.error =
				err?.error?.message ??
				"Could not create account. The username or email may already be in use.";
		} finally {
			this.loading = false;
		}
	}
}
