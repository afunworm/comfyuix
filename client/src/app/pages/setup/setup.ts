import { Component, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { SetupService } from "../../auth/setup.service";

@Component({
	selector: "app-setup",
	standalone: true,
	imports: [FormsModule],
	templateUrl: "./setup.html",
	styleUrl: "./setup.scss",
})
export class Setup {
	username = "";
	email = "";
	password = "";
	confirmPassword = "";
	signupsEnabled = false;
	loading = false;
	error = "";

	private setupService = inject(SetupService);
	private router = inject(Router);

	async create() {
		if (!this.username || !this.email || !this.password) return;

		if (this.password !== this.confirmPassword) {
			this.error = "Passwords do not match.";
			return;
		}

		this.loading = true;
		this.error = "";

		try {
			await this.setupService.createFirstAccount(
				this.username,
				this.email,
				this.password,
				this.signupsEnabled,
			);
			this.router.navigateByUrl("/books");
		} catch (err: any) {
			this.error =
				err?.error?.message ?? "Could not create account. Please try again.";
		} finally {
			this.loading = false;
		}
	}
}
