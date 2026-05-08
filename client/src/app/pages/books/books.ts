import {
	Component,
	computed,
	inject,
	signal,
	WritableSignal,
	OnInit,
} from "@angular/core";
import { Dialog } from "../../dialog";
import { CommonModule } from "@angular/common";
import { AuthService } from "../../auth/auth.service";
import { FlowConfig } from "../../types/flow.type";
import { Router } from "@angular/router";
import { ComfyUIDatabaseService, ComfyServer } from "../../comfyui/comfyui-database.service";
import { ActiveBookService } from "../../active-book.service";
import { forkJoin, lastValueFrom } from "rxjs";
import { map } from "rxjs/operators";
import { HeaderComponent } from "../../header/header.component";
import { FooterComponent } from "../../footer/footer.component";

export type BookFlow = {
	id: string;
	name: string;
	description?: string;
};

export type Book = {
	id: string;
	name: string;
	description: string;
	isPublic: boolean;
	bookPassword: string;
	server_id: string | null;
	server_name: string | null;
	flows?: BookFlow[];
};

@Component({
	selector: "app-books",
	imports: [CommonModule, HeaderComponent, FooterComponent],
	templateUrl: "./books.html",
	styleUrl: "./books.scss",
})
export class Books implements OnInit {
	private dialog = inject(Dialog);
	readonly authService = inject(AuthService);
	private db = inject(ComfyUIDatabaseService);
	private router = inject(Router);
	private activeBookService = inject(ActiveBookService);

	books: WritableSignal<Book[]> = signal([]);
	loading = signal(false);
	servers = signal<ComfyServer[]>([]);

	// ---------------------------------------------------------------------------
	// Inline edit state
	// ---------------------------------------------------------------------------

	editingBookId = signal<string | null>(null);
	editDraft = signal<Partial<Book>>({});

	startEdit(book: Book) {
		this.editingBookId.set(book.id);
		this.editDraft.set({
			name: book.name,
			description: book.description,
			isPublic: book.isPublic,
			bookPassword: book.bookPassword,
			server_id: book.server_id,
		});
	}

	cancelEdit() {
		this.editingBookId.set(null);
		this.editDraft.set({});
	}

	patchDraft(changes: Partial<Book>) {
		this.editDraft.update((d) => ({ ...d, ...changes }));
	}

	async saveEdit(book: Book) {
		const draft = this.editDraft();
		if (!draft.name?.trim()) {
			this.dialog.alert("Name cannot be empty.");
			return;
		}

		this.db
			.updateBook(book.id, {
				name: draft.name.trim(),
				description: draft.description ?? "",
				isPublic: draft.isPublic ?? false,
				bookPassword: draft.bookPassword ?? "",
				serverId: draft.server_id ?? null,
			})
			.subscribe({
				next: () => {
					this.cancelEdit();
					this.loadBooks();
				},
				error: () => this.dialog.alert("An error occurred while updating the book."),
			});
	}

	// ---------------------------------------------------------------------------
	// Import panel state
	// ---------------------------------------------------------------------------

	importTargetBookId = signal<string | null>(null);
	importSourceBookId = signal<string | null>(null);
	importLoading = signal(false);
	importedFlows = signal<Record<string, FlowConfig>>({});
	importingFlowId = signal<string | null>(null);

	importSourceBooks = computed(() => {
		const targetId = this.importTargetBookId();
		return this.books().filter((b) => b.id !== targetId);
	});

	importSourceFlows = computed(() => {
		const sourceId = this.importSourceBookId();
		if (!sourceId) return [];
		return this.books().find((b) => b.id === sourceId)?.flows ?? [];
	});

	ngOnInit(): void {
		if (!this.authService.isLoggedIn()) {
			this.router.navigate(["/login"]);
			return;
		}
		this.loadBooks();
		this.db.getServers().subscribe({ next: (s) => this.servers.set(s), error: () => {} });
	}

	loadBooks() {
		this.loading.set(true);
		this.db.getSelfBooks().subscribe({
			next: (books: Book[]) => {
				if (books.length === 0) {
					this.books.set([]);
					this.loading.set(false);
					return;
				}

				const flowRequests = books.map((book) =>
					this.db
						.getFlows(book.id)
						.pipe(
							map((flows) =>
								flows
									.filter((f): f is typeof f & { id: string } => !!f.id)
									.map((f) => ({ id: f.id, name: f.name, description: f.description })),
							),
						),
				);

				forkJoin(flowRequests).subscribe({
					next: (allFlows) => {
						const merged = books.map((book, i) => ({ ...book, flows: allFlows[i] }));
						this.books.set(merged);
						if (this.expandedFlowBookId() === null && merged.length > 0) {
							this.expandedFlowBookId.set(merged[0].id);
						}
						this.loading.set(false);
					},
					error: () => {
						this.books.set(books);
						this.loading.set(false);
					},
				});
			},
			error: () => {
				this.dialog.alert("An error occurred while loading your books.");
				this.loading.set(false);
			},
		});
	}

	// ---------------------------------------------------------------------------
	// Create book
	// ---------------------------------------------------------------------------

	async createBook() {
		const name = await this.dialog.prompt("Book name:");
		if (!name?.trim()) return;

		this.db
			.createBook({ name: name.trim() })
			.subscribe({
				next: () => {
					this.dialog.alert("Book created successfully!");
					this.loadBooks();
				},
				error: () => this.dialog.alert("An error occurred while creating the book."),
			});
	}

	// ---------------------------------------------------------------------------
	// Clone / Delete book
	// ---------------------------------------------------------------------------

	async cloneBook(book: Book) {
		const confirm = await this.dialog.confirm(
			`Clone "${book.name}"? This will copy the book and all its flows.`,
		);
		if (!confirm) return;

		this.db.cloneBook(book.id).subscribe({
			next: () => {
				this.dialog.alert("Book cloned successfully!");
				this.loadBooks();
			},
			error: () => this.dialog.alert("An error occurred while cloning the book."),
		});
	}

	async deleteBook(book: Book) {
		const confirm = await this.dialog.confirm(
			`Delete "${book.name}"? This cannot be undone.`,
		);
		if (!confirm) return;

		this.db.deleteBook(book.id).subscribe({
			next: () => {
				this.dialog.alert("Book deleted.");
				this.loadBooks();
			},
			error: () => this.dialog.alert("An error occurred while deleting the book."),
		});
	}

	// ---------------------------------------------------------------------------
	// Navigate
	// ---------------------------------------------------------------------------

	expandedFlowBookId = signal<string | null>(null);

	toggleFlowsExpanded(bookId: string) {
		this.expandedFlowBookId.update((c) => (c === bookId ? null : bookId));
	}

	isFlowsExpanded(bookId: string): boolean {
		return this.expandedFlowBookId() === bookId;
	}

	openBook(book: Book) {
		this.activeBookService.set({ id: book.id, name: book.name });
		this.router.navigate([`/books/${book.id}`]);
	}

	newFlow(book: Book) {
		this.router.navigate([`/bookmaker/${book.id}/flowimport`]);
	}

	editFlow(book: Book, flowId: string) {
		this.router.navigate([`/bookmaker/${book.id}/flowimport/${flowId}`]);
	}

	async cloneFlow(book: Book, flow: BookFlow) {
		const confirm = await this.dialog.confirm(`Clone flow "${flow.name}" within "${book.name}"?`);
		if (!confirm) return;

		this.db.getFlow(book.id, flow.id).subscribe({
			next: (fullFlow) => {
				const cloned = { ...fullFlow, id: "", name: `${fullFlow.name} (copy)` };
				this.db.createFlow(book.id, cloned).subscribe({
					next: () => {
						this.dialog.alert("Flow cloned successfully!");
						this.loadBooks();
					},
					error: () => this.dialog.alert("An error occurred while cloning the flow."),
				});
			},
			error: () => this.dialog.alert("An error occurred while fetching the flow."),
		});
	}

	async deleteFlow(book: Book, flow: BookFlow) {
		const confirm = await this.dialog.confirm(`Delete flow "${flow.name}"? This cannot be undone.`);
		if (!confirm) return;

		this.db.deleteFlow(book.id, flow.id).subscribe({
			next: () => {
				this.dialog.alert("Flow deleted.");
				this.loadBooks();
			},
			error: () => this.dialog.alert("An error occurred while deleting the flow."),
		});
	}

	// ---------------------------------------------------------------------------
	// Import flows from another book
	// ---------------------------------------------------------------------------

	toggleImportPanel(targetBookId: string) {
		if (this.importTargetBookId() === targetBookId) {
			this.importTargetBookId.set(null);
			this.importSourceBookId.set(null);
			this.importedFlows.set({});
		} else {
			this.importTargetBookId.set(targetBookId);
			this.importSourceBookId.set(null);
			this.importedFlows.set({});
		}
	}

	selectSourceBook(sourceBookId: string) {
		this.importSourceBookId.set(sourceBookId);
		this.importedFlows.set({});
	}

	async importFlow(sourceFlow: BookFlow) {
		const sourceBookId = this.importSourceBookId();
		const targetBookId = this.importTargetBookId();
		if (!sourceBookId || !targetBookId) return;

		const targetBook = this.books().find((b) => b.id === targetBookId);
		const confirm = await this.dialog.confirm(
			`Import "${sourceFlow.name}" into "${targetBook?.name}"?`,
		);
		if (!confirm) return;

		this.importingFlowId.set(sourceFlow.id);

		this.db.getFlow(sourceBookId, sourceFlow.id).subscribe({
			next: (flow: FlowConfig) => {
				const cloned: FlowConfig = { ...flow, id: "", name: `${flow.name} (imported)` };
				this.db.createFlow(targetBookId, cloned).subscribe({
					next: () => {
						this.dialog.alert(`"${flow.name}" imported successfully!`);
						this.importingFlowId.set(null);
						this.loadBooks();
					},
					error: () => {
						this.dialog.alert("An error occurred while importing the flow.");
						this.importingFlowId.set(null);
					},
				});
			},
			error: () => {
				this.dialog.alert("An error occurred while fetching the flow data.");
				this.importingFlowId.set(null);
			},
		});
	}

	// ---------------------------------------------------------------------------
	// Export / Import book
	// ---------------------------------------------------------------------------

	exportingBookId = signal<string | null>(null);

	exportBook(book: Book) {
		this.exportingBookId.set(book.id);
		this.db.getFlows(book.id).subscribe({
			next: (flows) => {
				const payload = {
					version: 1,
					exportedAt: new Date().toISOString(),
					book: { name: book.name, description: book.description, isPublic: book.isPublic },
					flows,
				};
				const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = `${book.name.replace(/[^a-z0-9]/gi, "_")}.comfyuix.json`;
				a.click();
				URL.revokeObjectURL(url);
				this.exportingBookId.set(null);
			},
			error: () => {
				this.dialog.alert("An error occurred while exporting the book.");
				this.exportingBookId.set(null);
			},
		});
	}

	importingBook = signal(false);

	triggerImportBook() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json";
		input.onchange = (e) => this.importBookFromFile(e);
		input.click();
	}

	async importBookFromFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		let data: any;
		try {
			data = JSON.parse(await file.text());
		} catch {
			this.dialog.alert("Invalid file: could not parse JSON.");
			return;
		}

		if (data.version !== 1 || !data.book || !Array.isArray(data.flows)) {
			this.dialog.alert("Invalid export file format.");
			return;
		}

		const name = await this.dialog.prompt("Book name:", { defaultValue: data.book.name ?? "" });
		if (!name?.trim()) return;

		this.importingBook.set(true);

		this.db
			.createBook({
				name: name.trim(),
				description: data.book.description ?? "",
				isPublic: false,
			})
			.subscribe({
				next: async (newBook: any) => {
					const flows: FlowConfig[] = data.flows;
					let failed = 0;
					for (const flow of flows) {
						try {
							await lastValueFrom(this.db.createFlow(newBook.id, { ...flow, id: "" }));
						} catch {
							failed++;
						}
					}
					this.importingBook.set(false);
					this.dialog.alert(
						failed > 0
							? `Book imported with ${flows.length - failed}/${flows.length} flows. ${failed} failed.`
							: `"${name}" imported successfully with ${flows.length} flow(s).`,
					);
					this.loadBooks();
				},
				error: () => {
					this.dialog.alert("An error occurred while creating the book.");
					this.importingBook.set(false);
				},
			});
	}

	// ---------------------------------------------------------------------------
	// Auth / nav
	// ---------------------------------------------------------------------------

	async logOut() {
		const confirm = await this.dialog.confirm("Are you sure you want to log out?");
		if (confirm) this.authService.logout();
	}

	goToAdmin() { this.router.navigate(["/admin/users"]); }
	goToAccount() { this.router.navigate(["/account"]); }
}
