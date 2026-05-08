import { Injectable, signal } from "@angular/core";

export interface ActiveBook {
	id: string;
	name: string;
}

@Injectable({ providedIn: "root" })
export class ActiveBookService {
	private readonly KEY = "comfyuix_active_book";

	readonly activeBook = signal<ActiveBook | null>(this.load());

	private load(): ActiveBook | null {
		try {
			const raw = localStorage.getItem(this.KEY);
			return raw ? JSON.parse(raw) : null;
		} catch {
			return null;
		}
	}

	set(book: ActiveBook | null) {
		this.activeBook.set(book);
		if (book) localStorage.setItem(this.KEY, JSON.stringify(book));
		else localStorage.removeItem(this.KEY);
	}
}
