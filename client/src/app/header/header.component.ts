import { Component, ElementRef, HostListener, inject, signal } from "@angular/core";
import { Router, RouterLink, RouterLinkActive } from "@angular/router";
import { AuthService } from "../auth/auth.service";
import { Dialog } from "../dialog";
import { ActiveBookService } from "../active-book.service";
import { ComfyUIDatabaseService } from "../comfyui/comfyui-database.service";

@Component({
	selector: "app-header",
	standalone: true,
	imports: [RouterLink, RouterLinkActive],
	template: `
		<header class="titlebar">
			<div class="titlebar__inner">
				<a class="app-hdr__logo" routerLink="/books">ComfyUIX</a>
				@if (auth.isLoggedIn()) {
					<!-- Desktop nav -->
					<nav class="app-hdr__nav">
						<a
							class="app-hdr__link"
							routerLink="/books"
							[routerLinkActiveOptions]="{ exact: true }"
							routerLinkActive="app-hdr__link--active"
							>Books</a
						>
						<a
							class="app-hdr__link"
							routerLink="/gallery"
							routerLinkActive="app-hdr__link--active"
							>Gallery</a
						>
						<a
							class="app-hdr__link"
							routerLink="/quick-flows"
							routerLinkActive="app-hdr__link--active"
							>Quick Flows</a
						>
						<a
							class="app-hdr__link"
							routerLink="/servers"
							routerLinkActive="app-hdr__link--active"
							>Servers</a
						>
						<a
							class="app-hdr__link"
							routerLink="/account"
							routerLinkActive="app-hdr__link--active"
							>Account</a
						>
						@if (auth.isAdmin()) {
							<a
								class="app-hdr__link"
								routerLink="/admin/users"
								routerLinkActive="app-hdr__link--active"
								>Admin</a
							>
						}

						<button
							class="app-hdr__link app-hdr__link--logout"
							type="button"
							(click)="logout()"
						>
							Logout
						</button>

						<!-- Active-book split button -->
						<div class="book-btn-wrapper">
							@if (activeBook.activeBook(); as book) {
								<div class="book-btn-group">
									<a class="book-btn-open" [routerLink]="['/books', book.id]">
										<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
										<span class="book-btn-label">Open</span>
										<span class="book-btn-name">{{ book.name }}</span>
									</a>
									<button class="book-btn-chevron" type="button" (click)="toggleBookDropdown($event)" aria-label="Switch book">
										<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
									</button>
								</div>
							} @else {
								<button class="book-btn-select" type="button" (click)="toggleBookDropdown($event)">
									Open Book
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
								</button>
							}

							@if (bookDropdownOpen()) {
								<div class="book-dropdown">
									@if (bookListLoading()) {
										<div class="book-dropdown__empty">Loading…</div>
									} @else if (bookList().length === 0) {
										<div class="book-dropdown__empty">No books yet.</div>
									} @else {
										@for (b of bookList(); track b.id) {
											<button
												class="book-dropdown__item"
												[class.book-dropdown__item--active]="b.id === activeBook.activeBook()?.id"
												type="button"
												(click)="selectBook(b)"
											>{{ b.name }}</button>
										}
									}
								</div>
							}
						</div>
					</nav>

					<!-- Hamburger button (mobile only) -->
					<button
						class="app-hdr__burger"
						type="button"
						(click)="menuOpen.set(!menuOpen())"
						aria-label="Toggle menu"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							@if (menuOpen()) {
								<line x1="18" y1="6" x2="6" y2="18" />
								<line x1="6" y1="6" x2="18" y2="18" />
							} @else {
								<line x1="3" y1="6" x2="21" y2="6" />
								<line x1="3" y1="12" x2="21" y2="12" />
								<line x1="3" y1="18" x2="21" y2="18" />
							}
						</svg>
					</button>

					<!-- Mobile dropdown -->
					@if (menuOpen()) {
						<div class="app-hdr__mobile-nav">
							<a
								class="app-hdr__mobile-link"
								routerLink="/books"
								[routerLinkActiveOptions]="{ exact: true }"
								routerLinkActive="app-hdr__mobile-link--active"
								(click)="menuOpen.set(false)"
								>Books</a
							>
							<a
								class="app-hdr__mobile-link"
								routerLink="/gallery"
								routerLinkActive="app-hdr__mobile-link--active"
								(click)="menuOpen.set(false)"
								>Gallery</a
							>
							<a
								class="app-hdr__mobile-link"
								routerLink="/quick-flows"
								routerLinkActive="app-hdr__mobile-link--active"
								(click)="menuOpen.set(false)"
								>Quick Flows</a
							>
							<a
								class="app-hdr__mobile-link"
								routerLink="/servers"
								routerLinkActive="app-hdr__mobile-link--active"
								(click)="menuOpen.set(false)"
								>Servers</a
							>
							<a
								class="app-hdr__mobile-link"
								routerLink="/account"
								routerLinkActive="app-hdr__mobile-link--active"
								(click)="menuOpen.set(false)"
								>Account</a
							>
							@if (auth.isAdmin()) {
								<a
									class="app-hdr__mobile-link"
									routerLink="/admin/users"
									routerLinkActive="app-hdr__mobile-link--active"
									(click)="menuOpen.set(false)"
									>Admin</a
								>
							}
							@if (activeBook.activeBook(); as book) {
								<a
									class="app-hdr__mobile-link app-hdr__mobile-link--book"
									[routerLink]="['/books', book.id]"
									(click)="menuOpen.set(false)"
								>Open {{ book.name }}</a>
							}
							<button
								class="app-hdr__mobile-link app-hdr__mobile-link--logout"
								type="button"
								(click)="logout()"
							>
								Logout
							</button>
						</div>
					}
				}
			</div>
		</header>
	`,
	styles: [
		`
			.app-hdr__logo {
				font-size: 1.05rem;
				font-weight: 720;
				letter-spacing: 0.6px;
				color: inherit;
				text-decoration: none;
				white-space: nowrap;
				flex-shrink: 0;

				&:hover {
					color: rgba(255, 255, 255, 0.85);
				}
			}

			/* ── Book split button ───────────────────────────────────────────────── */

			.book-btn-wrapper {
				position: relative;
				flex-shrink: 0;
				margin-left: 6px;
			}

			.book-btn-group {
				display: flex;
				align-items: stretch;
				border-radius: 7px;
				border: 1px solid rgba(255, 255, 255, 0.18);
				overflow: hidden;
			}

			.book-btn-open {
				display: flex;
				align-items: center;
				gap: 7px;
				padding: 5px 11px 5px 10px;
				background: rgba(255, 255, 255, 0.1);
				color: rgba(255, 255, 255, 0.92);
				text-decoration: none;
				font-size: 0.82rem;
				font-weight: 500;
				white-space: nowrap;
				max-width: 200px;
				transition: background 0.15s, color 0.15s;

				svg {
					width: 14px;
					height: 14px;
					flex-shrink: 0;
					opacity: 0.6;
				}

				&:hover {
					background: rgba(255, 255, 255, 0.16);
					color: #fff;
				}
			}

			.book-btn-label {
				color: rgba(255, 255, 255, 0.45);
				font-weight: 400;
			}

			.book-btn-name {
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.book-btn-chevron {
				display: flex;
				align-items: center;
				justify-content: center;
				padding: 5px 8px;
				background: rgba(255, 255, 255, 0.07);
				border: none;
				border-left: 1px solid rgba(255, 255, 255, 0.12);
				color: rgba(255, 255, 255, 0.5);
				cursor: pointer;
				transition: background 0.15s, color 0.15s;

				svg {
					width: 13px;
					height: 13px;
					display: block;
				}

				&:hover {
					background: rgba(255, 255, 255, 0.14);
					color: rgba(255, 255, 255, 0.9);
				}
			}

			.book-btn-select {
				display: flex;
				align-items: center;
				gap: 5px;
				padding: 5px 10px;
				background: rgba(255, 255, 255, 0.06);
				border: 1px solid rgba(255, 255, 255, 0.13);
				border-radius: 7px;
				color: rgba(255, 255, 255, 0.45);
				font-size: 0.82rem;
				font-weight: 500;
				cursor: pointer;
				white-space: nowrap;
				transition: background 0.15s, color 0.15s;

				svg {
					width: 13px;
					height: 13px;
					display: block;
				}

				&:hover {
					background: rgba(255, 255, 255, 0.11);
					color: rgba(255, 255, 255, 0.75);
				}
			}

			/* ── Book picker dropdown ────────────────────────────────────────────── */

			.book-dropdown {
				position: absolute;
				top: calc(100% + 6px);
				right: 0;
				min-width: 200px;
				max-width: 280px;
				z-index: 200;
				background: rgba(15, 20, 28, 0.97);
				border: 1px solid rgba(42, 58, 75, 0.7);
				border-radius: 9px;
				box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
				backdrop-filter: blur(16px);
				overflow: hidden;
				padding: 4px;
			}

			.book-dropdown__empty {
				padding: 10px 12px;
				font-size: 0.82rem;
				color: rgba(255, 255, 255, 0.35);
			}

			.book-dropdown__item {
				display: block;
				width: 100%;
				text-align: left;
				padding: 8px 12px;
				background: none;
				border: none;
				border-radius: 6px;
				font-size: 0.84rem;
				color: rgba(255, 255, 255, 0.65);
				cursor: pointer;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				transition: background 0.12s, color 0.12s;

				&:hover {
					background: rgba(255, 255, 255, 0.07);
					color: rgba(255, 255, 255, 0.9);
				}

				&--active {
					color: rgba(180, 200, 255, 0.9);
					background: rgba(122, 162, 255, 0.12);
				}
			}

			/* ── Desktop nav ─────────────────────────────────────────────────────── */

			.app-hdr__nav {
				display: flex;
				align-items: center;
				gap: 2px;
				min-width: 0;
				margin-left: auto;
			}

			.app-hdr__link {
				appearance: none;
				background: none;
				border: none;
				font-family: inherit;
				font-size: 0.82rem;
				font-weight: 500;
				color: rgba(255, 255, 255, 0.5);
				text-decoration: none;
				padding: 5px 10px;
				border-radius: 6px;
				cursor: pointer;
				transition:
					color 0.15s,
					background 0.15s;
				white-space: nowrap;

				&:hover {
					color: rgba(255, 255, 255, 0.85);
					background: rgba(255, 255, 255, 0.06);
				}

				&--active {
					color: rgba(255, 255, 255, 0.92);
					background: rgba(122, 162, 255, 0.12);
				}

				&--logout {
					color: rgba(255, 255, 255, 0.35);

					&:hover {
						color: var(--danger);
						background: rgba(255, 80, 80, 0.08);
					}
				}
			}

			/* ── Hamburger button ────────────────────────────────────────────────── */

			.app-hdr__burger {
				display: none;
				appearance: none;
				background: none;
				border: none;
				color: rgba(255, 255, 255, 0.6);
				cursor: pointer;
				padding: 6px;
				border-radius: 6px;
				flex-shrink: 0;
				transition:
					color 0.15s,
					background 0.15s;

				svg {
					width: 20px;
					height: 20px;
					display: block;
				}

				&:hover {
					color: rgba(255, 255, 255, 0.9);
					background: rgba(255, 255, 255, 0.08);
				}
			}

			/* ── Mobile dropdown ─────────────────────────────────────────────────── */

			.app-hdr__mobile-nav {
				position: fixed;
				top: var(--titlebar-h);
				left: 0;
				right: 0;
				z-index: 9;
				display: flex;
				flex-direction: column;
				padding: 6px 8px 10px;
				background: rgba(11, 15, 20, 0.97);
				backdrop-filter: blur(16px);
				border-bottom: 1px solid rgba(42, 58, 75, 0.65);
				box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
			}

			.app-hdr__mobile-link {
				appearance: none;
				background: none;
				border: none;
				font-family: inherit;
				font-size: 0.92rem;
				font-weight: 500;
				color: rgba(255, 255, 255, 0.55);
				text-decoration: none;
				padding: 10px 12px;
				border-radius: 8px;
				cursor: pointer;
				text-align: left;
				transition:
					color 0.15s,
					background 0.15s;

				&:hover {
					color: rgba(255, 255, 255, 0.9);
					background: rgba(255, 255, 255, 0.07);
				}

				&--active {
					color: rgba(255, 255, 255, 0.92);
					background: rgba(122, 162, 255, 0.12);
				}

				&--logout {
					color: rgba(255, 255, 255, 0.3);
					margin-top: 4px;

					&:hover {
						color: var(--danger);
						background: rgba(255, 80, 80, 0.08);
					}
				}

				&--book {
					color: rgba(255, 255, 255, 0.92);
					font-weight: 600;
					background: rgba(255, 255, 255, 0.08);
					border: 1px solid rgba(255, 255, 255, 0.14);
					margin-top: 4px;

					&:hover {
						background: rgba(255, 255, 255, 0.13);
						color: #fff;
					}
				}
			}

			/* ── Responsive ──────────────────────────────────────────────────────── */

			@media (max-width: 600px) {
				.app-hdr__nav {
					display: none;
				}

				.app-hdr__burger {
					display: flex;
					align-items: center;
					justify-content: center;
				}
			}
		`,
	],
})
export class HeaderComponent {
	protected auth = inject(AuthService);
	protected activeBook = inject(ActiveBookService);
	private db = inject(ComfyUIDatabaseService);
	private router = inject(Router);
	private dialog = inject(Dialog);
	private el = inject(ElementRef);

	menuOpen = signal(false);
	bookDropdownOpen = signal(false);
	bookList = signal<Array<{ id: string; name: string }>>([]);
	bookListLoading = signal(false);

	@HostListener("document:keydown.escape")
	onEsc(): void {
		this.menuOpen.set(false);
		this.bookDropdownOpen.set(false);
	}

	@HostListener("document:click", ["$event"])
	onDocClick(e: MouseEvent): void {
		if (this.bookDropdownOpen() && !this.el.nativeElement.contains(e.target)) {
			this.bookDropdownOpen.set(false);
		}
	}

	toggleBookDropdown(e: MouseEvent): void {
		e.stopPropagation();
		const opening = !this.bookDropdownOpen();
		this.bookDropdownOpen.set(opening);
		if (opening && this.bookList().length === 0) {
			this.loadBooks();
		}
	}

	private loadBooks(): void {
		this.bookListLoading.set(true);
		this.db.getSelfBooks().subscribe({
			next: (books: any[]) => {
				this.bookList.set(books.map((b) => ({ id: b.id, name: b.name })));
				this.bookListLoading.set(false);
			},
			error: () => this.bookListLoading.set(false),
		});
	}

	selectBook(book: { id: string; name: string }): void {
		this.activeBook.set(book);
		this.bookDropdownOpen.set(false);
		this.router.navigate(["/books", book.id]);
	}

	async logout(): Promise<void> {
		this.menuOpen.set(false);
		const ok = await this.dialog.confirm("Are you sure you want to log out?");
		if (ok) this.auth.logout();
	}
}
