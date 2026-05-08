import {
	Injectable,
	UnauthorizedException,
	BadRequestException,
	ForbiddenException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { UsersService } from "../users/users.service";
import { MailService } from "../mail/mail.service";
import { SettingsService } from "../settings/settings.service";

@Injectable()
export class AuthService {
	constructor(
		private usersService: UsersService,
		private jwtService: JwtService,
		private mailService: MailService,
		private settingsService: SettingsService,
	) {}

	async signup(username: string, email: string, password: string) {
		if (!this.settingsService.getSignupsEnabled()) {
			throw new ForbiddenException("Signups are currently disabled");
		}
		const user = await this.usersService.create(username, email, password);
		this.mailService
			.sendVerificationEmail(email, user.verification_token!)
			.catch(console.error);
		return {
			message: "Account created. Please check your email to verify your address.",
		};
	}

	async verifyEmail(token: string) {
		const user = this.usersService.findByVerificationToken(token);
		if (!user)
			throw new BadRequestException("Invalid or already used verification link");
		if (new Date(user.verification_token_expires!) < new Date()) {
			throw new BadRequestException(
				"Verification link has expired. Request a new one.",
			);
		}
		this.usersService.verifyEmail(user.id);
		return this.issueToken(user.id, user.username, user.role);
	}

	async resendVerification(email: string) {
		const user = this.usersService.findByEmail(email);
		if (!user || user.email_verified) {
			return {
				message:
					"If that email exists and is unverified, a new link has been sent.",
			};
		}
		const token = this.usersService.refreshVerificationToken(user.id);
		this.mailService.sendVerificationEmail(email, token).catch(console.error);
		return {
			message: "If that email exists and is unverified, a new link has been sent.",
		};
	}

	async login(identifier: string, password: string) {
		const user = this.usersService.findByEmailOrUsername(identifier);
		if (!user) throw new UnauthorizedException("Invalid credentials");
		const valid = await bcrypt.compare(password, user.password_hash);
		if (!valid) throw new UnauthorizedException("Invalid credentials");
		if (!user.email_verified) {
			throw new UnauthorizedException(
				"Please verify your email address before logging in",
			);
		}
		if (user.is_disabled) throw new UnauthorizedException("Account is disabled");
		return this.issueToken(user.id, user.username, user.role);
	}

	async requestMagicLink(email: string) {
		const user = this.usersService.findByEmail(email);
		if (!user || !user.email_verified) {
			return {
				message:
					"If that email belongs to a verified account, a sign-in link has been sent.",
			};
		}
		const token = this.usersService.setMagicLinkToken(user.id);
		this.mailService.sendMagicLinkEmail(email, token).catch(console.error);
		return {
			message:
				"If that email belongs to a verified account, a sign-in link has been sent.",
		};
	}

	async confirmMagicLink(token: string) {
		const user = this.usersService.findByMagicLinkToken(token);
		if (!user || !user.magic_link_token_expires) {
			throw new BadRequestException("Invalid or already used magic link");
		}
		if (new Date(user.magic_link_token_expires) < new Date()) {
			throw new BadRequestException("Magic link has expired. Request a new one.");
		}
		this.usersService.clearMagicLinkToken(user.id);
		return this.issueToken(user.id, user.username, user.role);
	}

	async requestPasswordReset(email: string) {
		const user = this.usersService.findByEmail(email);
		if (!user || !user.email_verified) {
			return {
				message:
					"If that email belongs to a verified account, a reset link has been sent.",
			};
		}
		const token = this.usersService.setPasswordResetToken(user.id);
		this.mailService.sendPasswordResetEmail(email, token).catch(console.error);
		return {
			message: "If that email belongs to a verified account, a reset link has been sent.",
		};
	}

	async confirmPasswordReset(token: string, newPassword: string) {
		const user = this.usersService.findByPasswordResetToken(token);
		if (!user || !user.password_reset_token_expires) {
			throw new BadRequestException("Invalid or already used reset link");
		}
		if (new Date(user.password_reset_token_expires) < new Date()) {
			throw new BadRequestException("Reset link has expired. Please request a new one.");
		}
		await this.usersService.updatePassword(user.id, newPassword);
		this.usersService.clearPasswordResetToken(user.id);
		return { message: "Password updated successfully." };
	}

	async resetPassword(
		userId: number,
		currentPassword: string,
		newPassword: string,
	) {
		const user = this.usersService.findById(userId);
		if (!user) throw new UnauthorizedException();
		const valid = await bcrypt.compare(currentPassword, user.password_hash);
		if (!valid) throw new BadRequestException("Current password is incorrect");
		await this.usersService.updatePassword(userId, newPassword);
		return { message: "Password updated" };
	}

	async changeEmail(userId: number, currentPassword: string, newEmail: string) {
		const user = this.usersService.findById(userId);
		if (!user) throw new UnauthorizedException();
		const valid = await bcrypt.compare(currentPassword, user.password_hash);
		if (!valid) throw new BadRequestException('Current password is incorrect');
		const existing = this.usersService.findByEmail(newEmail);
		if (existing) throw new BadRequestException('That email address is already in use');
		const token = this.usersService.setPendingEmail(userId, newEmail);
		this.mailService
			.sendEmailChangeVerificationEmail(newEmail, token)
			.catch(console.error);
		return { message: 'A verification link has been sent to your new email address.' };
	}

	async confirmEmailChange(token: string) {
		const user = this.usersService.findByEmailChangeToken(token);
		if (!user || !user.verification_token_expires) {
			throw new BadRequestException('Invalid or already used confirmation link');
		}
		if (new Date(user.verification_token_expires) < new Date()) {
			throw new BadRequestException('Confirmation link has expired. Please request a new one.');
		}
		this.usersService.applyEmailChange(user.id);
		return { message: 'Email address updated successfully.' };
	}

	async initSetup(username: string, email: string, password: string) {
		const user = await this.usersService.create(username, email, password, 'admin');
		this.usersService.verifyEmail(user.id);
		return this.issueToken(user.id, user.username, user.role);
	}

	private issueToken(userId: number, username: string, role: string = 'user') {
		const token = this.jwtService.sign({ sub: userId, username, role });
		return { access_token: token, userId, username, role };
	}
}
