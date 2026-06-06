import { Injectable, NotFoundException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { TunnelService } from '../tunnel/tunnel.service';
import { AssetsService } from '../assets/assets.service';

export class RunDto {
	flowId: string;
	templateId?: string;
	overrides?: Record<string, string | number>;
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

export interface RunStatus {
	state: 'pending' | 'done' | 'error';
	result?: RunResult;
	error?: string;
}

/** Keys whose string values use / as a semantic separator, not a file path. */
const PATH_EXEMPT_KEYS = /sampler|scheduler/i;

@Injectable()
export class RunService {
	private readonly db;

	constructor(
		databaseService: DatabaseService,
		private readonly tunnelService: TunnelService,
		private readonly assetsService: AssetsService,
	) {
		this.db = databaseService.db;
	}

	async run(bookId: string, dto: RunDto): Promise<RunResult> {
		const { serverId, promptId, seed } = await this.buildAndSubmit(bookId, dto);
		return this.finishRun(bookId, serverId, promptId, seed);
	}

	async submit(bookId: string, dto: RunDto): Promise<{ promptId: string; seed?: string; apiData: Record<string, any> }> {
		const { promptId, seed, apiData } = await this.buildAndSubmit(bookId, dto);
		return { promptId, seed, apiData };
	}

	async waitResult(
		bookId: string,
		promptId: string,
		userId?: number,
		meta?: { apiData?: string; promptPositive?: string; promptNegative?: string; seed?: string },
	): Promise<RunResult> {
		const book = this.db
			.prepare('SELECT server_id FROM book WHERE id = ?')
			.get(bookId) as any;
		if (!book) throw new NotFoundException('Book not found');

		const serverId: string | null = book.server_id ?? null;
		if (!serverId || !this.tunnelService.hasTunnel(serverId)) {
			throw new ServiceUnavailableException('No tunnel connected for this book');
		}

		const result = await this.finishRun(bookId, serverId, promptId);

		if (userId) {
			const asset = this.assetsService.create(userId, {
				url: result.viewPath,
				type: 'output',
				bookId,
				apiData: meta?.apiData,
				promptPositive: meta?.promptPositive,
				promptNegative: meta?.promptNegative,
				seed: meta?.seed,
			}) as any;
			return { ...result, assetId: asset?.id as number | undefined };
		}

		return result;
	}

	async uploadImage(
		bookId: string,
		body: Buffer,
		contentType: string,
		userId?: number,
	): Promise<{ name: string; subfolder: string; type: string; url: string }> {
		const book = this.db
			.prepare('SELECT server_id FROM book WHERE id = ?')
			.get(bookId) as any;
		if (!book) throw new NotFoundException('Book not found');

		const serverId: string | null = book.server_id ?? null;
		if (!serverId || !this.tunnelService.hasTunnel(serverId)) {
			throw new ServiceUnavailableException('No tunnel connected for this book');
		}

		const res = await this.tunnelService.fetchHttp(
			serverId, 'POST', '/upload/image',
			{ 'content-type': contentType, 'content-length': String(body.length) },
			body, 30_000,
		);

		if (res.status !== 200) {
			throw new BadRequestException(`ComfyUI upload failed (${res.status}): ${res.body.toString().slice(0, 200)}`);
		}

		let parsed: any;
		try { parsed = JSON.parse(res.body.toString()); } catch {
			throw new BadRequestException('ComfyUI returned invalid upload response');
		}

		const name: string = parsed.name;
		const subfolder: string = parsed.subfolder ?? '';
		const type: string = parsed.type ?? 'input';
		const subfolderPart = subfolder ? `&subfolder=${encodeURIComponent(subfolder)}` : '';
		const url = `/proxy/${bookId}/view?filename=${encodeURIComponent(name)}${subfolderPart}&type=${type}`;

		// Register asset so it appears in the gallery
		if (userId) {
			await this.assetsService.create(userId, { url, type: 'input', bookId });
		}

		return { name, subfolder, type, url };
	}

	async getStatus(bookId: string, promptId: string): Promise<RunStatus> {
		const book = this.db
			.prepare('SELECT server_id FROM book WHERE id = ?')
			.get(bookId) as any;
		if (!book) throw new NotFoundException('Book not found');

		const serverId: string | null = book.server_id ?? null;
		if (!serverId || !this.tunnelService.hasTunnel(serverId)) {
			throw new ServiceUnavailableException('No tunnel connected for this book');
		}

		let res: { status: number; body: Buffer };
		try {
			res = await this.tunnelService.fetchHttp(
				serverId, 'GET', `/history/${encodeURIComponent(promptId)}`, {}, null, 10_000,
			);
		} catch {
			return { state: 'pending' };
		}

		if (res.status !== 200) return { state: 'pending' };

		let data: any;
		try { data = JSON.parse(res.body.toString()); } catch { return { state: 'pending' }; }
		if (!data[promptId]) return { state: 'pending' };

		const entry = data[promptId];
		const errorRaw = entry.status?.messages?.find(([t]: any) => t === 'execution_error')?.[1];
		if (errorRaw) {
			const error: string = errorRaw.exception_message ?? JSON.stringify(errorRaw);
			return { state: 'error', error };
		}

		const images: { filename: string; subfolder: string; type: string }[] = [];
		for (const output of Object.values(entry.outputs ?? {}) as any[]) {
			if (output.images?.length) images.push(...output.images);
		}
		if (!images.length) return { state: 'pending' };

		const img = images[0];
		const subfolderPart = img.subfolder ? `&subfolder=${encodeURIComponent(img.subfolder)}` : '';
		const viewPath = `/proxy/${bookId}/view?filename=${encodeURIComponent(img.filename)}${subfolderPart}&type=${img.type ?? 'output'}`;

		return {
			state: 'done',
			result: { promptId, filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output', viewPath },
		};
	}

	private async buildAndSubmit(
		bookId: string,
		dto: RunDto,
	): Promise<{ serverId: string; promptId: string; seed?: string; apiData: Record<string, any> }> {
		// 1. Resolve book → serverId
		const book = this.db
			.prepare('SELECT server_id FROM book WHERE id = ?')
			.get(bookId) as any;
		if (!book) throw new NotFoundException('Book not found');

		const serverId: string | null = book.server_id ?? null;
		if (!serverId || !this.tunnelService.hasTunnel(serverId)) {
			throw new ServiceUnavailableException('No tunnel connected for this book');
		}

		// 2. Load flow
		const row = this.db
			.prepare('SELECT flow_data FROM flow WHERE id = ? AND book_id = ?')
			.get(dto.flowId, bookId) as any;
		if (!row) throw new NotFoundException('Flow not found');

		const flow = JSON.parse(row.flow_data);
		const configurables: any[] = flow.configurables ?? [];
		const templates: any[] = flow.templates ?? [];

		// 3. Resolve template
		const templateId = dto.templateId ?? templates[0]?.id;
		const template = templates.find((t: any) => t.id === templateId);

		// 4. Deep-clone apiData and apply patches
		let apiData = structuredClone(flow.apiData);

		// Apply template changes first
		if (template?.changes) {
			for (const change of template.changes) {
				const cfg = configurables.find((c: any) => c.id === change.configId);
				if (cfg?.target && change.value !== undefined) {
					this.setAtPath(apiData, cfg.target, change.value);
				}
			}
		}

		// Apply caller overrides
		if (dto.overrides) {
			for (const [cfgId, value] of Object.entries(dto.overrides)) {
				const cfg = configurables.find((c: any) => c.id === cfgId);
				if (cfg?.target) {
					this.setAtPath(apiData, cfg.target, value);
				}
			}
		}

		// 5. Prefix filename_prefix with bookId (avoids collisions across books)
		for (const node of Object.values(apiData) as any[]) {
			if (node?.inputs?.filename_prefix !== undefined) {
				node.inputs.filename_prefix = `${bookId}-${node.inputs.filename_prefix}`;
			}
		}

		// Snapshot apiData before OS-specific path conversion — this is what gets stored for rerun
		const portableApiData = structuredClone(apiData);

		// Extract seed before path conversion (value is the same either way)
		const seedCfg = configurables.find((c: any) => c.id === 'seed');
		let seed: string | undefined;
		if (seedCfg?.target) {
			const val = this.getAtPath(apiData, seedCfg.target);
			if (val !== undefined) seed = String(val);
		}

		// 6. Apply Windows path fix if needed
		const os = await this.tunnelService.getComfyOs(serverId);
		console.log(`[Run] serverId=${serverId} comfyOs=${os}`);
		if (os === 'windows') {
			apiData = this.applyWindowsPaths(apiData);
		}

		// 7. POST to /prompt
		const promptBody = Buffer.from(JSON.stringify({ prompt: apiData }));
		const promptRes = await this.tunnelService.fetchHttp(
			serverId, 'POST', '/prompt', { 'content-type': 'application/json' }, promptBody, 15_000,
		);

		if (promptRes.status !== 200) this.throwPromptError(promptRes.status, promptRes.body);

		const promptData = JSON.parse(promptRes.body.toString());
		const promptId: string = promptData.prompt_id;
		if (!promptId) throw new BadRequestException('ComfyUI did not return a prompt_id');

		return { serverId, promptId, seed, apiData: portableApiData };
	}

	private async finishRun(
		bookId: string,
		serverId: string,
		promptId: string,
		seed?: string,
	): Promise<RunResult> {
		const { images, errorMsg } = await this.pollHistory(serverId, promptId);

		if (errorMsg) { console.error(`[Run] ComfyUI execution error: ${errorMsg}`); throw new BadRequestException(`ComfyUI error: ${errorMsg}`); }
		if (!images.length) throw new BadRequestException('Job completed but produced no images');

		const img = images[0];
		const subfolderPart = img.subfolder ? `&subfolder=${encodeURIComponent(img.subfolder)}` : '';
		const viewPath = `/proxy/${bookId}/view?filename=${encodeURIComponent(img.filename)}${subfolderPart}&type=${img.type ?? 'output'}`;

		return { promptId, filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output', viewPath, seed };
	}

	async runRaw(bookId: string, dto: { apiData: Record<string, any> }): Promise<RunResult> {
		const { serverId, promptId } = await this.submitRawInternal(bookId, dto.apiData);
		return this.finishRun(bookId, serverId, promptId);
	}

	async submitRaw(bookId: string, dto: { apiData: Record<string, any> }): Promise<{ promptId: string }> {
		const { promptId } = await this.submitRawInternal(bookId, dto.apiData);
		return { promptId };
	}

	private async submitRawInternal(bookId: string, inputApiData: Record<string, any>): Promise<{ serverId: string; promptId: string }> {
		const book = this.db
			.prepare('SELECT server_id FROM book WHERE id = ?')
			.get(bookId) as any;
		if (!book) throw new NotFoundException('Book not found');

		const serverId: string | null = book.server_id ?? null;
		if (!serverId || !this.tunnelService.hasTunnel(serverId)) {
			throw new ServiceUnavailableException('No tunnel connected for this book');
		}

		// Apply Windows path fix (no filename_prefix step — caller already handled it)
		let apiData = structuredClone(inputApiData);
		const os = await this.tunnelService.getComfyOs(serverId);
		if (os === 'windows') {
			apiData = this.applyWindowsPaths(apiData);
		}

		const promptBody = Buffer.from(JSON.stringify({ prompt: apiData }));
		const promptRes = await this.tunnelService.fetchHttp(
			serverId, 'POST', '/prompt', { 'content-type': 'application/json' }, promptBody, 15_000,
		);

		if (promptRes.status !== 200) this.throwPromptError(promptRes.status, promptRes.body);

		const promptData = JSON.parse(promptRes.body.toString());
		const promptId: string = promptData.prompt_id;
		if (!promptId) throw new BadRequestException('ComfyUI did not return a prompt_id');

		return { serverId, promptId };
	}

	private async pollHistory(
		serverId: string,
		promptId: string,
	): Promise<{ images: { filename: string; subfolder: string; type: string }[]; errorMsg?: string }> {
		const maxAttempts = 200; // ~5 minutes at 1.5s intervals
		for (let i = 0; i < maxAttempts; i++) {
			await new Promise((r) => setTimeout(r, 1_500));
			let res: { status: number; body: Buffer };
			try {
				res = await this.tunnelService.fetchHttp(
					serverId,
					'GET',
					`/history/${encodeURIComponent(promptId)}`,
					{},
					null,
					10_000,
				);
			} catch {
				continue; // transient tunnel error — keep polling
			}

			if (res.status !== 200) continue;

			let data: any;
			try { data = JSON.parse(res.body.toString()); } catch { continue; }
			if (!data[promptId]) continue;

			const entry = data[promptId];
			const errorRaw = entry.status?.messages?.find(([t]: any) => t === 'execution_error')?.[1];
			const errorMsg: string | undefined = errorRaw
				? (errorRaw.exception_message ?? JSON.stringify(errorRaw))
				: undefined;

			const images: { filename: string; subfolder: string; type: string }[] = [];
			for (const output of Object.values(entry.outputs ?? {}) as any[]) {
				if (output.images?.length) images.push(...output.images);
			}

			return { images, errorMsg };
		}
		throw new Error('Job timed out after 5 minutes');
	}

	private throwPromptError(status: number, body: Buffer): never {
		console.error(`[Run] ComfyUI /prompt failed (${status}):\n${body.toString()}`);

		let parsed: any;
		try { parsed = JSON.parse(body.toString()); } catch { /* not JSON */ }

		if (parsed?.node_errors) {
			const lines: string[] = [];
			for (const [nodeId, nodeErr] of Object.entries(parsed.node_errors) as [string, any][]) {
				for (const e of nodeErr.errors ?? []) {
					lines.push(`Node ${nodeId}: [${e.type}] ${e.message}${e.details ? ` — ${e.details}` : ''}`);
				}
			}
			if (lines.length) throw new BadRequestException(lines.join('\n'));
		}

		const msg = parsed?.error?.message ?? body.toString().slice(0, 400);
		throw new BadRequestException(`ComfyUI /prompt failed (${status}): ${msg}`);
	}

	private setAtPath(obj: any, path: string, value: unknown): void {
		const parts = path.replace(/^\//, '').split('/');
		let cur = obj;
		for (let i = 0; i < parts.length - 1; i++) {
			cur = cur?.[parts[i]];
			if (cur == null) return;
		}
		if (cur != null) cur[parts[parts.length - 1]] = value;
	}

	private getAtPath(obj: any, path: string): unknown {
		const parts = path.replace(/^\//, '').split('/');
		let cur = obj;
		for (const part of parts) {
			cur = cur?.[part];
			if (cur == null) return undefined;
		}
		return cur;
	}

	private applyWindowsPaths(apiData: any): any {
		const patched = structuredClone(apiData);
		for (const node of Object.values(patched) as any[]) {
			if (!node?.inputs) continue;
			for (const [key, val] of Object.entries(node.inputs)) {
				if (PATH_EXEMPT_KEYS.test(key)) continue;
				if (typeof val === 'string' && val.includes('/') && !val.includes('://') && !val.includes(' ')) {
					(node.inputs as any)[key] = val.split('/').join('\\');
				}
			}
		}
		return patched;
	}
}
