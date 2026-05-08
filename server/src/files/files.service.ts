import {
	Injectable,
	NotFoundException,
	ForbiddenException,
	ServiceUnavailableException,
	BadRequestException,
	BadGatewayException,
} from "@nestjs/common";
import { Observable } from 'rxjs';
import { randomUUID } from "crypto";
import * as path from "path";
import { DatabaseService } from "../database/database.service";
import { TunnelService, FetchStatus } from "../tunnel/tunnel.service";
import { UsersService } from "../users/users.service";

export const ALLOWED_MODEL_EXTENSIONS = new Set([
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
]);

@Injectable()
export class FilesService {
	private readonly db;

	constructor(
		private readonly databaseService: DatabaseService,
		private readonly tunnelService: TunnelService,
		private readonly usersService: UsersService,
	) {
		this.db = databaseService.db;
	}

	private assertServer(serverId: string, userId: number) {
		const server = this.db
			.prepare("SELECT id, user_id FROM server WHERE id = ?")
			.get(serverId) as any;
		if (!server) throw new NotFoundException("Server not found");
		if (server.user_id !== userId) throw new ForbiddenException("You do not own this server");
		if (!this.tunnelService.hasTunnel(serverId))
			throw new ServiceUnavailableException("No tunnel connected for this server");
	}

	private validateRelPath(path: string) {
		if (path.includes("..")) throw new BadRequestException("Invalid path");
	}

	private async tunnel<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (e: any) {
			throw new BadGatewayException(e.message ?? "Sidecar error");
		}
	}

	list(serverId: string, userId: number, relPath: string, recursive = false) {
		this.assertServer(serverId, userId);
		this.validateRelPath(relPath);
		return this.tunnel(() => this.tunnelService.fsList(serverId, relPath, recursive));
	}

	delete(serverId: string, userId: number, path: string) {
		this.assertServer(serverId, userId);
		this.validateRelPath(path);
		return this.tunnel(() => this.tunnelService.fsDelete(serverId, path));
	}

	mkdir(serverId: string, userId: number, path: string) {
		this.assertServer(serverId, userId);
		this.validateRelPath(path);
		return this.tunnel(() => this.tunnelService.fsMkdir(serverId, path));
	}

	rename(serverId: string, userId: number, from: string, to: string) {
		this.assertServer(serverId, userId);
		this.validateRelPath(from);
		this.validateRelPath(to);
		return this.tunnel(() => this.tunnelService.fsRename(serverId, from, to));
	}

	startFetch(serverId: string, userId: number, url: string, dest: string): { fetchId: string } {
		this.assertServer(serverId, userId);
		this.validateRelPath(dest);
		const ext = path.extname(dest).toLowerCase();
		if (!ALLOWED_MODEL_EXTENSIONS.has(ext)) {
			throw new BadRequestException(
				`File extension "${ext || "(none)"}" is not allowed. Allowed: ${[...ALLOWED_MODEL_EXTENSIONS].join(", ")}`,
			);
		}
		const fetchId = randomUUID();
		const { url: authUrl, headers } = this.applyAuth(userId, url);
		this.tunnelService.fsFetchUrl(serverId, fetchId, authUrl, dest, headers);
		return { fetchId };
	}

	private applyAuth(userId: number, url: string): { url: string; headers: Record<string, string> } {
		const { hfToken, civitaiToken } = this.usersService.getApiTokens(userId);
		if (url.startsWith("https://huggingface.co/") && hfToken) {
			return { url, headers: { Authorization: `Bearer ${hfToken}` } };
		}
		if (url.startsWith("https://civitai.com/") && civitaiToken) {
			const sep = url.includes("?") ? "&" : "?";
			return { url: `${url}${sep}token=${civitaiToken}`, headers: {} };
		}
		return { url, headers: {} };
	}

	getFetchStatus(serverId: string, userId: number, fetchId: string): FetchStatus {
		this.assertServer(serverId, userId);
		const status = this.tunnelService.getFetchStatus(serverId, fetchId);
		if (!status) throw new NotFoundException("Fetch job not found");
		return status;
	}

	readMeta(serverId: string, userId: number, path: string): Promise<Record<string, any> | null> {
		this.assertServer(serverId, userId);
		this.validateRelPath(path);
		return this.tunnel(() => this.tunnelService.fsReadMeta(serverId, path));
	}

	async getModelInfo(serverId: string, userId: number, path: string): Promise<any> {
		const server = this.db
			.prepare("SELECT id, user_id FROM server WHERE id = ?")
			.get(serverId) as any;
		if (!server) throw new NotFoundException("Server not found");
		if (server.user_id !== userId) throw new ForbiddenException("You do not own this server");

		const model = this.db
			.prepare("SELECT * FROM server_model WHERE server_id = ? AND dest = ?")
			.get(serverId, path) as any;

		if (!model) return { source: "unknown" };

		const { hfToken, civitaiToken } = this.usersService.getApiTokens(userId);

		if (model.source === "civitai") {
			const match = model.url.match(/\/api\/download\/models\/(\d+)/);
			if (!match) return { source: "civitai", error: "Could not parse model version ID from URL" };
			const modelVersionId = match[1];
			try {
				const headers: Record<string, string> = {};
				if (civitaiToken) headers["Authorization"] = `Bearer ${civitaiToken}`;
				const res = await fetch(`https://civitai.com/api/v1/model-versions/${modelVersionId}`, { headers });
				if (!res.ok) throw new Error(`CivitAI API returned ${res.status}`);
				return { source: "civitai", data: await res.json() };
			} catch (e: any) {
				return { source: "civitai", error: e.message };
			}
		}

		if (model.source === "huggingface") {
			const match = model.url.match(/huggingface\.co\/([^/]+\/[^/]+)\/resolve\//);
			if (!match) return { source: "huggingface", error: "Could not parse repo from URL" };
			const repo = match[1];
			try {
				const headers: Record<string, string> = {};
				if (hfToken) headers["Authorization"] = `Bearer ${hfToken}`;
				const res = await fetch(`https://huggingface.co/api/models/${repo}`, { headers });
				if (!res.ok) throw new Error(`HuggingFace API returned ${res.status}`);
				return { source: "huggingface", data: await res.json() };
			} catch (e: any) {
				return { source: "huggingface", error: e.message };
			}
		}

		return { source: model.source ?? "other" };
	}

	cancelFetch(serverId: string, userId: number, fetchId: string): void {
		const server = this.db
			.prepare("SELECT id, user_id FROM server WHERE id = ?")
			.get(serverId) as any;
		if (!server) throw new NotFoundException("Server not found");
		if (server.user_id !== userId) throw new ForbiddenException("You do not own this server");
		this.tunnelService.cancelFetch(serverId, fetchId);
	}

	streamFetch(serverId: string, userId: number, fetchId: string): Observable<FetchStatus> {
		this.assertServer(serverId, userId);
		return new Observable<FetchStatus>((observer) => {
			const current = this.tunnelService.getFetchStatus(serverId, fetchId);
			if (!current) {
				observer.error(new NotFoundException("Fetch job not found"));
				return;
			}
			observer.next(current);
			if (current.done) {
				observer.complete();
				return;
			}
			const cb = (status: FetchStatus) => {
				observer.next(status);
				if (status.done) observer.complete();
			};
			this.tunnelService.addFetchListener(serverId, fetchId, cb);
			return () => {
				this.tunnelService.removeFetchListener(serverId, fetchId, cb);
			};
		});
	}
}
