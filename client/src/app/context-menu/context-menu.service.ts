import { Injectable, signal } from "@angular/core";

export type ContextMenuItem<TCtx = unknown> = {
	label?: string; // optional because divider rows don't need it
	run?: (ctx: TCtx) => void;
	disabled?: boolean | ((ctx: TCtx) => boolean);
	divider?: boolean;
	title?: boolean; // non-interactive heading row
	keepOpen?: boolean; // prevent menu from closing when this item is clicked
	checked?: boolean; // renders as a checkbox-style toggle when defined
	children?: ContextMenuItem<TCtx>[]; // submenu items (shown on hover)
};

export type ContextMenuState = {
	open: boolean;
	x: number;
	y: number;
	items: ContextMenuItem<any>[];
	ctx: any;
};

@Injectable({ providedIn: "root" })
export class ContextMenuService {
	private readonly _state = signal<ContextMenuState>({
		open: false,
		x: 0,
		y: 0,
		items: [],
		ctx: null,
	});

	readonly state = this._state.asReadonly();

	open<TCtx>(ev: MouseEvent, items: ContextMenuItem<TCtx>[], ctx: TCtx): void {
		ev.preventDefault();
		ev.stopPropagation();

		// For position: fixed, clientX/clientY is correct.
		// But if they come in as 0 (or weird), fallback to pageX/pageY - scroll.
		const anyEv = ev as any;

		const hasClient = Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY);
		const hasPage = Number.isFinite(anyEv.pageX) && Number.isFinite(anyEv.pageY);

		const x =
			hasClient && (ev.clientX !== 0 || ev.clientY !== 0)
				? ev.clientX
				: hasPage
					? anyEv.pageX - window.scrollX
					: 0;

		const y =
			hasClient && (ev.clientX !== 0 || ev.clientY !== 0)
				? ev.clientY
				: hasPage
					? anyEv.pageY - window.scrollY
					: 0;

		this._state.set({ open: true, x, y, items, ctx });
	}

	/** Open the menu anchored to explicit viewport coordinates (e.g. a button's bounding rect). */
	openAt<TCtx>(
		x: number,
		y: number,
		items: ContextMenuItem<TCtx>[],
		ctx: TCtx,
	): void {
		this._state.set({ open: true, x, y, items, ctx });
	}

	close(): void {
		this._state.update((s) =>
			s.open ? { ...s, open: false, items: [], ctx: null } : s,
		);
	}
}
