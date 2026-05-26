import { Injectable } from "@nestjs/common";
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { IncomingMessage, ServerResponse } from "http";


interface PendingHttp {
	res: ServerResponse;
}

interface PendingWsSession {
	clientWs: WebSocket;
}

interface PendingFs {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
}

interface PendingHttpFetch {
	chunks: Buffer[];
	statusCode: number;
	responseHeaders: Record<string, string>;
	resolve: (value: { status: number; headers: Record<string, string>; body: Buffer }) => void;
	reject: (err: Error) => void;
}

export interface FetchStatus {
	percent: number;
	bytes?: number;
	done: boolean;
	error?: string;
}

class TunnelConnection {
	private pendingHttp = new Map<string, PendingHttp>();
	private pendingWs = new Map<string, PendingWsSession>();
	private pendingFs = new Map<string, PendingFs>();
	private pendingHttpFetch = new Map<string, PendingHttpFetch>();
	private fetchStatuses = new Map<string, FetchStatus>();
	private fetchListeners = new Map<string, Set<(status: FetchStatus) => void>>();
	private pingTimer: ReturnType<typeof setInterval>;
	private platform: string = 'linux';
	private version: string = '';
	private cachedComfyOs: string | null = null;

	constructor(
		public readonly serverId: string,
		private readonly ws: WebSocket,
		private readonly onClose: () => void,
	) {
		ws.on("message", (raw) => {
			try {
				this.onMessage(JSON.parse(raw.toString()));
			} catch {}
		});
		ws.on("close", () => {
			this.cleanup();
			onClose();
		});
		ws.on("error", () => ws.close());
		this.pingTimer = setInterval(() => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "ping" }));
			}
		}, 25_000);
	}

	private send(msg: object) {
		if (this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	private onMessage(msg: any) {
		switch (msg.type) {
			case "sidecar_info":
				this.platform = msg.platform ?? 'linux';
				this.version = msg.version ?? '';
				break;

			case "pong":
				break;

			case "http_response_head": {
				const p = this.pendingHttp.get(msg.requestId);
				if (p) {
					const headers = { ...(msg.headers ?? {}) };
					delete headers["transfer-encoding"];
					delete headers["connection"];
					p.res.writeHead(msg.status ?? 200, headers);
				}
				const pf = this.pendingHttpFetch.get(msg.requestId);
				if (pf) {
					pf.statusCode = msg.status ?? 200;
					pf.responseHeaders = msg.headers ?? {};
				}
				break;
			}

			case "http_chunk": {
				const p = this.pendingHttp.get(msg.requestId);
				if (p) p.res.write(Buffer.from(msg.data, "base64"));
				const pf = this.pendingHttpFetch.get(msg.requestId);
				if (pf) pf.chunks.push(Buffer.from(msg.data, "base64"));
				break;
			}

			case "http_end": {
				const p = this.pendingHttp.get(msg.requestId);
				if (p) {
					this.pendingHttp.delete(msg.requestId);
					p.res.end();
				}
				const pf = this.pendingHttpFetch.get(msg.requestId);
				if (pf) {
					this.pendingHttpFetch.delete(msg.requestId);
					pf.resolve({ status: pf.statusCode, headers: pf.responseHeaders, body: Buffer.concat(pf.chunks) });
				}
				break;
			}

			case "http_error": {
				const p = this.pendingHttp.get(msg.requestId);
				if (p) {
					this.pendingHttp.delete(msg.requestId);
					if (!p.res.headersSent) p.res.writeHead(502);
					p.res.end("Bad Gateway");
				}
				const pf = this.pendingHttpFetch.get(msg.requestId);
				if (pf) {
					this.pendingHttpFetch.delete(msg.requestId);
					pf.reject(new Error("Tunnel HTTP error"));
				}
				break;
			}

			case "ws_message": {
				const s = this.pendingWs.get(msg.tunnelId);
				if (!s || s.clientWs.readyState !== WebSocket.OPEN) break;
				const data = msg.isBinary
					? Buffer.from(msg.data, "base64")
					: msg.data;
				s.clientWs.send(data, { binary: !!msg.isBinary });
				break;
			}

			case "ws_closed": {
				const s = this.pendingWs.get(msg.tunnelId);
				if (!s) break;
				this.pendingWs.delete(msg.tunnelId);
				if (s.clientWs.readyState === WebSocket.OPEN) {
					s.clientWs.close(msg.code ?? 1000);
				}
				break;
			}

			case "fs_list_response":
			case "fs_delete_response":
			case "fs_mkdir_response":
			case "fs_rename_response":
			case "fs_meta_response": {
				const p = this.pendingFs.get(msg.requestId);
				if (!p) break;
				this.pendingFs.delete(msg.requestId);
				if (msg.error) p.reject(new Error(msg.error));
				else p.resolve(msg.meta ?? msg.entries ?? null);
				break;
			}

			case "fs_fetch_active": {
				for (const { fetchId, dest: _dest, percent } of msg.fetches ?? []) {
					if (!this.fetchStatuses.has(fetchId)) {
						this.fetchStatuses.set(fetchId, { percent: percent ?? 0, done: false });
					}
				}
				break;
			}

			case "fs_fetch_progress": {
				const status: FetchStatus = {
					percent: msg.percent ?? 0,
					bytes: msg.bytes,
					done: !!msg.done,
					error: msg.error,
				};
				this.fetchStatuses.set(msg.fetchId, status);
				const listeners = this.fetchListeners.get(msg.fetchId);
				if (listeners) {
					for (const cb of listeners) cb(status);
					if (status.done) {
						this.fetchListeners.delete(msg.fetchId);
					}
				}
				break;
			}
		}
	}

	proxyHttp(
		req: IncomingMessage,
		res: ServerResponse,
		path: string,
		bodyBuffer: Buffer | null,
	) {
		const requestId = randomUUID();
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { host, connection, "transfer-encoding": _te, origin: _origin, referer: _referer, ...headers } =
			req.headers as any;
		if (bodyBuffer) {
			headers["content-length"] = String(bodyBuffer.length);
		} else {
			delete headers["content-length"];
		}

		this.pendingHttp.set(requestId, { res });
		this.send({
			type: "http_request",
			requestId,
			method: req.method,
			path,
			headers,
			body: bodyBuffer ? bodyBuffer.toString("base64") : null,
		});
	}

	proxyWs(clientWs: WebSocket, path: string) {
		const tunnelId = randomUUID();
		this.pendingWs.set(tunnelId, { clientWs });
		this.send({ type: "ws_open", tunnelId, path });

		clientWs.on("message", (data, isBinary) => {
			this.send({
				type: "ws_message",
				tunnelId,
				data: isBinary
					? (data as Buffer).toString("base64")
					: data.toString(),
				isBinary,
			});
		});

		clientWs.on("close", (code) => {
			this.pendingWs.delete(tunnelId);
			this.send({ type: "ws_close", tunnelId, code });
		});

		clientWs.on("error", () => clientWs.close());
	}

	fetchHttp(
		method: string,
		path: string,
		headers: Record<string, string>,
		body: Buffer | null,
		timeoutMs = 30_000,
	): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
		const requestId = randomUUID();
		const allHeaders = { ...headers };
		if (body) allHeaders["content-length"] = String(body.length);

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingHttpFetch.delete(requestId);
				reject(new Error("Tunnel HTTP request timed out"));
			}, timeoutMs);

			this.pendingHttpFetch.set(requestId, {
				chunks: [],
				statusCode: 200,
				responseHeaders: {},
				resolve: (v) => { clearTimeout(timer); resolve(v); },
				reject: (e) => { clearTimeout(timer); reject(e); },
			});

			this.send({
				type: "http_request",
				requestId,
				method,
				path,
				headers: allHeaders,
				body: body ? body.toString("base64") : null,
			});
		});
	}

	close() {
		this.ws.close(1001, "Replaced by new connection");
	}

	private fsRequest<T>(msg: object, requestId: string, timeoutMs = 30_000): Promise<T> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingFs.delete(requestId);
				reject(new Error("Sidecar did not respond in time"));
			}, timeoutMs);
			this.pendingFs.set(requestId, {
				resolve: (v) => { clearTimeout(timer); resolve(v); },
				reject: (e) => { clearTimeout(timer); reject(e); },
			});
			this.send(msg);
		});
	}

	fsList(path: string, recursive = false, timeoutMs = 30_000): Promise<any[]> {
		const requestId = randomUUID();
		return this.fsRequest({ type: "fs_list", requestId, path, recursive }, requestId, timeoutMs);
	}

	fsDelete(path: string): Promise<void> {
		const requestId = randomUUID();
		return this.fsRequest({ type: "fs_delete", requestId, path }, requestId);
	}

	fsMkdir(path: string): Promise<void> {
		const requestId = randomUUID();
		return this.fsRequest({ type: "fs_mkdir", requestId, path }, requestId);
	}

	fsRename(from: string, to: string): Promise<void> {
		const requestId = randomUUID();
		return this.fsRequest({ type: "fs_rename", requestId, from, to }, requestId);
	}

	fsReadMeta(path: string): Promise<Record<string, any> | null> {
		const requestId = randomUUID();
		return this.fsRequest({ type: "fs_read_meta", requestId, path }, requestId, 10_000);
	}

	fsFetchUrl(fetchId: string, url: string, dest: string, headers: Record<string, string> = {}): void {
		this.fetchStatuses.set(fetchId, { percent: 0, done: false });
		this.send({ type: "fs_fetch_url", fetchId, url, dest, headers });
	}

	cancelFetch(fetchId: string): void {
		this.send({ type: "fs_fetch_cancel", fetchId });
		const status: FetchStatus = { percent: 0, done: true, error: "Cancelled" };
		this.fetchStatuses.set(fetchId, status);
		const listeners = this.fetchListeners.get(fetchId);
		if (listeners) {
			for (const cb of listeners) cb(status);
			this.fetchListeners.delete(fetchId);
		}
	}

	getOs(): 'linux' | 'windows' {
		return this.platform === 'win32' ? 'windows' : 'linux';
	}

	async getComfyOs(): Promise<'linux' | 'windows'> {
		if (this.cachedComfyOs !== null) {
			return this.cachedComfyOs === 'nt' || this.cachedComfyOs.includes('win') ? 'windows' : 'linux';
		}
		try {
			const res = await this.fetchHttp('GET', '/system_stats', {}, null, 5_000);
			if (res.status === 200) {
				const data = JSON.parse(res.body.toString());
				this.cachedComfyOs = (data?.system?.os ?? 'linux').toLowerCase();
			}
		} catch { /* ignore — fall through to linux default */ }
		this.cachedComfyOs ??= 'linux';
		return this.cachedComfyOs === 'nt' || this.cachedComfyOs.includes('win') ? 'windows' : 'linux';
	}

	getVersion(): string {
		return this.version;
	}


	getFetchStatus(fetchId: string): FetchStatus | undefined {
		return this.fetchStatuses.get(fetchId);
	}

	addFetchListener(fetchId: string, cb: (status: FetchStatus) => void) {
		if (!this.fetchListeners.has(fetchId)) {
			this.fetchListeners.set(fetchId, new Set());
		}
		this.fetchListeners.get(fetchId)!.add(cb);
	}

	removeFetchListener(fetchId: string, cb: (status: FetchStatus) => void) {
		this.fetchListeners.get(fetchId)?.delete(cb);
	}

	private cleanup() {
		clearInterval(this.pingTimer);
		for (const [, p] of this.pendingHttp) {
			if (!p.res.headersSent) p.res.writeHead(503);
			p.res.end("Tunnel disconnected");
		}
		this.pendingHttp.clear();
		for (const [, s] of this.pendingWs) {
			if (s.clientWs.readyState === WebSocket.OPEN) {
				s.clientWs.close(1001, "Tunnel disconnected");
			}
		}
		this.pendingWs.clear();
		for (const [, p] of this.pendingFs) {
			p.reject(new Error("Tunnel disconnected"));
		}
		this.pendingFs.clear();
		for (const [, pf] of this.pendingHttpFetch) {
			pf.reject(new Error("Tunnel disconnected"));
		}
		this.pendingHttpFetch.clear();
	}
}

export interface TunnelEvent {
	t: number;
	msg: string;
}

@Injectable()
export class TunnelService {
	/** Shared noServer WS server — reused for both tunnel and client WS upgrades. */
	readonly wss = new WebSocketServer({ noServer: true });

	private tunnels = new Map<string, TunnelConnection>();
	private events = new Map<string, TunnelEvent[]>();
	private readonly MAX_EVENTS = 100;

	emitEvent(serverId: string, msg: string) {
		const list = this.events.get(serverId) ?? [];
		list.push({ t: Date.now(), msg });
		if (list.length > this.MAX_EVENTS) list.shift();
		this.events.set(serverId, list);
	}

	getEventsSince(serverId: string, since: number): TunnelEvent[] {
		return (this.events.get(serverId) ?? []).filter((e) => e.t > since);
	}

	register(serverId: string, ws: WebSocket) {
		const existing = this.tunnels.get(serverId);
		if (existing) existing.close();

		const conn = new TunnelConnection(serverId, ws, () => {
			if (this.tunnels.get(serverId) === conn) {
				this.tunnels.delete(serverId);
			}
			const msg = `Sidecar disconnected for server ${serverId}`;
			console.log(`[Tunnel] ${msg}`);
			this.emitEvent(serverId, msg);
		});
		this.tunnels.set(serverId, conn);
		const msg = `Sidecar connected for server ${serverId}`;
		console.log(`[Tunnel] ${msg}`);
		this.emitEvent(serverId, msg);
	}

	hasTunnel(serverId: string): boolean {
		return this.tunnels.has(serverId);
	}

	getOs(serverId: string): 'linux' | 'windows' {
		return this.tunnels.get(serverId)?.getOs() ?? 'linux';
	}

	getComfyOs(serverId: string): Promise<'linux' | 'windows'> {
		return this.tunnels.get(serverId)?.getComfyOs() ?? Promise.resolve('linux');
	}

	getVersion(serverId: string): string {
		return this.tunnels.get(serverId)?.getVersion() ?? '';
	}


	proxyHttp(
		serverId: string,
		req: IncomingMessage,
		res: ServerResponse,
		path: string,
		bodyBuffer: Buffer | null,
	): boolean {
		const conn = this.tunnels.get(serverId);
		if (!conn) return false;
		conn.proxyHttp(req, res, path, bodyBuffer);
		return true;
	}

	proxyWs(serverId: string, clientWs: WebSocket, path: string): boolean {
		const conn = this.tunnels.get(serverId);
		if (!conn) return false;
		conn.proxyWs(clientWs, path);
		return true;
	}

	fetchHttp(
		serverId: string,
		method: string,
		path: string,
		headers: Record<string, string> = {},
		body: Buffer | null = null,
		timeoutMs?: number,
	): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
		const conn = this.tunnels.get(serverId);
		if (!conn) throw new Error("No tunnel connected for this server");
		return conn.fetchHttp(method, path, headers, body, timeoutMs);
	}

	fsList(serverId: string, path: string, recursive = false, timeoutMs = 30_000): Promise<any[]> {
		const conn = this.tunnels.get(serverId);
		if (!conn) throw new Error("No tunnel connected for this server");
		return conn.fsList(path, recursive, timeoutMs);
	}

	fsDelete(serverId: string, path: string): Promise<void> {
		const conn = this.tunnels.get(serverId);
		if (!conn) throw new Error("No tunnel connected for this server");
		return conn.fsDelete(path);
	}

	fsMkdir(serverId: string, path: string): Promise<void> {
		const conn = this.tunnels.get(serverId);
		if (!conn) throw new Error("No tunnel connected for this server");
		return conn.fsMkdir(path);
	}

	fsRename(serverId: string, from: string, to: string): Promise<void> {
		const conn = this.tunnels.get(serverId);
		if (!conn) throw new Error("No tunnel connected for this server");
		return conn.fsRename(from, to);
	}

	fsReadMeta(serverId: string, path: string): Promise<Record<string, any> | null> {
		const conn = this.tunnels.get(serverId);
		if (!conn) throw new Error("No tunnel connected for this server");
		return conn.fsReadMeta(path);
	}

	fsFetchUrl(serverId: string, fetchId: string, url: string, dest: string, headers: Record<string, string> = {}): void {
		const conn = this.tunnels.get(serverId);
		if (!conn) throw new Error("No tunnel connected for this server");
		conn.fsFetchUrl(fetchId, url, dest, headers);
	}

	getFetchStatus(serverId: string, fetchId: string): FetchStatus | undefined {
		return this.tunnels.get(serverId)?.getFetchStatus(fetchId);
	}

	cancelFetch(serverId: string, fetchId: string): void {
		this.tunnels.get(serverId)?.cancelFetch(fetchId);
	}

	addFetchListener(serverId: string, fetchId: string, cb: (status: FetchStatus) => void): boolean {
		const conn = this.tunnels.get(serverId);
		if (!conn) return false;
		conn.addFetchListener(fetchId, cb);
		return true;
	}

	removeFetchListener(serverId: string, fetchId: string, cb: (status: FetchStatus) => void) {
		this.tunnels.get(serverId)?.removeFetchListener(fetchId, cb);
	}
}
