import { Component, inject, Input, OnInit, signal } from "@angular/core";
import { Router } from "@angular/router";
import { FormsModule } from "@angular/forms";
import { AuthService } from "../../auth/auth.service";

@Component({
	selector: "app-password-reset",
	standalone: true,
	imports: [FormsModule],
	templateUrl: "./password-reset.html",
	styleUrl: "./password-reset.scss",
})
export class PasswordReset implements OnInit {
	@Input() token = "";
	newPassword = "";
	confirmPassword = "";
	loading = false;
	error = "";
	done = false;

	private router = inject(Router);
	private authService = inject(AuthService);

	ngOnInit() {
		if (!this.token) {
			this.error = "Invalid reset link — no token found.";
		}
	}

	async submit() {
		if (!this.newPassword || !this.confirmPassword) return;

		if (this.newPassword !== this.confirmPassword) {
			this.error = "Passwords do not match.";
			return;
		}

		this.loading = true;
		this.error = "";

		try {
			await this.authService.resetPasswordWithToken(this.token, this.newPassword);
			this.done = true;
		} catch (err: any) {
			this.error =
				err?.error?.message ??
				"This link is invalid or has expired. Please request a new one.";
		} finally {
			this.loading = false;
		}
	}

	goToLogin() {
		this.router.navigateByUrl("/login");
	}
}
