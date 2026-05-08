import { DOCUMENT } from "@angular/common";
import { Injectable, Inject, OnDestroy } from "@angular/core";

@Injectable({ providedIn: "root" })
export class PanicService implements OnDestroy {
	private readonly STYLE_ID = "panic-style";
	private enabled = false;
	private keyHandler = this.handleKey.bind(this);

	constructor(@Inject(DOCUMENT) private doc: Document) {
		this.ensureStyles();
		this.doc.addEventListener("keydown", this.keyHandler);
	}

	ngOnDestroy() {
		this.doc.removeEventListener("keydown", this.keyHandler);
	}

	toggle() {
		this.setEnabled(!this.enabled);
	}

	setEnabled(on: boolean) {
		this.enabled = on;
		this.doc.documentElement.classList.toggle("panic-on", on);
	}

	isEnabled() {
		return this.enabled;
	}

	private handleKey(event: KeyboardEvent) {
		// Alt + P  OR  Alt + H
		if (
			event.altKey &&
			!event.ctrlKey &&
			!event.shiftKey &&
			(event.key.toLowerCase() === "p" || event.key.toLowerCase() === "h")
		) {
			event.preventDefault();
			this.toggle();
		}
	}

	private ensureStyles() {
		if (this.doc.getElementById(this.STYLE_ID)) return;

		const style = this.doc.createElement("style");
		style.id = this.STYLE_ID;
		style.textContent = `
.panic-on img,
.panic-on video,
.panic-on picture,
.panic-on canvas,
.panic-on svg {
	filter: brightness(0) contrast(1) !important;
}

.panic-on [style*="background-image"] {
	background-image: none !important;
}
`;
		this.doc.head.appendChild(style);
	}
}
