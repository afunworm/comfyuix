import { Component, inject, signal, computed, Input, OnInit, OnDestroy, ElementRef } from "@angular/core";
import { Subscription, retry, timer } from 'rxjs';
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import { CommonModule } from "@angular/common";
import { forkJoin } from "rxjs";
import { ComfyUIDatabaseService, ComfyServer, FsEntry, ServerModel, ServerModelInput, FetchStatus } from "../../comfyui/comfyui-database.service";
import { Dialog } from "../../dialog";
import { ModelInfoModal } from "../../model-info-modal/model-info-modal";

export const ALLOWED_MODEL_EXTENSIONS = [
	".safetensors",
	".ckpt",
	".pt",
	".pth",
	".bin",
	".gguf",
	".sft",
	".onnx",
	".json",
	".yaml",
	".yml",
];

export const MODEL_TYPES: { label: string; path: string }[] = [
	{ label: "Checkpoints", path: "checkpoints" },
	{ label: "LoRAs", path: "loras" },
	{ label: "Diffusion Models", path: "diffusion_models" },
	{ label: "VAE", path: "vae" },
	{ label: "Text Encoders", path: "text_encoders" },
	{ label: "CLIP", path: "clip" },
	{ label: "UNet", path: "unet" },
	{ label: "ControlNet", path: "controlnet" },
	{ label: "Upscale Models", path: "upscale_models" },
	{ label: "Embeddings", path: "embeddings" },
	{ label: "Model Patches", path: "model_patches" },
];

interface QuickTrackItem {
	entry: FsEntry;
	typePath: string;
	typeLabel: string;
	url: string;
}

interface ImportPreviewEntry {
	model: ServerModelInput;
	status: "new" | "tracked";
	selected: boolean;
}


interface ActiveDownload {
	fetchId: string;
	name: string;
	dest: string;
	status: FetchStatus;
	subscription?: Subscription;
	queuePosition?: number;
}

@Component({
	selector: "app-model-manager",
	standalone: true,
	imports: [FormsModule, RouterLink, CommonModule, ModelInfoModal],
	templateUrl: "./model-manager.html",
	styleUrl: "./model-manager.scss",
})
export class ModelManagerPage implements OnInit, OnDestroy {
	@Input() serverId = "";

	private readonly STORAGE_KEY = 'comfyuix_active_downloads';

	private db = inject(ComfyUIDatabaseService);
	private dialog = inject(Dialog);
	private el = inject(ElementRef);

	readonly modelTypes = MODEL_TYPES;
	readonly allowedExtensions = ALLOWED_MODEL_EXTENSIONS;

	// Tabs
	activeTab = signal<"files" | "manifest">("files");
	selectedType = signal(MODEL_TYPES[0]);

	// Server info
	server = signal<ComfyServer | null>(null);
	tunnelConnected = signal(false);

	// File listing (Files tab)
	entries = signal<FsEntry[]>([]);
	filesLoading = signal(false);
	filesError = signal("");

	// Manifest
	manifest = signal<ServerModel[]>([]);

	// Manifest disk sync (Manifest tab)
	manifestSyncing = signal(false);
	manifestSyncError = signal("");
	diskFileSet = signal<Set<string>>(new Set());

	// Downloads in progress
	activeDownloads = signal<ActiveDownload[]>([]);

	// File info modal
	infoModal = signal<{ entry: FsEntry; fullPath: string } | null>(null);
	downloadQueue = signal<ServerModel[]>([]);
	queueRunning = signal(false);

	// Download dialog
	showDownloadDialog = signal(false);
	dlUrl = "";
	dlFolder = "";
	dlFilename = "";
	dlFilenameManuallySet = false;
	dlAddToManifest = true;
	dlError = "";
	dlSubmitting = false;

	// Quick track dialog
	showQuickTrackDialog = signal(false);
	quickTrackEntries: QuickTrackItem[] = [];
	quickTrackLoading = signal(false);
	quickTrackSubmitting = false;
	quickTrackError = "";

	// Import dialog
	showImportDialog = signal(false);
	importMode: "merge" | "replace" = "merge";
	importError = "";
	importSubmitting = false;
	importManifestData: { version: number; models: ServerModelInput[] } | null = null;
	importPreviewEntries: ImportPreviewEntry[] = [];
	importPreviewReady = false;

	// Add entry dialog (Manifest tab)
	showAddEntryDialog = signal(false);
	addEntryTypePath = MODEL_TYPES[0].path;
	addEntrySubfolder = "";
	addEntryFilename = "";
	addEntryFilenameManuallySet = false;
	addEntryUrl = "";
	addEntryDownloadNow = false;
	addEntryError = "";
	addEntrySubmitting = false;

	// Rename dialog (Manifest tab)
	showRenameDialog = signal(false);
	renameTarget: ServerModel | null = null;
	renameNewFilename = "";
	renameError = "";
	renameSubmitting = false;

	// Edit URL dialog (Manifest tab)
	showEditUrlDialog = signal(false);
	editUrlTarget: ServerModel | null = null;
	editUrlValue = "";
	editUrlError = "";
	editUrlSubmitting = false;

	// Add to manifest dialog (Files tab)
	pendingAddEntry = signal<FsEntry | null>(null);
	addManifestUrl = "";
	addManifestError = "";
	addManifestSubmitting = false;

	// Delete confirm (Files tab)
	pendingDelete = signal<{ entry: FsEntry; isFolder: boolean } | null>(null);
	deleteError = "";

	// Create folder (Files tab)
	showCreateFolderDialog = signal(false);
	newFolderName = "";
	newFolderError = "";
	newFolderSubmitting = false;

	ngOnInit() {
		this.db.getServers().subscribe({
			next: (servers) => {
				this.server.set(servers.find((s) => s.id === this.serverId) ?? null);
			},
		});
		this.db.getServerTunnelStatus(this.serverId, 0).subscribe({
			next: (res) => this.tunnelConnected.set(res.connected),
			error: () => {},
		});
		this.loadManifest();
		this.loadFiles();
		this.restoreActiveDownloads();
	}

	ngOnDestroy() {
		for (const dl of this.activeDownloads()) {
			dl.subscription?.unsubscribe();
		}
	}

	// ── Tabs ──────────────────────────────────────────────────────────────────────

	switchTab(tab: "files" | "manifest") {
		this.activeTab.set(tab);
		if (tab === "manifest") {
			this.syncDiskStatus();
		}
	}

	sidebarTypeClick(type: { label: string; path: string }) {
		if (this.activeTab() === "files") {
			this.selectType(type);
		} else {
			const id = `manifest-section-${type.path}`;
			const el = this.el.nativeElement.querySelector(`#${id}`);
			el?.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	}

	// ── File listing (Files tab) ──────────────────────────────────────────────────

	selectType(type: { label: string; path: string }) {
		this.selectedType.set(type);
		this.dlFolder = type.path;
		this.loadFiles();
	}

	loadFiles() {
		this.filesLoading.set(true);
		this.filesError.set("");
		this.db.listFiles(this.serverId, this.selectedType().path, true).subscribe({
			next: (entries) => {
				this.entries.set(entries);
				this.filesLoading.set(false);
			},
			error: (err) => {
				this.filesError.set(err?.error?.message ?? "Failed to load files");
				this.entries.set([]);
				this.filesLoading.set(false);
			},
		});
	}

	// ── Manifest ──────────────────────────────────────────────────────────────────

	loadManifest() {
		this.db.getServerModels(this.serverId).subscribe({
			next: (models) => this.manifest.set(models),
			error: () => {},
		});
	}

	/** Load all disk files for types present in the manifest, build a fast lookup set. */
	syncDiskStatus() {
		const typePaths = [...new Set(this.manifest().map((m) => m.dest.split("/")[0]))];
		if (typePaths.length === 0) {
			this.diskFileSet.set(new Set());
			return;
		}
		this.manifestSyncing.set(true);
		this.manifestSyncError.set("");
		forkJoin(typePaths.map((tp) => this.db.listFiles(this.serverId, tp, true))).subscribe({
			next: (results) => {
				const set = new Set<string>();
				typePaths.forEach((tp, i) =>
					results[i].filter((e) => e.type === "file").forEach((e) => set.add(`${tp}/${e.path}`)),
				);
				this.diskFileSet.set(set);
				this.manifestSyncing.set(false);
			},
			error: () => {
				this.manifestSyncError.set("Failed to sync file status from server.");
				this.manifestSyncing.set(false);
			},
		});
	}

	isDownloaded(m: ServerModel): boolean {
		return this.diskFileSet().has(m.dest);
	}

	isDownloading(dest: string): boolean {
		return this.activeDownloads().some((d) => d.dest === dest && !d.status.done && !d.status.error);
	}

	// ── File info modal ───────────────────────────────────────────────────────────

	openInfoModal(entry: FsEntry) {
		const fullPath = `${this.selectedType().path}/${entry.path}`;
		this.infoModal.set({ entry, fullPath });
	}

	getManifestEntry(entry: FsEntry): ServerModel | undefined {
		const dest = `${this.selectedType().path}/${entry.path}`;
		return this.manifest().find((m) => m.dest === dest);
	}


	/** Manifest entries grouped by model type, preserving MODEL_TYPES order. */
	manifestByType = computed(() => {
		const typeMap = new Map<string, string>(MODEL_TYPES.map((t) => [t.path, t.label]));
		const sections = new Map<string, { typePath: string; label: string; entries: ServerModel[] }>();
		for (const type of MODEL_TYPES) {
			sections.set(type.path, { typePath: type.path, label: type.label, entries: [] });
		}
		for (const m of this.manifest()) {
			const typePath = m.dest.split("/")[0];
			if (!sections.has(typePath)) {
				sections.set(typePath, { typePath, label: typeMap.get(typePath) ?? typePath, entries: [] });
			}
			sections.get(typePath)!.entries.push(m);
		}
		return [...sections.values()].filter((s) => s.entries.length > 0);
	});

	async removeManifestEntry(m: ServerModel) {
		const ok = await this.dialog.confirm(`Remove "${m.dest.split("/").pop()}" from the manifest? The file on disk will not be deleted.`);
		if (!ok) return;
		this.db.deleteServerModel(this.serverId, m.id).subscribe({
			next: () => this.loadManifest(),
		});
	}

	async deleteManifestFile(m: ServerModel) {
		const filename = m.dest.split("/").pop();
		const ok = await this.dialog.confirm(`Delete "${filename}" from disk? The manifest entry will be kept so it can be re-downloaded.`);
		if (!ok) return;
		this.db.deleteFile(this.serverId, m.dest).subscribe({
			next: () => {
				this.diskFileSet.update((s) => { const n = new Set(s); n.delete(m.dest); return n; });
				if (this.activeTab() === "files" && m.dest.startsWith(this.selectedType().path + "/")) {
					this.loadFiles();
				}
			},
			error: (err) => this.manifestSyncError.set(err?.error?.message ?? "Failed to delete file."),
		});
	}

	downloadManifestEntry(m: ServerModel) {
		const tempId = `pending-${Date.now()}`;
		this.activeDownloads.update((list) => [
			...list,
			{ fetchId: tempId, name: m.name, dest: m.dest, status: { percent: 0, done: false } },
		]);
		this.db.fetchFile(this.serverId, m.url, m.dest).subscribe({
			next: ({ fetchId }) => {
				this.activeDownloads.update((list) => list.filter((d) => d.fetchId !== tempId));
				this.startDownloadTracking(fetchId, m.name, m.dest);
			},
			error: (err) => {
				this.activeDownloads.update((list) =>
					list.map((d) =>
						d.fetchId === tempId
							? { ...d, status: { percent: 0, done: false, error: err?.error?.message ?? "Failed to start." } }
							: d,
					),
				);
			},
		});
	}

	// ── Rename (Manifest tab) ─────────────────────────────────────────────────────

	openRenameDialog(m: ServerModel) {
		this.renameTarget = m;
		this.renameNewFilename = m.dest.split("/").pop() ?? "";
		this.renameError = "";
		this.renameSubmitting = false;
		this.showRenameDialog.set(true);
	}

	submitRename() {
		const m = this.renameTarget;
		if (!m) return;
		const newFilename = this.renameNewFilename.trim();
		if (!newFilename) { this.renameError = "Filename is required."; return; }
		const parts = m.dest.split("/");
		parts[parts.length - 1] = newFilename;
		const newDest = parts.join("/");
		if (newDest === m.dest) { this.showRenameDialog.set(false); return; }
		this.renameError = "";
		this.renameSubmitting = true;

		const doUpdateEntry = () => {
			this.db.updateServerModel(this.serverId, m.id, {
				name: newFilename.replace(/\.[^.]+$/, ""),
				dest: newDest,
			}).subscribe({
				next: () => {
					this.renameSubmitting = false;
					this.showRenameDialog.set(false);
					this.loadManifest();
					this.syncDiskStatus();
				},
				error: (err) => {
					this.renameError = err?.error?.message ?? "Failed to update manifest entry.";
					this.renameSubmitting = false;
				},
			});
		};

		if (this.isDownloaded(m)) {
			this.db.renameFile(this.serverId, m.dest, newDest).subscribe({
				next: doUpdateEntry,
				error: (err) => {
					this.renameError = err?.error?.message ?? "Failed to rename file on disk.";
					this.renameSubmitting = false;
				},
			});
		} else {
			doUpdateEntry();
		}
	}

	// ── Edit URL (Manifest tab) ──────────────────────────────────────────────────

	openEditUrlDialog(m: ServerModel) {
		this.editUrlTarget = m;
		this.editUrlValue = m.url;
		this.editUrlError = "";
		this.editUrlSubmitting = false;
		this.showEditUrlDialog.set(true);
	}

	submitEditUrl() {
		const m = this.editUrlTarget;
		if (!m) return;
		const url = this.editUrlValue.trim();
		if (!url) { this.editUrlError = "URL is required."; return; }
		this.editUrlError = "";
		this.editUrlSubmitting = true;
		this.db.updateServerModel(this.serverId, m.id, { url, source: this.detectSource(url) }).subscribe({
			next: () => {
				this.editUrlSubmitting = false;
				this.showEditUrlDialog.set(false);
				this.loadManifest();
			},
			error: (err) => {
				this.editUrlError = err?.error?.message ?? "Failed to update URL.";
				this.editUrlSubmitting = false;
			},
		});
	}

	// ── Add entry (Manifest tab) ──────────────────────────────────────────────────

	openAddEntryDialog() {
		this.addEntryTypePath = MODEL_TYPES[0].path;
		this.addEntrySubfolder = "";
		this.addEntryFilename = "";
		this.addEntryFilenameManuallySet = false;
		this.addEntryUrl = "";
		this.addEntryDownloadNow = false;
		this.addEntryError = "";
		this.addEntrySubmitting = false;
		this.showAddEntryDialog.set(true);
	}

	addEntryDest(): string {
		const parts = [this.addEntryTypePath.trim()];
		if (this.addEntrySubfolder.trim()) parts.push(this.addEntrySubfolder.trim());
		const filename = this.addEntryFilename.trim() || this.inferFilename(this.addEntryUrl);
		if (filename) parts.push(filename);
		return parts.join("/");
	}

	onAddEntryUrlChange() {
		if (!this.addEntryFilenameManuallySet) {
			this.addEntryFilename = this.inferFilename(this.addEntryUrl);
		}
	}

	onAddEntryFilenameChange() {
		this.addEntryFilenameManuallySet = !!this.addEntryFilename.trim();
	}

	submitAddEntry() {
		const url = this.addEntryUrl.trim();
		if (!url) { this.addEntryError = "URL is required."; return; }
		const filename = this.addEntryFilename.trim() || this.inferFilename(url);
		if (!filename) { this.addEntryError = "Filename is required — cannot be inferred from URL."; return; }
		const dest = this.addEntryDest();
		this.addEntryError = "";
		this.addEntrySubmitting = true;
		const dto: ServerModelInput = {
			name: filename.replace(/\.[^.]+$/, ""),
			dest,
			source: this.detectSource(url),
			url,
		};
		this.db.createServerModel(this.serverId, dto).subscribe({
			next: () => {
				if (this.addEntryDownloadNow) {
					this.db.fetchFile(this.serverId, url, dest).subscribe({
						next: ({ fetchId }) => this.startDownloadTracking(fetchId, filename, dest),
					});
					const type = MODEL_TYPES.find((t) => t.path === this.addEntryTypePath);
					if (type) this.selectType(type);
					this.activeTab.set("files");
				}
				this.addEntrySubmitting = false;
				this.showAddEntryDialog.set(false);
				this.loadManifest();
			},
			error: (err) => {
				this.addEntryError = err?.error?.message ?? "Failed to add entry.";
				this.addEntrySubmitting = false;
			},
		});
	}

	// ── Files tab: manifest tracking ─────────────────────────────────────────────

	isSupported(entry: FsEntry): boolean {
		const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
		return ALLOWED_MODEL_EXTENSIONS.includes(ext);
	}

	private manifestEntryFor(entry: FsEntry) {
		const fullPath = `${this.selectedType().path}/${entry.path}`;
		return this.manifest().find((m) => m.dest === fullPath || m.dest === entry.path);
	}

	isTracked(entry: FsEntry): boolean {
		return !!this.manifestEntryFor(entry);
	}

	addToManifest(entry: FsEntry) {
		if (this.manifestEntryFor(entry)) return;
		this.addManifestUrl = "";
		this.addManifestError = "";
		this.addManifestSubmitting = false;
		this.pendingAddEntry.set(entry);
	}

	submitAddToManifest() {
		const entry = this.pendingAddEntry();
		if (!entry) return;
		const url = this.addManifestUrl.trim();
		if (!url) { this.addManifestError = "URL is required."; return; }
		this.addManifestError = "";
		this.addManifestSubmitting = true;
		const dest = `${this.selectedType().path}/${entry.path}`;
		this.db.createServerModel(this.serverId, {
			name: entry.name.replace(/\.[^.]+$/, ""),
			dest,
			source: this.detectSource(url),
			url,
		}).subscribe({
			next: () => {
				this.addManifestSubmitting = false;
				this.pendingAddEntry.set(null);
				this.loadManifest();
			},
			error: (err) => {
				this.addManifestError = err?.error?.message ?? "Failed to add to manifest.";
				this.addManifestSubmitting = false;
			},
		});
	}

	removeFromManifest(entry: FsEntry) {
		const model = this.manifestEntryFor(entry);
		if (!model) return;
		this.db.deleteServerModel(this.serverId, model.id).subscribe({
			next: () => this.loadManifest(),
		});
	}

	// ── Export ────────────────────────────────────────────────────────────────────

	exportManifest() {
		this.db.exportServerManifest(this.serverId).subscribe({
			next: (manifest) => {
				const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = `server-manifest-${this.serverId.slice(0, 8)}.json`;
				a.click();
				URL.revokeObjectURL(url);
			},
		});
	}

	// ── Import ────────────────────────────────────────────────────────────────────

	openImportDialog() {
		this.importManifestData = null;
		this.importPreviewEntries = [];
		this.importPreviewReady = false;
		this.importError = "";
		this.importMode = "merge";
		this.showImportDialog.set(true);
	}

	importFromFile(event: Event) {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!file) return;
		this.importError = "";
		this.importPreviewReady = false;
		const reader = new FileReader();
		reader.onload = (e) => {
			try {
				this.importManifestData = JSON.parse(e.target?.result as string);
				this.computeImportPreview();
			} catch {
				this.importError = "Invalid JSON.";
			}
		};
		reader.readAsText(file);
	}

	computeImportPreview() {
		const existing = new Set(this.manifest().map((m) => m.dest));
		const models = this.importManifestData?.models ?? [];
		this.importPreviewEntries = models.map((m) => ({
			model: m,
			status: existing.has(m.dest) ? "tracked" : "new",
			selected: !existing.has(m.dest),
		}));
		this.importPreviewReady = true;
	}

	importSelectedCount(): number {
		return this.importPreviewEntries.filter((e) => e.selected).length;
	}

	importSelectAll(selected: boolean) {
		this.importPreviewEntries.forEach((e) => { if (e.status !== "tracked") e.selected = selected; });
	}

	submitImport() {
		this.importError = "";
		this.importSubmitting = true;
		const selected = this.importPreviewEntries.filter((e) => e.selected);
		if (selected.length === 0) {
			this.importSubmitting = false;
			this.showImportDialog.set(false);
			return;
		}
		if (this.importMode === "replace") {
			this.db.importServerManifest(this.serverId, { version: 1, models: selected.map((e) => e.model) }, "replace").subscribe({
				next: () => {
					this.importSubmitting = false;
					this.showImportDialog.set(false);
					this.loadManifest();
				},
				error: (err) => {
					this.importError = err?.error?.message ?? "Import failed.";
					this.importSubmitting = false;
				},
			});
			return;
		}
		let remaining = selected.length;
		const onDone = () => {
			if (--remaining === 0) {
				this.importSubmitting = false;
				this.showImportDialog.set(false);
				this.loadManifest();
			}
		};
		for (const { model } of selected) {
			this.db.createServerModel(this.serverId, model).subscribe({ next: onDone, error: onDone });
		}
	}

	// ── Delete (Files tab) ────────────────────────────────────────────────────────

	confirmDelete(entry: FsEntry, isFolder = false) {
		this.deleteError = "";
		this.pendingDelete.set({ entry, isFolder });
	}

	submitDelete() {
		const pending = this.pendingDelete();
		if (!pending) return;
		const fullPath = `${this.selectedType().path}/${pending.entry.path}`;
		this.db.deleteFile(this.serverId, fullPath).subscribe({
			next: () => {
				this.pendingDelete.set(null);
				this.removeManifestEntriesForPath(fullPath, pending.isFolder);
				this.loadFiles();
				this.loadManifest();
			},
			error: (err) => { this.deleteError = err?.error?.message ?? "Delete failed."; },
		});
	}

	private removeManifestEntriesForPath(fullPath: string, isFolder: boolean) {
		const prefix = fullPath + "/";
		const toDelete = this.manifest().filter((m) =>
			isFolder ? (m.dest === fullPath || m.dest.startsWith(prefix)) : m.dest === fullPath,
		);
		for (const m of toDelete) {
			this.db.deleteServerModel(this.serverId, m.id).subscribe();
		}
	}

	// ── Create folder (Files tab) ─────────────────────────────────────────────────

	openCreateFolderDialog() {
		this.newFolderName = "";
		this.newFolderError = "";
		this.newFolderSubmitting = false;
		this.showCreateFolderDialog.set(true);
	}

	submitCreateFolder() {
		const name = this.newFolderName.trim();
		if (!name) { this.newFolderError = "Folder name is required."; return; }
		if (/[/\\]/.test(name)) { this.newFolderError = "Folder name cannot contain slashes."; return; }
		this.newFolderSubmitting = true;
		this.newFolderError = "";
		this.db.createFolder(this.serverId, `${this.selectedType().path}/${name}`).subscribe({
			next: () => {
				this.newFolderSubmitting = false;
				this.showCreateFolderDialog.set(false);
				this.loadFiles();
			},
			error: (err) => {
				this.newFolderError = err?.error?.message ?? "Failed to create folder.";
				this.newFolderSubmitting = false;
			},
		});
	}

	confirmDeleteFolder(folder: string) {
		this.deleteError = "";
		const pseudo: FsEntry = { name: folder || this.selectedType().path, path: folder, type: "directory", size: 0, mtime: null };
		this.pendingDelete.set({ entry: pseudo, isFolder: true });
	}

	// ── Download dialog ───────────────────────────────────────────────────────────

	openDownloadDialog() {
		this.dlUrl = "";
		this.dlFolder = this.selectedType().path;
		this.dlFilename = "";
		this.dlFilenameManuallySet = false;
		this.dlError = "";
		this.dlSubmitting = false;
		this.dlAddToManifest = true;
		this.showDownloadDialog.set(true);
	}

	detectSource(url: string): "huggingface" | "civitai" | "other" {
		if (url.startsWith("https://huggingface.co/")) return "huggingface";
		if (url.startsWith("https://civitai.com/")) return "civitai";
		return "other";
	}

	inferFilename(url: string): string {
		try {
			const pathname = new URL(url).pathname;
			const last = pathname.split("/").filter(Boolean).pop() ?? "";
			return last.includes(".") ? decodeURIComponent(last) : "";
		} catch {
			return "";
		}
	}

	dlFilenameHint(): string {
		if (this.dlFilename.trim()) return "";
		const inferred = this.inferFilename(this.dlUrl);
		return inferred ? `Will save as "${inferred}"` : "Required for CivitAI (filename cannot be inferred from URL)";
	}

	dlExtensionValid(): boolean {
		const filename = this.dlFilename.trim() || this.inferFilename(this.dlUrl);
		if (!filename) return true;
		const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
		return ALLOWED_MODEL_EXTENSIONS.includes(ext);
	}

	dlDestFull(): string {
		const folder = this.dlFolder.trim() || this.selectedType().path;
		const filename = this.dlFilename.trim() || this.inferFilename(this.dlUrl);
		return filename ? `${folder}/${filename}` : folder;
	}

	onDlUrlChange() {
		if (!this.dlFolder) this.dlFolder = this.selectedType().path;
		if (!this.dlFilenameManuallySet) this.dlFilename = this.inferFilename(this.dlUrl);
	}

	onDlFilenameChange() {
		this.dlFilenameManuallySet = !!this.dlFilename.trim();
	}

	private startDownloadTracking(fetchId: string, name: string, dest: string, onComplete?: () => void) {
		const download: ActiveDownload = { fetchId, name, dest, status: { percent: 0, done: false } };
		download.subscription = this.db.streamFetchStatus(this.serverId, fetchId).pipe(
			retry({ count: 3, delay: (_, i) => timer(5000 * i) }),
		).subscribe({
			next: (status: FetchStatus) => {
				this.activeDownloads.update((list) =>
					list.map((d) => (d.fetchId === fetchId ? { ...d, status } : d)),
				);
				if (status.done) {
					this.removeStoredDownload(fetchId);
					this.loadFiles();
					if (this.activeTab() === "manifest") this.syncDiskStatus();
					setTimeout(() => this.dismissDownload(fetchId), 5000);
					onComplete?.();
				}
			},
			error: () => {
				this.removeStoredDownload(fetchId);
				this.activeDownloads.update((list) =>
					list.map((d) =>
						d.fetchId === fetchId
							? { ...d, status: { percent: d.status.percent, done: false, error: "Could not reconnect. Dismiss if done." } }
							: d,
					),
				);
				onComplete?.();
			},
		});
		this.activeDownloads.update((list) => [...list, download]);
		this.saveStoredDownload(fetchId, name, dest);
	}

	private saveStoredDownload(fetchId: string, name: string, dest: string) {
		try {
			const stored = this.getStoredDownloads();
			if (!stored.find((d) => d.fetchId === fetchId)) {
				stored.push({ fetchId, serverId: this.serverId, name, dest });
				localStorage.setItem(this.STORAGE_KEY, JSON.stringify(stored));
			}
		} catch {}
	}

	private removeStoredDownload(fetchId: string) {
		try {
			const stored = this.getStoredDownloads().filter((d) => d.fetchId !== fetchId);
			localStorage.setItem(this.STORAGE_KEY, JSON.stringify(stored));
		} catch {}
	}

	private getStoredDownloads(): { fetchId: string; serverId: string; name: string; dest: string }[] {
		try {
			return JSON.parse(localStorage.getItem(this.STORAGE_KEY) ?? "[]");
		} catch {
			return [];
		}
	}

	private restoreActiveDownloads() {
		const stored = this.getStoredDownloads().filter((d) => d.serverId === this.serverId);
		for (const d of stored) {
			if (this.activeDownloads().find((a) => a.fetchId === d.fetchId)) continue;
			this.startDownloadTracking(d.fetchId, d.name, d.dest);
		}
	}

	submitDownload() {
		this.dlError = "";
		const dest = this.dlDestFull();
		if (!this.dlUrl) { this.dlError = "URL is required."; return; }
		if (!dest || !dest.includes("/") || dest.endsWith("/")) {
			this.dlError = "A filename is required — it could not be inferred from the URL.";
			return;
		}
		const name = dest.split("/").pop() || "Download";
		const dlUrl = this.dlUrl;
		const addToManifest = this.dlAddToManifest;
		this.dlSubmitting = true;
		this.showDownloadDialog.set(false);
		// Show immediate placeholder entry
		const tempId = `pending-${Date.now()}`;
		this.activeDownloads.update((list) => [
			...list,
			{ fetchId: tempId, name, dest, status: { percent: 0, done: false } },
		]);
		this.db.fetchFile(this.serverId, dlUrl, dest).subscribe({
			next: ({ fetchId }) => {
				this.dlSubmitting = false;
				this.activeDownloads.update((list) => list.filter((d) => d.fetchId !== tempId));
				if (addToManifest) {
					const dto: ServerModelInput = {
						name: dest.split("/").pop()?.replace(/\.[^.]+$/, "") || "Unknown",
						dest,
						source: this.detectSource(dlUrl),
						url: dlUrl,
					};
					this.db.createServerModel(this.serverId, dto).subscribe({ next: () => this.loadManifest() });
				}
				this.startDownloadTracking(fetchId, name, dest);
			},
			error: (err) => {
				this.dlSubmitting = false;
				this.activeDownloads.update((list) =>
					list.map((d) =>
						d.fetchId === tempId
							? { ...d, status: { percent: 0, done: false, error: err?.error?.message ?? "Failed to start." } }
							: d,
					),
				);
			},
		});
	}

	async cancelDownload(fetchId: string, name: string) {
		const confirmed = await this.dialog.confirm(`Cancel download of "${name}"?`);
		if (!confirmed) return;
		this.db.cancelFetch(this.serverId, fetchId).subscribe({ error: () => {} });
		this.dismissDownload(fetchId);
		this.removeStoredDownload(fetchId);
	}

	isQueued(dest: string): boolean {
		return this.downloadQueue().some((m) => m.dest === dest);
	}

	addToQueue(m: ServerModel) {
		if (!this.isQueued(m.dest)) {
			this.downloadQueue.update((q) => [...q, m]);
		}
	}

	removeFromQueue(dest: string) {
		this.downloadQueue.update((q) => q.filter((m) => m.dest !== dest));
	}

	startQueue() {
		if (this.queueRunning()) return;
		this.queueRunning.set(true);
		this.processNextInQueue();
	}

	stopQueue() {
		this.queueRunning.set(false);
	}

	private processNextInQueue() {
		if (!this.queueRunning()) return;
		const queue = this.downloadQueue();
		if (queue.length === 0) {
			this.queueRunning.set(false);
			return;
		}
		const next = queue[0];
		this.downloadQueue.update((q) => q.slice(1));
		const tempId = `pending-${Date.now()}`;
		this.activeDownloads.update((list) => [
			...list,
			{ fetchId: tempId, name: next.name, dest: next.dest, status: { percent: 0, done: false } },
		]);
		this.db.fetchFile(this.serverId, next.url, next.dest).subscribe({
			next: ({ fetchId }) => {
				this.activeDownloads.update((list) => list.filter((d) => d.fetchId !== tempId));
				this.startDownloadTracking(fetchId, next.name, next.dest, () => {
					this.processNextInQueue();
				});
			},
			error: (err) => {
				this.activeDownloads.update((list) =>
					list.map((d) =>
						d.fetchId === tempId
							? { ...d, status: { percent: 0, done: false, error: err?.error?.message ?? "Failed to start." } }
							: d,
					),
				);
				setTimeout(() => this.processNextInQueue(), 2000);
			},
		});
	}

	dismissDownload(fetchId: string) {
		this.activeDownloads.update((list) => {
			const dl = list.find((d) => d.fetchId === fetchId);
			dl?.subscription?.unsubscribe();
			return list.filter((d) => d.fetchId !== fetchId);
		});
		this.removeStoredDownload(fetchId);
	}

	// ── Quick track ───────────────────────────────────────────────────────────────

	openQuickTrackDialog() {
		this.quickTrackEntries = [];
		this.quickTrackError = "";
		this.quickTrackSubmitting = false;
		this.quickTrackLoading.set(true);
		this.showQuickTrackDialog.set(true);
		forkJoin(MODEL_TYPES.map((type) => this.db.listFiles(this.serverId, type.path, true))).subscribe({
			next: (results) => {
				const manifest = this.manifest();
				this.quickTrackEntries = MODEL_TYPES.flatMap((type, i) =>
					results[i]
						.filter((e) => e.type === "file" && this.isSupported(e))
						.flatMap((e) => {
							const fullPath = `${type.path}/${e.path}`;
							const tracked = manifest.some((m) => m.dest === fullPath || m.dest === e.path);
							if (tracked) return [];
							return [{ entry: e, typePath: type.path, typeLabel: type.label, url: "" }];
						}),
				);
				this.quickTrackLoading.set(false);
			},
			error: () => {
				this.quickTrackError = "Failed to load files from one or more folders.";
				this.quickTrackLoading.set(false);
			},
		});
	}

	quickTrackSections(): { typeLabel: string; typePath: string; groups: [string, QuickTrackItem[]][] }[] {
		const sectionMap = new Map<string, { typeLabel: string; groupMap: Map<string, QuickTrackItem[]> }>();
		for (const item of this.quickTrackEntries) {
			if (!sectionMap.has(item.typePath)) {
				sectionMap.set(item.typePath, { typeLabel: item.typeLabel, groupMap: new Map() });
			}
			const section = sectionMap.get(item.typePath)!;
			const parts = item.entry.path.split("/");
			const subfolder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
			if (!section.groupMap.has(subfolder)) section.groupMap.set(subfolder, []);
			section.groupMap.get(subfolder)!.push(item);
		}
		return [...sectionMap.entries()].map(([typePath, { typeLabel, groupMap }]) => ({
			typeLabel,
			typePath,
			groups: [...groupMap.entries()].sort((a, b) => a[0].localeCompare(b[0])),
		}));
	}

	quickTrackFilled(): number {
		return this.quickTrackEntries.filter((e) => e.url.trim()).length;
	}

	submitQuickTrack() {
		const toTrack = this.quickTrackEntries.filter((e) => e.url.trim());
		if (!toTrack.length) return;
		this.quickTrackSubmitting = true;
		this.quickTrackError = "";
		let remaining = toTrack.length;
		const onDone = () => {
			if (--remaining === 0) {
				this.quickTrackSubmitting = false;
				this.showQuickTrackDialog.set(false);
				this.loadManifest();
			}
		};
		for (const item of toTrack) {
			const url = item.url.trim();
			this.db.createServerModel(this.serverId, {
				name: item.entry.name.replace(/\.[^.]+$/, ""),
				dest: `${item.typePath}/${item.entry.path}`,
				source: this.detectSource(url),
				url,
			}).subscribe({ next: onDone, error: onDone });
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────────────

	formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	folderOptions = computed(() =>
		this.entriesByFolder().map(([folder]) => ({
			value: folder ? `${this.selectedType().path}/${folder}` : this.selectedType().path,
			label: folder ? `/${folder}` : ".",
		})),
	);

	entriesByFolder = computed(() => {
		const groups = new Map<string, FsEntry[]>();
		for (const entry of this.entries().filter((e) => e.type === "directory")) {
			if (!entry.path.includes("/") && !groups.has(entry.path)) {
				groups.set(entry.path, []);
			}
		}
		for (const entry of this.entries().filter((e) => e.type === "file")) {
			const parts = entry.path.split("/");
			const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
			if (!groups.has(folder)) groups.set(folder, []);
			groups.get(folder)!.push(entry);
		}
		return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	});
}
