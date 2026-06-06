import { Injectable, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { Observable, map, tap } from "rxjs";
import type { FlowConfig } from "../types/flow.type";
import type { ObjectInfo } from "./workflow-converter";
import { MultirunPreset } from "../pages/book/multirun.types";

export type SyncCleanEvent =
	| { phase: 'listing' }
	| { phase: 'deleting'; total: number; deleted: number }
	| { phase: 'done'; deleted: number; skipped: number }
	| { phase: 'error'; message: string };

export type SyncPurgeEvent =
	| { phase: 'listing' }
	| { phase: 'purging'; total: number; purged: number }
	| { phase: 'done'; purged: number; skipped: number }
	| { phase: 'error'; message: string };

export interface AdminUser {
	id: number;
	username: string;
	email: string;
	role: string;
	is_disabled: number;
	email_verified: number;
	created_at: string;
}

@Injectable({ providedIn: "root" })
export class ComfyUIDatabaseService {
	private readonly http = inject(HttpClient);

	private readonly apiBase = `${window.location.origin}/api`;

	wsProxiedEndpoint(bookId: string): string {
		const wsBase = this.apiBase.replace(/^https/, "wss").replace(/^http/, "ws");
		return `${wsBase}/proxy/${bookId}/ws`;
	}

	httpProxiedEndpoint(bookId: string): string {
		return `${this.apiBase}/proxy/${bookId}`;
	}

	httpEndpoint(): string {
		return this.apiBase;
	}

	loadConfigFromUrl(url: string): Observable<FlowConfig> {
		return this.http.get<FlowConfig>(url).pipe(
			map((cfg) => {
				this.verifyFlowConfig(cfg);
				return cfg;
			}),
		);
	}

	getFlows(bookId: string): Observable<FlowConfig[]> {
		const url = `${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}`;

		return this.http.get<{ flows: FlowConfig[] }>(url).pipe(
			map((resp) => {
				if (!resp.flows || !Array.isArray(resp.flows)) {
					throw new Error("Invalid response: missing 'flows' array.");
				}
				for (const flow of resp.flows) {
					this.verifyFlowConfig(flow);
				}
				return resp.flows;
			}),
		);
	}

	/**
	 * Throws an Error if the FlowConfig is invalid.
	 * Keep it strict so bad configs fail fast instead of failing later (aka "painfully").
	 */
	private verifyFlowConfig(cfg: FlowConfig): void {
		// -----------------------------
		// (1) Make sure a config must have id, name, configurables and apiData.
		// -----------------------------
		if (!cfg || typeof cfg !== "object") {
			throw new Error("FlowConfig is missing or not an object.");
		}
		if (!cfg.id || typeof cfg.id !== "string") {
			throw new Error("FlowConfig.id is required and must be a string.");
		}
		if (!cfg.name || typeof cfg.name !== "string") {
			throw new Error("FlowConfig.name is required and must be a string.");
		}
		if (!Array.isArray(cfg.configurables)) {
			throw new Error(
				"FlowConfig.configurables is required and must be an array.",
			);
		}
		if (cfg.apiData == null) {
			throw new Error("FlowConfig.apiData is required.");
		}

		// -----------------------------
		// (2) Config must have at least 1 templates.
		// -----------------------------
		if (!Array.isArray(cfg.templates) || cfg.templates.length < 1) {
			throw new Error(
				"FlowConfig.templates must be an array with at least 1 template.",
			);
		}

		// Build quick lookup for configurables
		const configurableById = new Map<
			string,
			(typeof cfg.configurables)[number]
		>();
		for (const c of cfg.configurables) {
			if (!c?.id || typeof c.id !== "string") {
				throw new Error("Every configurable must have a string id.");
			}
			configurableById.set(c.id, c);
		}

		// -----------------------------
		// (4) configurables must always have the id positivePrompt and seed.
		//     These should always be of type 'core'.
		// -----------------------------
		const pos = configurableById.get("positivePrompt");
		if (!pos) throw new Error("Missing required configurable: positivePrompt.");
		if (pos.type !== "core") {
			throw new Error("configurable 'positivePrompt' must be of type 'core'.");
		}

		const seed = configurableById.get("seed");
		if (!seed) throw new Error("Missing required configurable: seed.");
		if (seed.type !== "core") {
			throw new Error("configurable 'seed' must be of type 'core'.");
		}

		// -----------------------------
		// (5) configurables element must always have target that matches the path
		//     of at least 1 element inside apiData.
		//     Example valid paths: "/7/inputs/samples" or "/7/inputs/vae".
		// -----------------------------
		for (const c of cfg.configurables) {
			// Core configurables often don't map into apiData directly.
			if (c.type === "core") continue;

			if (!c.target || typeof c.target !== "string") {
				throw new Error(
					`configurable '${c.id}' must have a non-null target string (because it is not type 'core').`,
				);
			}

			if (!this.pathExists(cfg.apiData, c.target)) {
				throw new Error(
					`configurable '${c.id}' has target '${c.target}' which does not match any path in apiData.`,
				);
			}
		}

		// -----------------------------
		// (3) Each template must have id, name and changes. id must be unique.
		//     The first template must have its changes cover all the configId seen in configurables.
		// -----------------------------
		const seenTemplateIds = new Set<string>();
		for (const t of cfg.templates) {
			if (!t?.id || typeof t.id !== "string") {
				throw new Error("Each template must have a string id.");
			}
			if (seenTemplateIds.has(t.id)) {
				throw new Error(`Template id must be unique. Duplicate found: '${t.id}'.`);
			}
			seenTemplateIds.add(t.id);

			if (!t.name || typeof t.name !== "string") {
				throw new Error(`Template '${t.id}' is missing a valid name.`);
			}
			if (!Array.isArray(t.changes)) {
				throw new Error(`Template '${t.id}' is missing changes array.`);
			}
		}

		// First template must cover ALL configurable ids,
		// except:
		// - positivePrompt
		// - negativePrompt
		// - seed
		// - any configurable with type === "inputImage"
		const excludedIds = new Set(["positivePrompt", "negativePrompt", "seed"]);

		const first = cfg.templates[0];
		const firstChangeIds = new Set<string>(
			first.changes.map((ch) => ch?.configId).filter(Boolean),
		);

		for (const c of cfg.configurables) {
			// Skip excluded fixed ids
			if (excludedIds.has(c.id)) continue;

			// Skip image inputs, loras, and dimension types (not per-template values)
			if (
				c.type === "inputImage" ||
				c.type === "lora" ||
				c.type === "finalImageWidth" ||
				c.type === "finalImageHeight"
			)
				continue;

			if (!firstChangeIds.has(c.id)) {
				throw new Error(
					`First template '${first.id}' must include a change for configurable '${c.id}'. Template: ${first.id}`,
				);
			}
		}

		// -----------------------------
		// (6) In a template's 'changes', if its corresponding configId has type of 'preset',
		//     the 'value' field must be valid as one of the options of the 'presets'.
		// -----------------------------
		for (const t of cfg.templates) {
			for (const ch of t.changes) {
				if (!ch?.configId || typeof ch.configId !== "string") {
					throw new Error(`Template '${t.id}' has a change missing configId.`);
				}

				const c = configurableById.get(ch.configId);
				if (!c) {
					continue;
					// Silently discard extra changes from the server since it doesn't affect the frontend
					throw new Error(
						`Template '${t.id}' references configId '${ch.configId}' not found in configurables.`,
					);
				}

				if (c.type === "preset") {
					if (!Array.isArray(c.presets) || c.presets.length === 0) {
						throw new Error(
							`configurable '${c.id}' is type 'preset' but has no presets array.`,
						);
					}
					if (typeof ch.value !== "string" || !ch.value) {
						throw new Error(
							`Template '${t.id}' change for preset '${c.id}' must include a non-empty string value.`,
						);
					}
					if (!c.presets.includes(ch.value)) {
						throw new Error(
							`Template '${t.id}' change value '${ch.value}' is not in presets for configurable '${c.id}'.`,
						);
					}
				}
			}
		}
	}

	/**
	 * Checks whether a JSON-like object contains a given slash-path.
	 * Examples:
	 *  - "/7/inputs/samples"
	 *  - "7/inputs/vae" (leading slash optional)
	 */
	private pathExists(root: unknown, path: string): boolean {
		if (root == null) return false;
		if (typeof path !== "string" || !path.trim()) return false;

		const parts = path.split("/").filter(Boolean);
		if (!parts.length) return false;

		let cur: any = root;

		for (const part of parts) {
			if (cur == null) return false;

			// Array support: allow numeric indexes as path segments
			if (Array.isArray(cur)) {
				const idx = Number(part);
				if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return false;
				cur = cur[idx];
				continue;
			}

			// Object support
			if (typeof cur === "object") {
				if (!(part in cur)) return false;
				cur = cur[part];
				continue;
			}

			// If it's a primitive before finishing traversal, it's not a valid path
			return false;
		}

		// If we successfully traversed all segments, path exists
		return true;
	}

	getFlow(bookId: string, flowId: string): Observable<FlowConfig> {
		const url = `${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/flows/${encodeURIComponent(flowId)}`;
		return this.http.get<FlowConfig>(url).pipe(
			tap((cfg) => {
				// Remove created_at, book_id, id, updated_at from the response since they are not needed by the client
				delete (cfg as any).created_at;
				delete (cfg as any).updated_at;
				delete (cfg as any).book_id;
				delete (cfg as any).id;
			}),
		);
	}

	getModelList(bookId: string, modelName: string): Observable<string[]> {
		const url = `${this.httpProxiedEndpoint(bookId)}/models/${encodeURIComponent(modelName)}`;
		return this.http.get<string[]>(url);
	}

	getObjectInfo(bookId: string): Observable<ObjectInfo> {
		return this.http.get<ObjectInfo>(
			`${this.httpProxiedEndpoint(bookId)}/object_info`,
		);
	}

	getBookServerId(bookId: string): Observable<string | null> {
		return this.http
			.get<any>(`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}`)
			.pipe(map((resp) => resp.server_id ?? null));
	}

	createFlow(bookId: string, flow: FlowConfig): Observable<void> {
		const url = `${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/flows`;
		return this.http.post<void>(url, flow);
	}

	createBook(data: {
		name: string;
		description?: string;
		isPublic?: boolean;
		bookPassword?: string;
		serverId?: string | null;
	}): Observable<any> {
		return this.http.post(`${this.httpEndpoint()}/books`, {
			name: data.name,
			description: data.description ?? "",
			isPublic: data.isPublic ?? false,
			bookPassword: data.bookPassword ?? "",
			serverId: data.serverId ?? null,
		});
	}

	getSelfBooks(): Observable<any> {
		return this.http.get(`${this.httpEndpoint()}/books?self=true`);
	}

	updateFlow(
		bookId: string,
		flowId: string,
		flow: FlowConfig,
	): Observable<void> {
		const url = `${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/flows/${encodeURIComponent(flowId)}`;
		return this.http.put<void>(url, flow);
	}

	updateBook(
		bookId: string,
		data: {
			name: string;
			description?: string;
			isPublic?: boolean;
			bookPassword?: string;
			serverId?: string | null;
		},
	): Observable<any> {
		return this.http.put(`${this.httpEndpoint()}/books/${bookId}`, {
			name: data.name,
			description: data.description ?? "",
			isPublic: data.isPublic ?? false,
			bookPassword: data.bookPassword ?? "",
			serverId: data.serverId ?? null,
		});
	}

	getBookAssetCount(bookId: string): Observable<{ total: number }> {
		return this.http.get<{ total: number }>(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/asset-count`,
		);
	}

	deleteBook(bookId: string, withAssets = false): Observable<void> {
		const url = `${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}${withAssets ? '?withAssets=true' : ''}`;
		return this.http.delete<void>(url);
	}

	getOrphanedAssetCount(): Observable<{ total: number }> {
		return this.http.get<{ total: number }>(`${this.httpEndpoint()}/assets/orphaned`);
	}

	deleteOrphanedAssets(): Observable<{ deleted: number }> {
		return this.http.delete<{ deleted: number }>(`${this.httpEndpoint()}/assets/orphaned`);
	}

	cloneBook(bookId: string): Observable<any> {
		const url = `${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/clone`;
		return this.http.post(url, {});
	}

	/** For the book player — resolves book→server tunnel status server-side. */
	getTunnelStatus(
		bookId: string,
		since: number,
	): Observable<{
		connected: boolean;
		os: "linux" | "windows";
		tunnelVersion: string;
		events: { t: number; msg: string }[];
	}> {
		return this.http.get<{
			connected: boolean;
			os: "linux" | "windows";
			tunnelVersion: string;
			events: { t: number; msg: string }[];
		}>(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/tunnel-status?since=${since}`,
		);
	}

	// ── Multirun Presets ─────────────────────────────────────────────────────────

	getMultirunPresets(bookId: string): Observable<MultirunPreset[]> {
		return this.http.get<MultirunPreset[]>(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/multirun-presets`,
		);
	}

	createMultirunPreset(
		bookId: string,
		name: string,
		presetData: any,
	): Observable<MultirunPreset> {
		return this.http.post<MultirunPreset>(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/multirun-presets`,
			{ name, presetData },
		);
	}

	deleteMultirunPreset(
		bookId: string,
		id: string,
	): Observable<{ deleted: boolean }> {
		return this.http.delete<{ deleted: boolean }>(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/multirun-presets/${encodeURIComponent(id)}`,
		);
	}

	// ── Servers ──────────────────────────────────────────────────────────────────

	getServers(): Observable<ComfyServer[]> {
		return this.http.get<ComfyServer[]>(`${this.httpEndpoint()}/servers`);
	}

	createServer(data: { name: string }): Observable<ComfyServer> {
		return this.http.post<ComfyServer>(`${this.httpEndpoint()}/servers`, data);
	}

	updateServer(id: string, data: { name?: string }): Observable<ComfyServer> {
		return this.http.patch<ComfyServer>(
			`${this.httpEndpoint()}/servers/${id}`,
			data,
		);
	}

	deleteServer(id: string): Observable<void> {
		return this.http.delete<void>(`${this.httpEndpoint()}/servers/${id}`);
	}

	getServerTunnelStatus(
		serverId: string,
		since: number,
	): Observable<{ connected: boolean; events: { t: number; msg: string }[] }> {
		return this.http.get<{
			connected: boolean;
			events: { t: number; msg: string }[];
		}>(
			`${this.httpEndpoint()}/servers/${encodeURIComponent(serverId)}/tunnel-status?since=${since}`,
		);
	}

	getServerTunnelToken(
		serverId: string,
	): Observable<{ tunnelToken: string | null }> {
		return this.http.get<{ tunnelToken: string | null }>(
			`${this.httpEndpoint()}/servers/${encodeURIComponent(serverId)}/tunnel-token`,
		);
	}

	regenerateServerTunnelToken(
		serverId: string,
	): Observable<{ tunnelToken: string }> {
		return this.http.post<{ tunnelToken: string }>(
			`${this.httpEndpoint()}/servers/${encodeURIComponent(serverId)}/tunnel-token/regenerate`,
			{},
		);
	}

	revokeServerTunnelToken(serverId: string): Observable<void> {
		return this.http.patch<void>(
			`${this.httpEndpoint()}/servers/${encodeURIComponent(serverId)}/tunnel-token/revoke`,
			{},
		);
	}

	deleteFlow(bookId: string, flowId: string): Observable<void> {
		const url = `${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/flows/${encodeURIComponent(flowId)}`;
		return this.http.delete<void>(url);
	}

	getUsers(): Observable<AdminUser[]> {
		return this.http.get<AdminUser[]>(`${this.httpEndpoint()}/users`);
	}

	createUser(data: {
		username: string;
		email: string;
		password: string;
		role?: string;
	}): Observable<AdminUser> {
		return this.http.post<AdminUser>(`${this.httpEndpoint()}/users`, data);
	}

	updateUser(
		id: number,
		data: {
			username?: string;
			email?: string;
			role?: string;
			is_disabled?: number;
			password?: string;
		},
	): Observable<AdminUser> {
		return this.http.put<AdminUser>(`${this.httpEndpoint()}/users/${id}`, data);
	}

	deleteAdminUser(id: number): Observable<void> {
		return this.http.delete<void>(`${this.httpEndpoint()}/users/${id}`);
	}

	getSignupsEnabled(): Observable<{ enabled: boolean }> {
		return this.http.get<{ enabled: boolean }>(
			`${this.httpEndpoint()}/settings/signups-enabled`,
		);
	}

	updateSettings(data: {
		signupsEnabled?: boolean;
	}): Observable<{ signupsEnabled: boolean }> {
		return this.http.patch<{ signupsEnabled: boolean }>(
			`${this.httpEndpoint()}/settings`,
			data,
		);
	}

	// ── Quick Flows ─────────────────────────────────────────────────────────────

	getQuickFlows(): Observable<QuickFlowGroupWithFlows[]> {
		return this.http.get<QuickFlowGroupWithFlows[]>(
			`${this.httpEndpoint()}/quick-flows`,
		);
	}

	createQuickFlowGroup(name: string): Observable<QuickFlowGroup> {
		return this.http.post<QuickFlowGroup>(
			`${this.httpEndpoint()}/quick-flows/groups`,
			{ name },
		);
	}

	renameQuickFlowGroup(id: number, name: string): Observable<QuickFlowGroup> {
		return this.http.patch<QuickFlowGroup>(
			`${this.httpEndpoint()}/quick-flows/groups/${id}`,
			{ name },
		);
	}

	deleteQuickFlowGroup(id: number): Observable<void> {
		return this.http.delete<void>(
			`${this.httpEndpoint()}/quick-flows/groups/${id}`,
		);
	}

	createQuickFlow(data: {
		name: string;
		group_id?: number | null;
		api_data: string;
		image_node_id: string;
		seed_node_id?: string | null;
		positive_prompt_node_id?: string | null;
		preset_options?: string;
		ask_on_run?: string;
	}): Observable<QuickFlow> {
		return this.http.post<QuickFlow>(
			`${this.httpEndpoint()}/quick-flows/flows`,
			data,
		);
	}

	updateQuickFlow(
		id: number,
		data: {
			name?: string;
			group_id?: number | null;
			api_data?: string;
			image_node_id?: string;
			seed_node_id?: string | null;
			positive_prompt_node_id?: string | null;
			preset_options?: string;
			ask_on_run?: string;
		},
	): Observable<QuickFlow> {
		return this.http.patch<QuickFlow>(
			`${this.httpEndpoint()}/quick-flows/flows/${id}`,
			data,
		);
	}

	reorderQuickFlowGroups(ids: number[]): Observable<void> {
		return this.http.patch<void>(
			`${this.httpEndpoint()}/quick-flows/groups/reorder`,
			{ ids },
		);
	}

	reorderQuickFlows(ids: number[]): Observable<void> {
		return this.http.patch<void>(
			`${this.httpEndpoint()}/quick-flows/flows/reorder`,
			{ ids },
		);
	}

	deleteQuickFlow(id: number): Observable<void> {
		return this.http.delete<void>(
			`${this.httpEndpoint()}/quick-flows/flows/${id}`,
		);
	}

	// ── Account API tokens ───────────────────────────────────────────────────────

	getApiTokens(): Observable<{
		hfToken: string | null;
		civitaiToken: string | null;
	}> {
		return this.http.get<{ hfToken: string | null; civitaiToken: string | null }>(
			`${this.httpEndpoint()}/account/api-tokens`,
		);
	}

	setApiTokens(data: {
		hfToken?: string | null;
		civitaiToken?: string | null;
	}): Observable<{ hfToken: string | null; civitaiToken: string | null }> {
		return this.http.patch<{
			hfToken: string | null;
			civitaiToken: string | null;
		}>(`${this.httpEndpoint()}/account/api-tokens`, data);
	}

	// ── Server models (manifest) ─────────────────────────────────────────────────

	getServerModels(serverId: string): Observable<ServerModel[]> {
		return this.http.get<ServerModel[]>(
			`${this.httpEndpoint()}/server-models/${serverId}`,
		);
	}

	createServerModel(
		serverId: string,
		data: ServerModelInput,
	): Observable<ServerModel> {
		return this.http.post<ServerModel>(
			`${this.httpEndpoint()}/server-models/${serverId}`,
			data,
		);
	}

	updateServerModel(
		serverId: string,
		modelId: string,
		data: Partial<ServerModelInput>,
	): Observable<ServerModel> {
		return this.http.patch<ServerModel>(
			`${this.httpEndpoint()}/server-models/${serverId}/${modelId}`,
			data,
		);
	}

	deleteServerModel(serverId: string, modelId: string): Observable<void> {
		return this.http.delete<void>(
			`${this.httpEndpoint()}/server-models/${serverId}/${modelId}`,
		);
	}

	exportServerManifest(serverId: string): Observable<ServerManifest> {
		return this.http.get<ServerManifest>(
			`${this.httpEndpoint()}/server-models/${serverId}/export/manifest`,
		);
	}

	importServerManifest(
		serverId: string,
		manifest: ServerManifest,
		mode: "merge" | "replace" = "merge",
	): Observable<ServerModel[]> {
		return this.http.post<ServerModel[]>(
			`${this.httpEndpoint()}/server-models/${serverId}/import/manifest?mode=${mode}`,
			manifest,
		);
	}

	// ── Files API ────────────────────────────────────────────────────────────────

	listFiles(
		serverId: string,
		path: string,
		recursive = false,
	): Observable<FsEntry[]> {
		return this.http.get<FsEntry[]>(
			`${this.httpEndpoint()}/files/${serverId}/ls?path=${encodeURIComponent(path)}&recursive=${recursive}`,
		);
	}

	deleteFile(serverId: string, path: string): Observable<void> {
		return this.http.delete<void>(
			`${this.httpEndpoint()}/files/${serverId}?path=${encodeURIComponent(path)}`,
		);
	}

	createFolder(serverId: string, path: string): Observable<void> {
		return this.http.post<void>(
			`${this.httpEndpoint()}/files/${serverId}/mkdir`,
			{ path },
		);
	}

	renameFile(serverId: string, from: string, to: string): Observable<void> {
		return this.http.post<void>(
			`${this.httpEndpoint()}/files/${serverId}/rename`,
			{ from, to },
		);
	}

	getModelInfo(serverId: string, path: string): Observable<any> {
		return this.http.get<any>(
			`${this.httpEndpoint()}/files/${serverId}/model-info?path=${encodeURIComponent(path)}`,
		);
	}

	readFileMeta(
		serverId: string,
		path: string,
	): Observable<Record<string, any> | null> {
		return this.http.get<Record<string, any> | null>(
			`${this.httpEndpoint()}/files/${serverId}/meta?path=${encodeURIComponent(path)}`,
		);
	}

	fetchFile(
		serverId: string,
		url: string,
		dest: string,
	): Observable<{ fetchId: string }> {
		return this.http.post<{ fetchId: string }>(
			`${this.httpEndpoint()}/files/${serverId}/fetch`,
			{ url, dest },
		);
	}

	getFetchStatus(serverId: string, fetchId: string): Observable<FetchStatus> {
		return this.http.get<FetchStatus>(
			`${this.httpEndpoint()}/files/${serverId}/fetch-status/${fetchId}`,
		);
	}

	cancelFetch(serverId: string, fetchId: string): Observable<void> {
		return this.http.delete<void>(
			`${this.httpEndpoint()}/files/${serverId}/fetch/${fetchId}`,
		);
	}

	// ── Run endpoint ────────────────────────────────────────────────────────────

	runFlow(
		bookId: string,
		dto: {
			flowId: string;
			templateId?: string;
			overrides?: Record<string, string | number>;
		},
	): Observable<RunResult> {
		return this.http.post<RunResult>(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/run`,
			dto,
		);
	}

	submitFlow(
		bookId: string,
		dto: {
			flowId: string;
			templateId?: string;
			overrides?: Record<string, string | number>;
		},
	): Observable<{
		promptId: string;
		seed?: string;
		apiData: Record<string, any>;
	}> {
		return this.http.post<{
			promptId: string;
			seed?: string;
			apiData: Record<string, any>;
		}>(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/run/submit`,
			dto,
		);
	}

	submitFlowRaw(
		bookId: string,
		apiData: Record<string, any>,
	): Observable<{ promptId: string }> {
		return this.http.post<{ promptId: string }>(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/run/raw/submit`,
			{ apiData },
		);
	}

	waitFlowResult(
		bookId: string,
		promptId: string,
		meta?: { apiData?: string; promptPositive?: string; promptNegative?: string; seed?: string },
	): Observable<RunResult> {
		return this.http.post<RunResult>(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/run/wait/${encodeURIComponent(promptId)}`,
			meta ?? {},
		);
	}

	syncImport(bookId: string): Observable<{ created: number; skipped: number }> {
		return this.http.post<{ created: number; skipped: number }>(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/sync/import`,
			{},
		);
	}

	async *syncCleanStream(bookId: string): AsyncGenerator<SyncCleanEvent> {
		const token = localStorage.getItem('access_token');
		const response = await fetch(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/sync/clean`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'text/event-stream',
				},
			},
		);

		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const chunks = buffer.split('\n\n');
			buffer = chunks.pop()!;
			for (const chunk of chunks) {
				const line = chunk.trim();
				if (!line.startsWith('data: ')) continue;
				yield JSON.parse(line.slice(6)) as SyncCleanEvent;
			}
		}
	}

	async *syncPurgeStream(bookId: string): AsyncGenerator<SyncPurgeEvent> {
		const token = localStorage.getItem('access_token');
		const response = await fetch(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/sync/purge`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'text/event-stream',
				},
			},
		);

		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const chunks = buffer.split('\n\n');
			buffer = chunks.pop()!;
			for (const chunk of chunks) {
				const line = chunk.trim();
				if (!line.startsWith('data: ')) continue;
				yield JSON.parse(line.slice(6)) as SyncPurgeEvent;
			}
		}
	}

	getQueueStatus(
		bookId: string,
	): Observable<{ queue_running: any[]; queue_pending: any[] }> {
		return this.http.get<{ queue_running: any[]; queue_pending: any[] }>(
			`${this.httpProxiedEndpoint(bookId)}/queue`,
		);
	}

	runFlowRaw(
		bookId: string,
		apiData: Record<string, any>,
	): Observable<RunResult> {
		return this.http.post<RunResult>(
			`${this.httpEndpoint()}/books/${encodeURIComponent(bookId)}/run/raw`,
			{ apiData },
		);
	}

	streamFetchStatus(serverId: string, fetchId: string): Observable<FetchStatus> {
		const url = `${this.apiBase}/files/${serverId}/fetch-stream/${fetchId}`;
		const token = localStorage.getItem("access_token") ?? "";
		return new Observable<FetchStatus>((observer) => {
			const controller = new AbortController();
			fetch(url, {
				headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
				signal: controller.signal,
			})
				.then(async (res) => {
					if (!res.ok || !res.body) {
						observer.error(new Error(`SSE ${res.status}`));
						return;
					}
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							observer.complete();
							break;
						}
						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop()!;
						for (const line of lines) {
							if (line.startsWith("data: ")) {
								try {
									observer.next(JSON.parse(line.slice(6)));
								} catch {}
							}
						}
					}
				})
				.catch((err) => {
					if (err.name !== "AbortError") observer.error(err);
				});
			return () => controller.abort();
		});
	}
}

export interface QuickFlowGroup {
	id: number;
	name: string;
	sort_order: number;
	created_at: string;
}

export interface AskOnRunParam {
	id: string;
	label: string;
	type: "text" | "number";
	node_id: string;
	field: string;
	default: string;
}

export interface QuickFlow {
	id: number;
	group_id: number | null;
	name: string;
	api_data: string;
	image_node_id: string;
	seed_node_id: string | null;
	positive_prompt_node_id: string | null;
	preset_options: string;
	ask_on_run: string;
	sort_order: number;
	created_at: string;
	updated_at: string;
}

export interface QuickFlowGroupWithFlows extends QuickFlowGroup {
	flows: QuickFlow[];
}

export interface ComfyServer {
	id: string;
	name: string;
	created_at: string;
	updated_at: string;
}

export interface ServerModelInput {
	name: string;
	dest: string;
	source: "huggingface" | "civitai" | "other";
	url: string;
}

export interface ServerModel extends ServerModelInput {
	id: string;
	server_id: string;
	created_at: string;
}

export interface ServerManifest {
	version: number;
	models: ServerModelInput[];
}

// Legacy aliases kept for backward compatibility
export type BookModelInput = ServerModelInput;
export type BookModel = ServerModel;
export type BookManifest = ServerManifest;

export interface FsEntry {
	name: string;
	path: string;
	type: "file" | "directory";
	size: number;
	mtime: string | null;
}

export interface FetchStatus {
	percent: number;
	bytes?: number;
	done: boolean;
	error?: string;
}

export interface RunResult {
	promptId: string;
	filename: string;
	subfolder: string;
	type: string;
	viewPath: string;
	seed?: string;
	assetId?: number;
}
