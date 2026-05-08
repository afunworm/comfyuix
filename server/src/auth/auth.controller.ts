import {
	Controller,
	Post,
	Get,
	Body,
	Query,
	UseGuards,
	Request,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";

@Controller("auth")
export class AuthController {
	constructor(private authService: AuthService) {}

	@Post("signup")
	signup(@Body() body: { username: string; email: string; password: string }) {
		return this.authService.signup(body.username, body.email, body.password);
	}

	@Get("verify-email")
	verifyEmail(@Query("token") token: string) {
		return this.authService.verifyEmail(token);
	}

	@Post("resend-verification")
	resendVerification(@Body() body: { email: string }) {
		return this.authService.resendVerification(body.email);
	}

	@Throttle({ default: { ttl: 60000, limit: 10 } })
	@Post("login")
	login(@Body() body: { identifier: string; password: string }) {
		return this.authService.login(body.identifier, body.password);
	}

	@Throttle({ default: { ttl: 60000, limit: 10 } })
	@Post("magic-link")
	requestMagicLink(@Body() body: { email: string }) {
		return this.authService.requestMagicLink(body.email);
	}

	@Get("magic-link/confirm")
	confirmMagicLink(@Query("token") token: string) {
		return this.authService.confirmMagicLink(token);
	}

	@Throttle({ default: { ttl: 60000, limit: 10 } })
	@Post("forgot-password")
	requestPasswordReset(@Body() body: { email: string }) {
		return this.authService.requestPasswordReset(body.email);
	}

	@Post("forgot-password/confirm")
	confirmPasswordReset(@Body() body: { token: string; newPassword: string }) {
		return this.authService.confirmPasswordReset(body.token, body.newPassword);
	}

	@UseGuards(JwtAuthGuard)
	@Get("me")
	me(@Request() req) {
		return req.user;
	}

	@UseGuards(JwtAuthGuard)
	@Post("reset-password")
	resetPassword(
		@Request() req,
		@Body() body: { currentPassword: string; newPassword: string },
	) {
		return this.authService.resetPassword(
			req.user.id,
			body.currentPassword,
			body.newPassword,
		);
	}

	@UseGuards(JwtAuthGuard)
	@Post("change-email")
	changeEmail(
		@Request() req,
		@Body() body: { currentPassword: string; newEmail: string },
	) {
		return this.authService.changeEmail(req.user.id, body.currentPassword, body.newEmail);
	}

	@Get("confirm-email-change")
	confirmEmailChange(@Query("token") token: string) {
		return this.authService.confirmEmailChange(token);
	}
}
