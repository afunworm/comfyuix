import { Component, inject, signal, OnInit } from "@angular/core";
import { CommonModule } from "@angular/common";
import { Router } from "@angular/router";
import { AuthService } from "../../auth/auth.service";
import {
	ComfyUIDatabaseService,
	AdminUser,
} from "../../comfyui/comfyui-database.service";
import { Dialog } from "../../dialog";
import { HeaderComponent } from "../../header/header.component";
import { FooterComponent } from "../../footer/footer.component";

@Component({
	selector: "app-admin",
	imports: [CommonModule, HeaderComponent, FooterComponent],
	templateUrl: "./admin.html",
	styleUrl: "./admin.scss",
})
export class AdminPage implements OnInit {
	private auth = inject(AuthService);
	private db = inject(ComfyUIDatabaseService);
	private dialog = inject(Dialog);
	private router = inject(Router);

	users = signal<AdminUser[]>([]);
	loading = signal(false);
	signupsEnabled = signal(true);
	settingsLoading = signal(false);

	showCreateForm = signal(false);
	createDraft = signal<{
		username: string;
		email: string;
		password: string;
		role: string;
	}>({
		username: "",
		email: "",
		password: "",
		role: "user",
	});

	editingUserId = signal<number | null>(null);
	editDraft = signal<Partial<AdminUser & { password: string }>>({});

	ngOnInit() {
		this.loadUsers();
		this.loadSettings();
	}

	loadSettings() {
		this.db.getSignupsEnabled().subscribe({
			next: (res) => this.signupsEnabled.set(res.enabled),
			error: () => {},
		});
	}

	toggleSignups() {
		const next = !this.signupsEnabled();
		this.settingsLoading.set(true);
		this.db.updateSettings({ signupsEnabled: next }).subscribe({
			next: (res) => {
				this.signupsEnabled.set(res.signupsEnabled);
				this.settingsLoading.set(false);
			},
			error: (err: any) => {
				this.dialog.alert('Failed to update settings: ' + (err?.error?.message ?? 'Unknown error'));
				this.settingsLoading.set(false);
			},
		});
	}

	loadUsers() {
		this.loading.set(true);
		this.db.getUsers().subscribe({
			next: (users) => {
				this.users.set(users);
				this.loading.set(false);
			},
			error: (err: any) => {
				console.error("Error loading users:", err);
				this.dialog.alert("Failed to load users.");
				this.loading.set(false);
			},
		});
	}

	isSelf(user: AdminUser): boolean {
		return this.auth.user()?.userId === user.id;
	}

	// ── Create ──────────────────────────────────────────────────────────────────

	openCreateForm() {
		this.createDraft.set({ username: "", email: "", password: "", role: "user" });
		this.showCreateForm.set(true);
	}

	closeCreateForm() {
		this.showCreateForm.set(false);
	}

	patchCreate(
		changes: Partial<{
			username: string;
			email: string;
			password: string;
			role: string;
		}>,
	) {
		this.createDraft.update((d) => ({ ...d, ...changes }));
	}

	submitCreate() {
		const d = this.createDraft();
		if (!d.username.trim() || !d.email.trim() || !d.password.trim()) {
			this.dialog.alert("Username, email and password are required.");
			return;
		}
		this.db
			.createUser({
				username: d.username.trim(),
				email: d.email.trim(),
				password: d.password.trim(),
				role: d.role,
			})
			.subscribe({
				next: () => {
					this.showCreateForm.set(false);
					this.loadUsers();
				},
				error: (err: any) => {
					console.error("Error creating user:", err);
					this.dialog.alert(
						"Failed to create user: " +
							(err?.error?.message ?? err?.message ?? "Unknown error"),
					);
				},
			});
	}

	// ── Edit ────────────────────────────────────────────────────────────────────

	startEdit(user: AdminUser) {
		this.editingUserId.set(user.id);
		this.editDraft.set({
			username: user.username,
			email: user.email,
			role: user.role,
			password: "",
		});
	}

	cancelEdit() {
		this.editingUserId.set(null);
		this.editDraft.set({});
	}

	patchDraft(changes: Partial<AdminUser & { password: string }>) {
		this.editDraft.update((d) => ({ ...d, ...changes }));
	}

	saveEdit(user: AdminUser) {
		const draft = this.editDraft();
		const payload: any = {};
		if (draft.username?.trim()) payload.username = draft.username.trim();
		if (draft.email?.trim()) payload.email = draft.email.trim();
		if (draft.role) payload.role = draft.role;
		if (draft.password?.trim()) payload.password = draft.password.trim();

		this.db.updateUser(user.id, payload).subscribe({
			next: () => {
				this.cancelEdit();
				this.loadUsers();
			},
			error: (err: any) => {
				console.error("Error updating user:", err);
				this.dialog.alert("Failed to update user.");
			},
		});
	}

	// ── Toggle disabled ──────────────────────────────────────────────────────────

	toggleDisabled(user: AdminUser) {
		this.db
			.updateUser(user.id, { is_disabled: user.is_disabled ? 0 : 1 })
			.subscribe({
				next: () => this.loadUsers(),
				error: (err: any) => {
					console.error("Error toggling user:", err);
					this.dialog.alert("Failed to update user status.");
				},
			});
	}

	// ── Delete ──────────────────────────────────────────────────────────────────

	async deleteUser(user: AdminUser) {
		const confirmed = await this.dialog.confirm(
			`Delete user "${user.username}"? This cannot be undone.`,
		);
		if (!confirmed) return;
		this.db.deleteAdminUser(user.id).subscribe({
			next: () => {
				this.dialog.alert("User deleted.");
				this.loadUsers();
			},
			error: (err: any) => {
				console.error("Error deleting user:", err);
				this.dialog.alert("Failed to delete user.");
			},
		});
	}

	// ── Navigation ───────────────────────────────────────────────────────────────

	goToBooks() {
		this.router.navigate(["/books"]);
	}
}
