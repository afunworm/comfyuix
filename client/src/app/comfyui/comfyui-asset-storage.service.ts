import { computed, inject, Injectable, signal } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { HttpClient } from "@angular/common/http";
import { ComfyUIDatabaseService } from "./comfyui-database.service";

export type ImageSourceKind = "input" | "output";

function filenameFromUrl(url: string): string {
	try {
		const u = new URL(url, "http://x");
		const name = u.searchParams.get("filename");
		if (name) return name;
	} catch {}
	return url.split("/").pop()?.split("?")[0] ?? "";
}

export interface StoredImageAsset {
	id: string;
	filename: string;
	url: string;
	subfolder?: string;
	type?: "input" | "output" | "temp";
	apiData?: string;
	promptPositive?: string;
	promptNegative?: string;
	seed?: string;
	folderId?: number | null;
	bookId?: string;
	createdAt: string;
	sourceAssetId?: number | null;
	layerData?: string | null;
}

export interface StoredFolder {
	id: number;
	name: string;
	type: "input" | "output";
	createdAt: string;
}

interface AssetCreateResponse {
	id: string;
	[key: string]: unknown;
}

@Injectable({ providedIn: "root" })
export class ImageAssetStorageService {
	private bookId: string | null = null;

	private readonly db = inject(ComfyUIDatabaseService);
	private readonly http = inject(HttpClient);

	readonly assets$ = signal<StoredImageAsset[]>([]);
	readonly folders$ = signal<StoredFolder[]>([]);

	readonly input$ = computed(() =>
		this.assets$().filter((a) => a.type !== "output"),
	);

	readonly output$ = computed(() =>
		this.assets$().filter((a) => a.type === "output"),
	);

	readonly inputFolders$ = computed(() =>
		this.folders$().filter((f) => f.type === "input"),
	);

	readonly outputFolders$ = computed(() =>
		this.folders$().filter((f) => f.type === "output"),
	);

	/**
	 * Must be called once before any other operations.
	 * Fetches the asset list from the API and seeds the in-memory signal.
	 *
	 * bookId is used for upload provenance; fetching is user-scoped.
	 * If bookId changes, clears the previous state first.
	 */
	async initialize(bookId?: string): Promise<void> {
		if (this.bookId !== null && this.bookId !== (bookId ?? null)) {
			this.assets$.set([]);
			this.folders$.set([]);
		}

		this.bookId = bookId ?? null;
		const [assets, folders] = await Promise.all([
			this.read(),
			this.readFolders(),
		]);
		this.assets$.set(assets);
		this.folders$.set(folders);
	}

	async addAsset(
		kind: ImageSourceKind,
		asset: Omit<StoredImageAsset, "id" | "createdAt"> & {
			id?: string;
			createdAt?: string;
		},
	): Promise<StoredImageAsset | undefined> {
		const filename = (asset.filename ?? "").trim();
		const url = (asset.url ?? "").trim();
		if (!filename || !url) return undefined;

		try {
			const response = await firstValueFrom(
				this.http.post<AssetCreateResponse>(`${this.getEndpoint()}/assets`, {
					url,
					type: kind,
					bookId: this.requireBookId(),
					apiData: asset.apiData,
					promptPositive: asset.promptPositive,
					promptNegative: asset.promptNegative,
					seed: asset.seed,
					sourceAssetId: asset.sourceAssetId ?? null,
					layerData: asset.layerData ?? null,
				}),
			);

			const normalized: StoredImageAsset = {
				id: response.id ?? asset.id ?? crypto.randomUUID(),
				filename,
				url,
				subfolder: asset.subfolder,
				type: kind,
				apiData: asset.apiData,
				promptPositive: asset.promptPositive,
				promptNegative: asset.promptNegative,
				seed: asset.seed,
				folderId: null,
				bookId: this.bookId ?? undefined,
				createdAt: asset.createdAt ?? new Date().toISOString(),
				sourceAssetId: asset.sourceAssetId ?? null,
				layerData: asset.layerData ?? null,
			};

			this.assets$.update((current) => [
				normalized,
				...current.filter((a) => a.id !== normalized.id),
			]);

			return normalized;
		} catch (err) {
			console.error("[ImageAssetStorageService] POST /assets failed:", err);
			return undefined;
		}
	}

	getAssetById(id: string): StoredImageAsset | undefined {
		return this.assets$().find((a) => a.id === id);
	}

	async removeAsset(id: string): Promise<void> {
		try {
			await firstValueFrom(this.http.delete(`${this.getEndpoint()}/assets/${id}`));
			this.assets$.update((current) => current.filter((a) => a.id !== id));
		} catch (err) {
			console.error("[ImageAssetStorageService] DELETE /assets/:id failed:", err);
		}
	}

	async moveAssetToFolder(
		assetId: string,
		folderId: number | null,
	): Promise<void> {
		try {
			await firstValueFrom(
				this.http.patch(`${this.getEndpoint()}/assets/${assetId}/folder`, {
					folderId,
				}),
			);
			this.assets$.update((current) =>
				current.map((a) => (a.id === assetId ? { ...a, folderId } : a)),
			);
		} catch (err) {
			console.error(
				"[ImageAssetStorageService] PATCH /assets/:id/folder failed:",
				err,
			);
		}
	}

	async createFolder(
		name: string,
		type: ImageSourceKind,
	): Promise<StoredFolder | undefined> {
		try {
			const raw = await firstValueFrom(
				this.http.post<any>(`${this.getEndpoint()}/folders`, { name, type, bookId: this.bookId }),
			);
			const folder = this.normalizeFolder(raw);
			this.folders$.update((current) =>
				[...current, folder].sort((a, b) => a.name.localeCompare(b.name)),
			);
			return folder;
		} catch (err) {
			console.error("[ImageAssetStorageService] POST /folders failed:", err);
			return undefined;
		}
	}

	async renameFolder(id: number, name: string): Promise<void> {
		try {
			const raw = await firstValueFrom(
				this.http.patch<any>(`${this.getEndpoint()}/folders/${id}`, { name }),
			);
			const updated = this.normalizeFolder(raw);
			this.folders$.update((current) =>
				current
					.map((f) => (f.id === id ? updated : f))
					.sort((a, b) => a.name.localeCompare(b.name)),
			);
		} catch (err) {
			console.error("[ImageAssetStorageService] PATCH /folders/:id failed:", err);
		}
	}

	async deleteFolder(id: number): Promise<void> {
		try {
			await firstValueFrom(
				this.http.delete(`${this.getEndpoint()}/folders/${id}`),
			);
			this.folders$.update((current) => current.filter((f) => f.id !== id));
			// Also remove all assets that belonged to this folder from local signal
			this.assets$.update((current) => current.filter((a) => a.folderId !== id));
		} catch (err) {
			console.error("[ImageAssetStorageService] DELETE /folders/:id failed:", err);
		}
	}

	private async read(): Promise<StoredImageAsset[]> {
		try {
			const raw = await firstValueFrom(
				this.http.get<any[]>(`${this.getEndpoint()}/assets`),
			);
			return raw.map((r) => ({
				id: String(r.id),
				filename: r.filename || filenameFromUrl(r.url),
				url: r.url,
				subfolder: r.subfolder,
				type: r.type,
				apiData: r.apiData ?? r.api_data ?? undefined,
				promptPositive: r.promptPositive ?? r.prompt_positive ?? undefined,
				promptNegative: r.promptNegative ?? r.prompt_negative ?? undefined,
				seed: r.seed ?? undefined,
				folderId: r.folder_id ?? null,
				bookId: r.book_id ?? undefined,
				createdAt: r.createdAt ?? r.created_at ?? new Date().toISOString(),
				sourceAssetId: r.source_asset_id ?? null,
				layerData: r.layer_data ?? null,
			}));
		} catch (err) {
			console.error("[ImageAssetStorageService] GET /assets failed:", err);
			return [];
		}
	}

	private async readFolders(): Promise<StoredFolder[]> {
		try {
			const params = this.bookId ? `?bookId=${encodeURIComponent(this.bookId)}` : '';
			const raw = await firstValueFrom(
				this.http.get<any[]>(`${this.getEndpoint()}/folders${params}`),
			);
			return raw.map((r) => this.normalizeFolder(r));
		} catch (err) {
			console.error("[ImageAssetStorageService] GET /folders failed:", err);
			return [];
		}
	}

	private normalizeFolder(r: any): StoredFolder {
		return {
			id: Number(r.id),
			name: r.name,
			type: r.type,
			createdAt: r.created_at ?? r.createdAt ?? new Date().toISOString(),
		};
	}

	private getEndpoint(): string {
		return this.db.httpEndpoint();
	}

	private requireBookId(): string {
		if (!this.bookId) {
			throw new Error(
				"[ImageAssetStorageService] bookId is not set. Call initialize(bookId) first.",
			);
		}
		return this.bookId;
	}
}
