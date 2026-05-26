import {
	Component,
	computed,
	inject,
	Input,
	OnInit,
	signal,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import {
	ImageAssetStorageService,
	StoredFolder,
	StoredImageAsset,
} from "../../comfyui/comfyui-asset-storage.service";
import { ContextMenuService } from "../../context-menu/context-menu.service";
import { Dialog } from "../../dialog";
import { ComfyUIDatabaseService } from "../../comfyui/comfyui-database.service";
import { HeaderComponent } from "../../header/header.component";
import { FooterComponent } from "../../footer/footer.component";
import { lastValueFrom } from "rxjs";

@Component({
	selector: "app-gallery",
	standalone: true,
	imports: [CommonModule, HeaderComponent, FooterComponent],
	templateUrl: "./gallery.html",
	styleUrl: "./gallery.scss",
})
export class GalleryPage implements OnInit {
	private readonly assetService = inject(ImageAssetStorageService);
	private readonly contextMenu = inject(ContextMenuService);
	private readonly dialog = inject(Dialog);
	private readonly db = inject(ComfyUIDatabaseService);

	// ── State ─────────────────────────────────────────────────────────────────

	@Input() set tab(value: string | undefined) {
		if (value === "input" || value === "output") this.galleryTab.set(value);
	}

	galleryTab = signal<"input" | "output">("output");
	gallerySelectMode = signal<boolean>(false);
	selectedAssetIds = signal<Set<string>>(new Set());
	dragOverFolderId = signal<number | null>(null);
	selectedBookId = signal<string | null>(null);
	books = signal<{ id: string; name: string }[]>([]);
	syncing = signal<boolean>(false);
	syncMessage = signal<string | null>(null);
	syncPhase = signal<'listing' | 'deleting' | null>(null);
	syncTotal = signal<number>(0);
	syncDeleted = signal<number>(0);
	syncPurgePhase = signal<'listing' | 'purging' | null>(null);
	syncPurgeTotal = signal<number>(0);
	syncPurged = signal<number>(0);
	rubberBand = signal<{ left: number; top: number; width: number; height: number } | null>(null);
	private lastSelectedIndex = -1;

	currentInputFolderId = signal<number | null>(null);
	currentOutputFolderId = signal<number | null>(null);

	imagePreview = signal<{
		url: string;
		filename: string;
		x: number;
		y: number;
		left: number;
		right: number;
		naturalWidth?: number;
		naturalHeight?: number;
	} | null>(null);

	// ── Data from service ──────────────────────────────────────────────────────

	readonly inputFolders = this.assetService.inputFolders$;
	readonly outputFolders = this.assetService.outputFolders$;
	private readonly uploadedAssets = this.assetService.input$;
	private readonly generatedAssets = this.assetService.output$;

	readonly visibleInputAssets = computed(() => {
		const folderId = this.currentInputFolderId();
		const bookId = this.selectedBookId();
		return this.uploadedAssets().filter((a) => {
			if (bookId !== null && a.bookId !== bookId) return false;
			return folderId === null ? a.folderId == null : a.folderId === folderId;
		});
	});

	readonly visibleOutputAssets = computed(() => {
		const folderId = this.currentOutputFolderId();
		const bookId = this.selectedBookId();
		return this.generatedAssets().filter((a) => {
			if (bookId !== null && a.bookId !== bookId) return false;
			return folderId === null ? a.folderId == null : a.folderId === folderId;
		});
	});

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	async ngOnInit(): Promise<void> {
		this.assetService.initialize();

		try {
			const result = await lastValueFrom(this.db.getSelfBooks());
			this.books.set(
				(result as any[]).map((b: any) => ({ id: b.id, name: b.name })),
			);
		} catch {}
	}

	// ── Image hover preview ────────────────────────────────────────────────────

	showImagePreview(event: MouseEvent, asset: StoredImageAsset): void {
		if (this.rubberBand()) return;
		const { left, y } = this.clampPreviewPos(event.clientX, event.clientY);
		this.imagePreview.set({
			url: asset.url,
			filename: asset.filename,
			x: event.clientX,
			y,
			left,
			right: window.innerWidth - event.clientX + 20,
		});
	}

	updateImagePreviewPosition(event: MouseEvent): void {
		const p = this.imagePreview();
		if (!p) return;
		const { left, y } = this.clampPreviewPos(event.clientX, event.clientY);
		this.imagePreview.set({
			...p,
			x: event.clientX,
			y,
			left,
			right: window.innerWidth - event.clientX + 20,
		});
	}

	private clampPreviewPos(
		clientX: number,
		clientY: number,
	): { left: number; y: number } {
		const PREVIEW_H = 370; // img(320) + caption(~50)
		const y = Math.max(8, Math.min(clientY, window.innerHeight - PREVIEW_H - 8));
		return { y, left: clientX + 20 };
	}

	setImagePreviewSize(event: Event): void {
		const img = event.target as HTMLImageElement;
		const p = this.imagePreview();
		if (!p) return;
		this.imagePreview.set({
			...p,
			naturalWidth: img.naturalWidth,
			naturalHeight: img.naturalHeight,
		});
	}

	hideImagePreview(): void {
		this.imagePreview.set(null);
	}

	// ── Rubber-band select ─────────────────────────────────────────────────────

	onBodyMouseDown(event: MouseEvent): void {
		if (event.button !== 0) return;
		const target = event.target as HTMLElement;
		if (target.closest('.gallery-item, .gallery-folder-item, button, a')) return;

		const startX = event.clientX;
		const startY = event.clientY;
		let hasDragged = false;

		const onMove = (e: MouseEvent) => {
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			if (!hasDragged && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
			hasDragged = true;

			if (!this.gallerySelectMode()) {
				this.gallerySelectMode.set(true);
				this.selectedAssetIds.set(new Set());
			}

			const left = Math.min(startX, e.clientX);
			const top = Math.min(startY, e.clientY);
			const right = Math.max(startX, e.clientX);
			const bottom = Math.max(startY, e.clientY);

			this.rubberBand.set({ left, top, width: right - left, height: bottom - top });
			this.hitTestRubberBand(left, top, right, bottom);
		};

		const onUp = () => {
			this.rubberBand.set(null);
			this.hideImagePreview();
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		};

		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}

	private hitTestRubberBand(left: number, top: number, right: number, bottom: number): void {
		const items = document.querySelectorAll<HTMLElement>('.gallery-item[data-id]');
		const newIds = new Set<string>();
		items.forEach((el) => {
			const id = el.dataset['id'];
			if (!id) return;
			const r = el.getBoundingClientRect();
			if (r.right > left && r.left < right && r.bottom > top && r.top < bottom) {
				newIds.add(id);
			}
		});
		this.selectedAssetIds.set(newIds);
	}

	// ── Select mode ────────────────────────────────────────────────────────────

	toggleSelectMode(): void {
		this.gallerySelectMode.update((v) => !v);
		this.selectedAssetIds.set(new Set());
		this.lastSelectedIndex = -1;
	}

	selectAll(): void {
		const assets =
			this.galleryTab() === 'input' ? this.visibleInputAssets() : this.visibleOutputAssets();
		this.selectedAssetIds.set(new Set(assets.map((a) => a.id)));
	}

	toggleAssetSelection(
		id: string,
		event?: MouseEvent,
		allAssets?: { id: string }[],
	): void {
		const currentIndex = allAssets?.findIndex((a) => a.id === id) ?? -1;
		if (
			event?.shiftKey &&
			allAssets &&
			this.lastSelectedIndex >= 0 &&
			currentIndex >= 0
		) {
			const from = Math.min(this.lastSelectedIndex, currentIndex);
			const to = Math.max(this.lastSelectedIndex, currentIndex);
			this.selectedAssetIds.update((curr) => {
				const next = new Set(curr);
				for (let i = from; i <= to; i++) next.add(allAssets[i].id);
				return next;
			});
		} else {
			this.selectedAssetIds.update((curr) => {
				const next = new Set(curr);
				next.has(id) ? next.delete(id) : next.add(id);
				return next;
			});
			if (currentIndex >= 0) this.lastSelectedIndex = currentIndex;
		}
	}

	isAssetSelected(id: string): boolean {
		return this.selectedAssetIds().has(id);
	}

	async bulkDeleteSelected(): Promise<void> {
		const ids = [...this.selectedAssetIds()];
		if (!ids.length) return;
		const confirmed = await this.dialog.confirm(
			`Delete ${ids.length} selected image${ids.length > 1 ? "s" : ""}? This cannot be undone.`,
		);
		if (!confirmed) return;
		for (const id of ids) this.assetService.removeAsset(id);
		this.selectedAssetIds.set(new Set());
		this.gallerySelectMode.set(false);
		this.lastSelectedIndex = -1;
	}

	removeAsset(id: string): void {
		this.hideImagePreview();
		this.assetService.removeAsset(id);
	}

	// ── Folders ────────────────────────────────────────────────────────────────

	enterFolder(folderId: number): void {
		if (this.galleryTab() === "input") {
			this.currentInputFolderId.set(folderId);
		} else {
			this.currentOutputFolderId.set(folderId);
		}
		this.gallerySelectMode.set(false);
		this.selectedAssetIds.set(new Set());
	}

	exitFolder(): void {
		if (this.galleryTab() === "input") {
			this.currentInputFolderId.set(null);
		} else {
			this.currentOutputFolderId.set(null);
		}
		this.gallerySelectMode.set(false);
		this.selectedAssetIds.set(new Set());
	}

	currentFolderId(): number | null {
		return this.galleryTab() === "input"
			? this.currentInputFolderId()
			: this.currentOutputFolderId();
	}

	currentFolderName(): string | null {
		const id = this.currentFolderId();
		if (id === null) return null;
		const folders =
			this.galleryTab() === "input" ? this.inputFolders() : this.outputFolders();
		return folders.find((f) => f.id === id)?.name ?? null;
	}

	onBookSelectChange(value: string): void {
		this.selectedBookId.set(value || null);
	}

	async createFolder(): Promise<void> {
		const name = await this.dialog.prompt("New folder name:");
		if (!name?.trim()) return;
		await this.assetService.createFolder(name.trim(), this.galleryTab());
	}

	async renameFolder(folder: StoredFolder, event: MouseEvent): Promise<void> {
		event.stopPropagation();
		const name = await this.dialog.prompt("Rename folder:", {
			defaultValue: folder.name,
		});
		if (!name?.trim() || name.trim() === folder.name) return;
		await this.assetService.renameFolder(folder.id, name.trim());
	}

	async deleteFolder(folder: StoredFolder, event: MouseEvent): Promise<void> {
		event.stopPropagation();
		const assetCount = this.assetService
			.assets$()
			.filter((a) => a.folderId === folder.id).length;
		const message =
			assetCount > 0
				? `Delete folder "<strong>${folder.name}</strong>" and its ${assetCount} image${assetCount > 1 ? "s" : ""}? This cannot be undone.`
				: `Delete folder "<strong>${folder.name}</strong>"? This cannot be undone.`;
		const confirmed = await this.dialog.confirm(message);
		if (!confirmed) return;
		if (this.currentFolderId() === folder.id) this.exitFolder();
		await this.assetService.deleteFolder(folder.id);
	}

	openFolderContextMenu(ev: MouseEvent, folder: StoredFolder): void {
		ev.preventDefault();
		this.contextMenu.open(
			ev,
			[
				{ label: "Rename", run: () => this.renameFolder(folder, ev) },
				{ divider: true },
				{ label: "Delete Folder", run: () => this.deleteFolder(folder, ev) },
			],
			null,
		);
	}

	removeFromFolder(assetId: string): void {
		this.assetService.moveAssetToFolder(assetId, null);
	}

	// ── Drag & drop ────────────────────────────────────────────────────────────

	onAssetDragStart(ev: DragEvent, asset: StoredImageAsset): void {
		const ids =
			this.gallerySelectMode() && this.selectedAssetIds().has(asset.id)
				? [...this.selectedAssetIds()]
				: [asset.id];
		ev.dataTransfer!.effectAllowed = "move";
		ev.dataTransfer!.setData("application/json", JSON.stringify(ids));
	}

	onFolderDragOver(ev: DragEvent): void {
		if (!ev.dataTransfer?.types.includes("application/json")) return;
		ev.preventDefault();
		ev.dataTransfer.dropEffect = "move";
	}

	onFolderDragEnter(ev: DragEvent, folder: StoredFolder): void {
		if (!ev.dataTransfer?.types.includes("application/json")) return;
		this.dragOverFolderId.set(folder.id);
	}

	onFolderDragLeave(ev: DragEvent, folder: StoredFolder): void {
		const related = ev.relatedTarget as Node | null;
		if (related && (ev.currentTarget as HTMLElement).contains(related)) return;
		if (this.dragOverFolderId() === folder.id) this.dragOverFolderId.set(null);
	}

	onFolderDrop(ev: DragEvent, folder: StoredFolder): void {
		ev.preventDefault();
		this.dragOverFolderId.set(null);
		const raw = ev.dataTransfer?.getData("application/json");
		if (!raw) return;
		const ids: string[] = JSON.parse(raw);
		for (const id of ids) this.assetService.moveAssetToFolder(id, folder.id);
	}

	buildMoveToFolderChildren(asset: StoredImageAsset): any[] {
		const tab = asset.type === "output" ? "output" : "input";
		const folders = tab === "input" ? this.inputFolders() : this.outputFolders();
		const items: any[] = [];
		if (asset.folderId != null) {
			items.push({
				label: "Remove from folder",
				run: () => this.assetService.moveAssetToFolder(asset.id, null),
			});
			items.push({ divider: true });
		}
		if (!folders.length) {
			items.push({ label: "No folders yet", disabled: true });
		} else {
			for (const folder of folders) {
				if (folder.id === asset.folderId) continue;
				items.push({
					label: folder.name,
					run: () => this.assetService.moveAssetToFolder(asset.id, folder.id),
				});
			}
		}
		return items;
	}

	async saveImageAs(url: string): Promise<void> {
		const guessName = (() => {
			try {
				const u = new URL(url, window.location.href);
				const last = u.pathname.split("/").pop() || "";
				return last && last.includes(".") ? last : "image";
			} catch {
				return "image";
			}
		})();
		try {
			const res = await fetch(url, { mode: "cors" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const objectUrl = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = objectUrl;
			a.download = guessName;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(objectUrl);
		} catch {
			window.open(url, "_blank", "noopener,noreferrer");
		}
	}

	// ── Sync ──────────────────────────────────────────────────────────────────

	async syncImport(): Promise<void> {
		const bookId = this.selectedBookId();
		if (!bookId || this.syncing()) return;
		this.syncing.set(true);
		this.syncMessage.set(null);
		try {
			const result = await lastValueFrom(this.db.syncImport(bookId));
			this.syncMessage.set(
				result.created > 0
					? `Imported ${result.created} file${result.created !== 1 ? 's' : ''} from server.`
					: 'No new files found on server.',
			);
			if (result.created > 0) await this.assetService.initialize();
		} catch {
			this.syncMessage.set('Sync failed. Is the server connected?');
		} finally {
			this.syncing.set(false);
		}
	}

	async syncClean(): Promise<void> {
		const bookId = this.selectedBookId();
		if (!bookId || this.syncing()) return;
		const confirmed = await this.dialog.confirm(
			'Delete all files on the ComfyUI server that have no database record for this book? This cannot be undone.',
		);
		if (!confirmed) return;
		this.syncing.set(true);
		this.syncMessage.set(null);
		this.syncPhase.set('listing');
		this.syncTotal.set(0);
		this.syncDeleted.set(0);
		this.syncPurgePhase.set(null);
		try {
			for await (const event of this.db.syncCleanStream(bookId)) {
				if (event.phase === 'listing') {
					this.syncPhase.set('listing');
				} else if (event.phase === 'deleting') {
					this.syncPhase.set('deleting');
					this.syncTotal.set(event.total);
					this.syncDeleted.set(event.deleted);
				} else if (event.phase === 'done') {
					this.syncPhase.set(null);
					this.syncMessage.set(
						event.deleted > 0
							? `Deleted ${event.deleted} untracked file${event.deleted !== 1 ? 's' : ''} from server.`
							: 'No untracked files found on server.',
					);
				} else if (event.phase === 'error') {
					console.error('[SyncClean] server error:', event.message);
					this.syncPhase.set(null);
					this.syncMessage.set(`Sync failed: ${event.message}`);
				}
			}
		} catch (err) {
			console.error('[SyncClean] client error:', err);
			this.syncPhase.set(null);
			this.syncMessage.set('Sync failed. Is the server connected?');
		} finally {
			this.syncing.set(false);
		}
	}

	async syncPurge(): Promise<void> {
		const bookId = this.selectedBookId();
		if (!bookId || this.syncing()) return;
		const confirmed = await this.dialog.confirm(
			'Remove database records for output images that no longer exist on the server? This will hide those images from your gallery.',
		);
		if (!confirmed) return;
		this.syncing.set(true);
		this.syncMessage.set(null);
		this.syncPhase.set(null);
		this.syncPurgePhase.set('listing');
		this.syncPurgeTotal.set(0);
		this.syncPurged.set(0);
		try {
			for await (const event of this.db.syncPurgeStream(bookId)) {
				if (event.phase === 'listing') {
					this.syncPurgePhase.set('listing');
				} else if (event.phase === 'purging') {
					this.syncPurgePhase.set('purging');
					this.syncPurgeTotal.set(event.total);
					this.syncPurged.set(event.purged);
				} else if (event.phase === 'done') {
					this.syncPurgePhase.set(null);
					this.syncMessage.set(
						event.purged > 0
							? `Removed ${event.purged} stale record${event.purged !== 1 ? 's' : ''} from database.`
							: 'No stale records found.',
					);
					if (event.purged > 0) await this.assetService.initialize();
				} else if (event.phase === 'error') {
					console.error('[SyncPurge] server error:', event.message);
					this.syncPurgePhase.set(null);
					this.syncMessage.set(`Purge failed: ${event.message}`);
				}
			}
		} catch (err) {
			console.error('[SyncPurge] client error:', err);
			this.syncPurgePhase.set(null);
			this.syncMessage.set('Purge failed. Is the server connected?');
		} finally {
			this.syncing.set(false);
		}
	}

	// ── Context menus ──────────────────────────────────────────────────────────

	openAssetContextMenu(ev: MouseEvent, asset: StoredImageAsset): void {
		const url = asset.url;
		const items: any[] = [
			{
				label: "Open in New Tab",
				run: () => window.open(url, "_blank", "noopener,noreferrer"),
			},
			{ label: "Save Image As", run: () => this.saveImageAs(url) },
			{ label: "Copy Image URL", run: () => navigator.clipboard.writeText(url) },
			{ divider: true },
			{ label: "Move to Folder", children: this.buildMoveToFolderChildren(asset) },
		];
		if (this.gallerySelectMode() && this.selectedAssetIds().size > 0) {
			items.push({ divider: true });
			items.push({
				label: `Delete Selected (${this.selectedAssetIds().size})`,
				run: () => this.bulkDeleteSelected(),
			});
		}
		this.contextMenu.open(ev, items, null);
	}
}
