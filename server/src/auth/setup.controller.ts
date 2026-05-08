import { Body, Controller, ForbiddenException, Get, Post } from "@nestjs/common";
import { UsersService } from "../users/users.service";
import { AuthService } from "./auth.service";
import { SettingsService } from "../settings/settings.service";

@Controller("setup")
export class SetupController {
	constructor(
		private usersService: UsersService,
		private authService: AuthService,
		private settingsService: SettingsService,
	) {}

	@Get("status")
	status() {
		return { needsSetup: this.usersService.getUserCount() === 0 };
	}

	@Post("init")
	async init(
		@Body()
		body: {
			username: string;
			email: string;
			password: string;
			signupsEnabled?: boolean;
		},
	) {
		if (this.usersService.getUserCount() > 0) {
			throw new ForbiddenException("Setup has already been completed");
		}
		const result = await this.authService.initSetup(body.username, body.email, body.password);
		this.settingsService.set("signups_enabled", body.signupsEnabled ? "1" : "0");
		return result;
	}
}
