import { Injectable, ConflictException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { DatabaseService } from "../database/database.service";

export interface User {
	id: number;
	username: string;
	email: string;
	password_hash: string;
	email_verified: number;
	role: string;
	is_disabled: number;
	verification_token: string | null;
	verification_token_expires: string | null;
	magic_link_token: string | null;
	magic_link_token_expires: string | null;
	refresh_token_hash: string | null;
	refresh_token_expires: string | null;
	password_reset_token: string | null;
	password_reset_token_expires: string | null;
	pending_email: string | null;
	created_at: string;
}

@Injectable()
export class UsersService {
	private readonly db;

	constructor(databaseService: DatabaseService) {
		this.db = databaseService.db;
	}

	async create(
		username: string,
		email: string,
		password: string,
		role: string = 'user',
	): Promise<User> {
		const existing = this.db
			.prepare("SELECT id FROM user WHERE username = ? OR email = ?")
			.get(username, email);
		if (existing) throw new ConflictException("Username or email already in use");

		const passwordHash = await bcrypt.hash(password, 10);
		const verificationToken = this.generateToken();
		const verificationExpires = this.expiresAt(24 * 60); // 24 hours

		const result = this.db
			.prepare(
				`
      INSERT INTO user (username, email, password_hash, role, verification_token, verification_token_expires)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
			)
			.run(username, email, passwordHash, role, verificationToken, verificationExpires);

		return this.findById(result.lastInsertRowid as number)!;
	}

	findAll(): Pick<User, 'id' | 'username' | 'email' | 'role' | 'is_disabled' | 'email_verified' | 'created_at'>[] {
		return this.db
			.prepare('SELECT id, username, email, role, is_disabled, email_verified, created_at FROM user ORDER BY id ASC')
			.all() as any[];
	}

	async updateUser(
		id: number,
		dto: { username?: string; email?: string; role?: string; is_disabled?: number; password?: string },
	): Promise<void> {
		if (dto.password) {
			const hash = await bcrypt.hash(dto.password, 10);
			this.db.prepare('UPDATE user SET password_hash = ? WHERE id = ?').run(hash, id);
		}
		const fields: string[] = [];
		const values: any[] = [];
		if (dto.username !== undefined) { fields.push('username = ?'); values.push(dto.username); }
		if (dto.email !== undefined) { fields.push('email = ?'); values.push(dto.email); }
		if (dto.role !== undefined) { fields.push('role = ?'); values.push(dto.role); }
		if (dto.is_disabled !== undefined) { fields.push('is_disabled = ?'); values.push(dto.is_disabled); }
		if (fields.length > 0) {
			values.push(id);
			this.db.prepare(`UPDATE user SET ${fields.join(', ')} WHERE id = ?`).run(...values);
		}
	}

	deleteUser(id: number): void {
		this.db.prepare('DELETE FROM user WHERE id = ?').run(id);
	}

	getUserCount(): number {
		const row = this.db
			.prepare("SELECT COUNT(*) as count FROM user")
			.get() as { count: number };
		return row.count;
	}

	findByEmail(email: string): User | undefined {
		return this.db
			.prepare("SELECT * FROM user WHERE email = ?")
			.get(email) as User;
	}

	findByEmailOrUsername(identifier: string): User | undefined {
		return this.db
			.prepare("SELECT * FROM user WHERE email = ? OR username = ?")
			.get(identifier, identifier) as User;
	}

	findById(id: number): User | undefined {
		return this.db.prepare("SELECT * FROM user WHERE id = ?").get(id) as User;
	}

	findByVerificationToken(token: string): User | undefined {
		return this.db
			.prepare("SELECT * FROM user WHERE verification_token = ?")
			.get(token) as User;
	}

	findByMagicLinkToken(token: string): User | undefined {
		return this.db
			.prepare("SELECT * FROM user WHERE magic_link_token = ?")
			.get(token) as User;
	}

	verifyEmail(userId: number) {
		this.db
			.prepare(
				`
      UPDATE user
      SET email_verified = 1, verification_token = NULL, verification_token_expires = NULL
      WHERE id = ?
    `,
			)
			.run(userId);
	}

	setMagicLinkToken(userId: number): string {
		const token = this.generateToken();
		const expires = this.expiresAt(15); // 15 minutes
		this.db
			.prepare(
				`
      UPDATE user SET magic_link_token = ?, magic_link_token_expires = ? WHERE id = ?
    `,
			)
			.run(token, expires, userId);
		return token;
	}

	clearMagicLinkToken(userId: number) {
		this.db
			.prepare(
				`
      UPDATE user SET magic_link_token = NULL, magic_link_token_expires = NULL WHERE id = ?
    `,
			)
			.run(userId);
	}

	async updatePassword(userId: number, newPassword: string) {
		const hash = await bcrypt.hash(newPassword, 10);
		this.db
			.prepare("UPDATE user SET password_hash = ? WHERE id = ?")
			.run(hash, userId);
	}

	/** Generates a cryptographically random 32-byte hex token. */
	generateToken(): string {
		return crypto.randomBytes(32).toString("hex");
	}

	/** Returns an ISO datetime string N minutes from now. */
	private expiresAt(minutes: number): string {
		return new Date(Date.now() + minutes * 60 * 1000).toISOString();
	}

	refreshVerificationToken(userId: number): string {
		const token = this.generateToken();
		const expires = this.expiresAt(24 * 60);
		this.db
			.prepare(
				`
    UPDATE user SET verification_token = ?, verification_token_expires = ? WHERE id = ?
  `,
			)
			.run(token, expires, userId);
		return token;
	}

	async setRefreshToken(userId: number, token: string): Promise<string> {
		const hash = await bcrypt.hash(token, 10);
		const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
		this.db
			.prepare(
				`
    UPDATE user SET refresh_token_hash = ?, refresh_token_expires = ? WHERE id = ?
  `,
			)
			.run(hash, expires, userId);
		return hash;
	}

	findByPasswordResetToken(token: string): User | undefined {
		return this.db
			.prepare("SELECT * FROM user WHERE password_reset_token = ?")
			.get(token) as User;
	}

	setPasswordResetToken(userId: number): string {
		const token = this.generateToken();
		const expires = this.expiresAt(60); // 1 hour
		this.db
			.prepare(
				`UPDATE user SET password_reset_token = ?, password_reset_token_expires = ? WHERE id = ?`,
			)
			.run(token, expires, userId);
		return token;
	}

	clearPasswordResetToken(userId: number) {
		this.db
			.prepare(
				`UPDATE user SET password_reset_token = NULL, password_reset_token_expires = NULL WHERE id = ?`,
			)
			.run(userId);
	}

	getApiTokens(userId: number): { hfToken: string | null; civitaiToken: string | null } {
		const row = this.db
			.prepare("SELECT hf_token, civitai_token FROM user WHERE id = ?")
			.get(userId) as any;
		return { hfToken: row?.hf_token ?? null, civitaiToken: row?.civitai_token ?? null };
	}

	setApiTokens(userId: number, hfToken: string | null, civitaiToken: string | null) {
		this.db
			.prepare("UPDATE user SET hf_token = ?, civitai_token = ? WHERE id = ?")
			.run(hfToken ?? null, civitaiToken ?? null, userId);
	}

	clearRefreshToken(userId: number) {
		this.db
			.prepare(
				`
    UPDATE user SET refresh_token_hash = NULL, refresh_token_expires = NULL WHERE id = ?
  `,
			)
			.run(userId);
	}

	setPendingEmail(userId: number, newEmail: string): string {
		const token = this.generateToken();
		const expires = this.expiresAt(24 * 60); // 24 hours
		this.db
			.prepare(
				`UPDATE user SET pending_email = ?, verification_token = ?, verification_token_expires = ? WHERE id = ?`,
			)
			.run(newEmail, token, expires, userId);
		return token;
	}

	findByEmailChangeToken(token: string): User | undefined {
		return this.db
			.prepare(`SELECT * FROM user WHERE verification_token = ? AND pending_email IS NOT NULL`)
			.get(token) as User;
	}

	applyEmailChange(userId: number) {
		this.db
			.prepare(
				`UPDATE user SET email = pending_email, pending_email = NULL,
         verification_token = NULL, verification_token_expires = NULL WHERE id = ?`,
			)
			.run(userId);
	}
}
