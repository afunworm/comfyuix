import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AdminGuard } from "../auth/admin.guard";
import { SettingsService } from "./settings.service";

@Controller("settings")
export class SettingsController {
	constructor(private settings: SettingsService) {}

	@Get("signups-enabled")
	getSignupsEnabled() {
		return { enabled: this.settings.getSignupsEnabled() };
	}

	@UseGuards(JwtAuthGuard, AdminGuard)
	@Patch()
	updateSettings(@Body() body: { signupsEnabled?: boolean }) {
		if (body.signupsEnabled !== undefined) {
			this.settings.set("signups_enabled", body.signupsEnabled ? "1" : "0");
		}
		return { signupsEnabled: this.settings.getSignupsEnabled() };
	}
}
