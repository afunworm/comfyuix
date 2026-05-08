import { Component, inject, OnInit } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { AuthService } from "../../auth/auth.service";
import { HeaderComponent } from "../../header/header.component";
import { FooterComponent } from "../../footer/footer.component";
import { ComfyUIDatabaseService } from "../../comfyui/comfyui-database.service";

@Component({
	selector: "app-account",
	standalone: true,
	imports: [FormsModule, HeaderComponent, FooterComponent],
	templateUrl: "./account.html",
	styleUrl: "./account.scss",
})
export class AccountPage implements OnInit {
	private authService = inject(AuthService);
	private router = inject(Router);
	private db = inject(ComfyUIDatabaseService);

	readonly user = this.authService.user;

	// Change password
	currentPasswordForPw = "";
	newPassword = "";
	confirmPassword = "";
	pwLoading = false;
	pwError = "";
	pwSuccess = "";

	// Change email
	currentPasswordForEmail = "";
	newEmail = "";
	emailLoading = false;
	emailError = "";
	emailSuccess = "";

	async submitPasswordChange() {
		this.pwError = "";
		this.pwSuccess = "";
		if (!this.currentPasswordForPw || !this.newPassword || !this.confirmPassword)
			return;
		if (this.newPassword !== this.confirmPassword) {
			this.pwError = "New passwords do not match.";
			return;
		}
		this.pwLoading = true;
		try {
			await this.authService.changePassword(
				this.currentPasswordForPw,
				this.newPassword,
			);
			this.pwSuccess = "Password updated successfully.";
			this.currentPasswordForPw = "";
			this.newPassword = "";
			this.confirmPassword = "";
		} catch (err: any) {
			this.pwError = err?.error?.message ?? "An error occurred. Please try again.";
		} finally {
			this.pwLoading = false;
		}
	}

	async submitEmailChange() {
		this.emailError = "";
		this.emailSuccess = "";
		if (!this.currentPasswordForEmail || !this.newEmail) return;
		this.emailLoading = true;
		try {
			await this.authService.changeEmail(
				this.currentPasswordForEmail,
				this.newEmail,
			);
			this.emailSuccess = `A verification link has been sent to ${this.newEmail}. Click it to confirm the change.`;
			this.currentPasswordForEmail = "";
			this.newEmail = "";
		} catch (err: any) {
			this.emailError =
				err?.error?.message ?? "An error occurred. Please try again.";
		} finally {
			this.emailLoading = false;
		}
	}

	// API tokens
	hfToken = "";
	civitaiToken = "";
	tokensLoading = false;
	tokensSaving = false;
	tokensError = "";
	tokensSuccess = "";

	ngOnInit() {
		this.tokensLoading = true;
		this.db.getApiTokens().subscribe({
			next: (t) => {
				this.hfToken = t.hfToken ?? "";
				this.civitaiToken = t.civitaiToken ?? "";
				this.tokensLoading = false;
			},
			error: () => { this.tokensLoading = false; },
		});
	}

	async saveApiTokens() {
		this.tokensError = "";
		this.tokensSuccess = "";
		this.tokensSaving = true;
		this.db.setApiTokens({
			hfToken: this.hfToken || null,
			civitaiToken: this.civitaiToken || null,
		}).subscribe({
			next: () => {
				this.tokensSuccess = "API tokens saved.";
				this.tokensSaving = false;
			},
			error: () => {
				this.tokensError = "Failed to save tokens.";
				this.tokensSaving = false;
			},
		});
	}

	goBack() {
		this.router.navigateByUrl("/books");
	}
}
