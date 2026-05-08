import { Controller, Get, Patch, Body, Request, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { UsersService } from "./users.service";

@Controller("account")
@UseGuards(JwtAuthGuard)
export class AccountController {
	constructor(private readonly usersService: UsersService) {}

	@Get("api-tokens")
	getApiTokens(@Request() req) {
		return this.usersService.getApiTokens(req.user.id);
	}

	@Patch("api-tokens")
	setApiTokens(
		@Request() req,
		@Body() body: { hfToken?: string | null; civitaiToken?: string | null },
	) {
		const current = this.usersService.getApiTokens(req.user.id);
		const hfToken = body.hfToken !== undefined ? (body.hfToken || null) : current.hfToken;
		const civitaiToken = body.civitaiToken !== undefined ? (body.civitaiToken || null) : current.civitaiToken;
		this.usersService.setApiTokens(req.user.id, hfToken, civitaiToken);
		return this.usersService.getApiTokens(req.user.id);
	}
}
