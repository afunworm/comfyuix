import { Component, inject, Input, OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { AuthService } from "../../auth/auth.service";

@Component({
	selector: "app-magic-link-confirm",
	standalone: true,
	templateUrl: "./magic-link-confirm.html",
	styleUrl: "./magic-link-confirm.scss",
})
export class MagicLinkConfirm implements OnInit {
	@Input() token = "";
	error = "";

	private router = inject(Router);
	private authService = inject(AuthService);

	async ngOnInit() {
		if (!this.token) {
			this.error = "Invalid magic link — no token found.";
			return;
		}

		try {
			await this.authService.confirmMagicLink(this.token);
			this.router.navigateByUrl("/books");
		} catch {
			this.error =
				"This link is invalid or has expired. Please request a new one.";
		}
	}
}
