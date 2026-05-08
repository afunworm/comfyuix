import {
	ChangeDetectionStrategy,
	Component,
	ElementRef,
	HostListener,
	ViewChild,
	effect,
	inject,
	signal,
} from "@angular/core";
import {
	ContextMenuService,
	type ContextMenuItem,
} from "./context-menu.service";

@Component({
	selector: "app-context-menu-host",
	standalone: true,
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: `
		<div
			#menuEl
			class="ctx-menu"
			[attr.data-open]="vm().open ? 'true' : null"
			[attr.data-sub-left]="subMenuLeft() ? '' : null"
			role="menu"
			[style.left.px]="pos().x"
			[style.top.px]="pos().y"
			(mousedown)="$event.stopPropagation()"
			(contextmenu)="$event.preventDefault()"
		>
			@for (item of vm().items; track item) {
				@if (item.title) {
					<div class="ctx-menu__title">{{ item.label }}</div>
				} @else if (item.divider) {
					<hr class="ctx-menu__divider" />
				} @else if (item.children?.length) {
					<!-- Item with submenu -->
					<div class="ctx-menu__row">
						<button
							type="button"
							class="ctx-menu__item ctx-menu__item--has-sub"
							role="menuitem"
							[disabled]="isDisabled(item)"
						>
							{{ item.label }}
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								class="ctx-menu__sub-arrow"
							>
								<polyline points="9 18 15 12 9 6" />
							</svg>
						</button>
						<div class="ctx-menu ctx-menu--sub" role="menu">
							@for (child of item.children; track child) {
								@if (child.divider) {
									<hr class="ctx-menu__divider" />
								} @else {
									<button
										type="button"
										class="ctx-menu__item"
										role="menuitem"
										[disabled]="isDisabled(child)"
										(click)="run(child)"
									>
										{{ child.label }}
									</button>
								}
							}
						</div>
					</div>
				} @else if (item.checked !== undefined) {
					<button
						type="button"
						class="ctx-menu__item ctx-menu__item--check"
						role="menuitemcheckbox"
						[attr.aria-checked]="item.checked"
						[disabled]="isDisabled(item)"
						(click)="run(item)"
					>
						<span class="ctx-menu__checkmark">{{ item.checked ? "✓" : "–" }}</span>
						{{ item.label }}
					</button>
				} @else {
					<button
						type="button"
						class="ctx-menu__item"
						role="menuitem"
						[disabled]="isDisabled(item)"
						(click)="run(item)"
					>
						{{ item.label }}
					</button>
				}
			}
		</div>
	`,
	styles: [
		`
			.ctx-menu {
				position: fixed;
				z-index: 9999;
				display: none;

				min-width: 180px;
				max-width: min(280px, calc(100vw - 24px));

				border-radius: 10px;
				border: 1px solid rgba(42, 58, 75, 0.9);
				background:
					linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent),
					rgba(13, 19, 28, 0.98);

				box-shadow:
					0 4px 6px rgba(0, 0, 0, 0.2),
					0 16px 48px rgba(0, 0, 0, 0.6);
				backdrop-filter: blur(16px);
				padding: 4px;
			}

			.ctx-menu[data-open="true"] {
				display: block;
			}

			/* ── Submenu ─────────────────────────────────────────────────────── */

			.ctx-menu__row {
				position: relative;
			}

			.ctx-menu--sub {
				/* Reset inherited fixed positioning — use absolute inside the row */
				position: absolute;
				top: -4px; /* compensate for parent's 4px padding */
				left: calc(100% - 1px); /* overlap 1px so borders merge edge-to-edge */
				/* hidden by default */
				display: none;
				/* z-index above the parent menu */
				z-index: 10000;
			}

			/* Show submenu when the row is hovered OR when the submenu itself is hovered */
			.ctx-menu__row:hover > .ctx-menu--sub,
			.ctx-menu--sub:hover {
				display: block;
			}

			/* Flip submenu to the left when the main menu is near the right viewport edge */
			.ctx-menu[data-sub-left] .ctx-menu--sub {
				left: auto;
				right: calc(100% - 1px);
			}

			.ctx-menu__item--has-sub {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 8px;
			}

			.ctx-menu__sub-arrow {
				width: 13px;
				height: 13px;
				flex-shrink: 0;
				opacity: 0.5;
			}

			.ctx-menu__row:hover .ctx-menu__sub-arrow {
				opacity: 1;
			}

			/* ── Items ───────────────────────────────────────────────────────── */

			.ctx-menu__item {
				appearance: none;
				border: 0;
				border-radius: 7px;
				background: transparent;
				color: var(--text);

				width: 100%;
				padding: 6px 10px;
				cursor: pointer;
				text-align: left;

				font-weight: 500;
				letter-spacing: 0.2px;
				font-size: 0.8rem;
				font-family: inherit;

				transition:
					background 100ms ease,
					color 100ms ease;
			}

			.ctx-menu__item:hover {
				background: rgba(122, 162, 255, 0.1);
				color: rgba(215, 225, 238, 1);
			}

			.ctx-menu__item:active {
				background: rgba(122, 162, 255, 0.16);
			}

			.ctx-menu__item[disabled] {
				opacity: 0.35;
				cursor: not-allowed;
			}

			.ctx-menu__item--check {
				display: flex;
				align-items: center;
				gap: 6px;
			}

			.ctx-menu__checkmark {
				width: 12px;
				flex-shrink: 0;
				font-size: 0.75rem;
				color: rgba(122, 162, 255, 0.9);
			}

			.ctx-menu__title {
				padding: 6px 10px 4px;
				font-size: 0.7rem;
				font-weight: 600;
				letter-spacing: 0.6px;
				text-transform: uppercase;
				color: rgba(122, 162, 255, 0.7);
				pointer-events: none;
				user-select: none;
			}

			.ctx-menu__divider {
				margin: 4px 0;
				border: 0;
				height: 1px;
				background: rgba(42, 58, 75, 0.8);
			}
		`,
	],
})
export class ContextMenuHostComponent {
	private readonly contextMenu = inject(ContextMenuService);

	@ViewChild("menuEl") private menuEl?: ElementRef<HTMLElement>;

	readonly vm = this.contextMenu.state;
	readonly pos = signal({ x: 0, y: 0 });

	/** True when the main menu is in the right half → open submenus to the left */
	readonly subMenuLeft = signal(false);

	// React to state changes
	private readonly _sync = effect(() => {
		const s = this.vm();
		if (!s.open) return;

		// Start off-screen so the menu is invisible for the one frame before
		// clampToViewport computes and sets the final clamped position.
		this.pos.set({ x: -9999, y: -9999 });
		this.subMenuLeft.set(s.x > window.innerWidth / 2);

		requestAnimationFrame(() => this.clampToViewport());
	});

	close(): void {
		this.contextMenu.close();
	}

	run(item: ContextMenuItem<any>): void {
		if (this.isDisabled(item)) return;
		if (!item.keepOpen) this.contextMenu.close();
		item.run?.(this.vm().ctx);
	}

	isDisabled(item: ContextMenuItem<any>): boolean {
		const d = item.disabled;
		if (typeof d === "function") return !!d(this.vm().ctx);
		return !!d;
	}

	private clampToViewport(): void {
		const el = this.menuEl?.nativeElement;
		if (!el) return;

		const s = this.vm();
		if (!s.open) return;

		const margin = 10;

		const menuW = el.offsetWidth;
		const menuH = el.offsetHeight;

		if (!menuW || !menuH) {
			requestAnimationFrame(() => this.clampToViewport());
			return;
		}

		const vw = window.innerWidth;
		const vh = window.innerHeight;

		let x = s.x;
		let y = s.y;

		if (x + menuW + margin > vw) x = Math.max(margin, vw - menuW - margin);
		if (y + menuH + margin > vh) y = Math.max(margin, vh - menuH - margin);

		x = Math.max(margin, Math.min(x, vw - menuW - margin));
		y = Math.max(margin, Math.min(y, vh - menuH - margin));

		this.pos.set({ x, y });
	}

	@HostListener("document:keydown.escape")
	onEsc(): void {
		if (this.vm().open) this.contextMenu.close();
	}

	@HostListener("document:mousedown", ["$event"])
	onDocMouseDown(ev: MouseEvent): void {
		if (!this.vm().open) return;

		const el = this.menuEl?.nativeElement;
		if (!el) return;

		const target = ev.target as Node | null;
		if (target && !el.contains(target)) this.contextMenu.close();
	}

	@HostListener("window:resize")
	onResize(): void {
		if (this.vm().open) this.clampToViewport();
	}

	@HostListener("window:scroll")
	onScroll(): void {
		if (this.vm().open) this.contextMenu.close();
	}
}
