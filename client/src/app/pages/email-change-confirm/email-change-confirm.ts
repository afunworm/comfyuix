import { Component, inject, Input, OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { AuthService } from "../../auth/auth.service";

@Component({
	selector: "app-email-change-confirm",
	standalone: true,
	templateUrl: "./email-change-confirm.html",
	styleUrl: "./email-change-confirm.scss",
})
export class EmailChangeConfirm implements OnInit {
	@Input() token = "";
	loading = true;
	error = "";
	done = false;

	private router = inject(Router);
	private authService = inject(AuthService);

	async ngOnInit() {
		if (!this.token) {
			this.error = "Invalid link — no token found.";
			this.loading = false;
			return;
		}
		try {
			await this.authService.confirmEmailChange(this.token);
			this.done = true;
		} catch (err: any) {
			this.error =
				err?.error?.message ??
				"This link is invalid or has expired. Please request a new one.";
		} finally {
			this.loading = false;
		}
	}

	goToAccount() {
		this.router.navigateByUrl("/account");
	}
}
