import { Injectable, InternalServerErrorException, OnModuleInit } from "@nestjs/common";
import * as nodemailer from "nodemailer";

@Injectable()
export class MailService implements OnModuleInit {
	private transporter: nodemailer.Transporter;

	constructor() {
		const port = Number(process.env.SMTP_PORT ?? 587);
		const secureEnv = process.env.SMTP_SECURE;
		const secure = secureEnv !== undefined ? secureEnv === "true" : port === 465;

		this.transporter = nodemailer.createTransport({
			host: process.env.SMTP_HOST,
			port,
			secure,
			auth: {
				user: process.env.SMTP_USER,
				pass: process.env.SMTP_PASS,
			},
		});
	}

	onModuleInit() {
		const required = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "APP_URL"];
		const missing = required.filter((k) => !process.env[k]);
		if (missing.length) {
			console.warn(`[mail] Missing environment variables: ${missing.join(", ")}. Emails will not be sent.`);
		}
	}

	private get from() {
		return process.env.SMTP_FROM ?? "noreply@example.com";
	}

	private get appUrl() {
		return process.env.APP_URL ?? "http://localhost:4200";
	}

	async sendVerificationEmail(to: string, token: string) {
		const link = `${this.appUrl}/auth/verify-email?token=${token}`;
		await this.send(to, "Verify your email", `
      <p>Thanks for signing up. Click the link below to verify your email address.</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 24 hours.</p>
      <p>If you didn't create an account, you can ignore this email.</p>
    `);
	}

	async sendMagicLinkEmail(to: string, token: string) {
		const link = `${this.appUrl}/auth/magic-link/confirm?token=${token}`;
		await this.send(to, "Your sign-in link", `
      <p>Click the link below to sign in. No password needed.</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 15 minutes and can only be used once.</p>
      <p>If you didn't request this, you can ignore this email.</p>
    `);
	}

	async sendEmailChangeVerificationEmail(to: string, token: string) {
		const link = `${this.appUrl}/auth/confirm-email-change?token=${token}`;
		await this.send(to, 'Confirm your new email address', `
      <p>You requested an email address change. Click the link below to confirm your new address.</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 24 hours and can only be used once.</p>
      <p>If you didn't request this, you can ignore this email — your address won't change.</p>
    `);
	}

	async sendPasswordResetEmail(to: string, token: string) {
		const link = `${this.appUrl}/auth/reset-password?token=${token}`;
		await this.send(to, "Reset your password", `
      <p>You requested a password reset. Click the link below to choose a new password.</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 1 hour and can only be used once.</p>
      <p>If you didn't request this, you can ignore this email.</p>
    `);
	}

	private async send(to: string, subject: string, html: string) {
		try {
			await this.transporter.sendMail({ from: this.from, to, subject, html });
		} catch (err) {
			console.error("[mail] Send failed:", err);
			throw new InternalServerErrorException("Failed to send email");
		}
	}
}
