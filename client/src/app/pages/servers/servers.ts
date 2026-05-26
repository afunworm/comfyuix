import { Component, inject, signal, OnInit } from "@angular/core";
import { RouterLink } from "@angular/router";
import { Dialog } from "../../dialog";
import { ComfyUIDatabaseService, ComfyServer } from "../../comfyui/comfyui-database.service";
import { HeaderComponent } from "../../header/header.component";
import { FooterComponent } from "../../footer/footer.component";
import { TUNNEL_DOCKER_TAG } from "../../version";

@Component({
	selector: "app-servers",
	standalone: true,
	imports: [RouterLink, HeaderComponent, FooterComponent],
	templateUrl: "./servers.html",
})
export class ServersPage implements OnInit {
	private dialog = inject(Dialog);
	private db = inject(ComfyUIDatabaseService);

	servers = signal<ComfyServer[]>([]);
	loading = signal(false);

	// Edit state
	editingId = signal<string | null>(null);
	editDraft = signal<{ name: string }>({ name: "" });

	// Tunnel panel
	tunnelPanelId = signal<string | null>(null);
	tunnelTokens = signal<Record<string, string | null | undefined>>({});
	tunnelTokenVisible = signal<Record<string, boolean>>({});
	tunnelTokenLoading = signal<string | null>(null);
	tunnelConnected = signal<Record<string, boolean>>({});
	tunnelServerUrlOverrides = signal<Record<string, string | undefined>>({});

	ngOnInit() {
		this.loadServers();
	}

	loadServers() {
		this.loading.set(true);
		this.db.getServers().subscribe({
			next: (servers) => {
				this.servers.set(servers);
				this.loading.set(false);
				for (const s of servers) {
					this.refreshTunnelStatus(s.id);
				}
			},
			error: () => this.loading.set(false),
		});
	}

	refreshTunnelStatus(serverId: string) {
		this.db.getServerTunnelStatus(serverId, 0).subscribe({
			next: (res) => {
				this.tunnelConnected.update((m) => ({ ...m, [serverId]: res.connected }));
			},
			error: () => {},
		});
	}

	// ── Create ────────────────────────────────────────────────────────────────

	async createServer() {
		const name = await this.dialog.prompt("Server name:");
		if (!name?.trim()) return;
		this.db.createServer({ name: name.trim() }).subscribe({
			next: () => this.loadServers(),
			error: () => this.dialog.alert("Failed to create server."),
		});
	}

	// ── Edit ─────────────────────────────────────────────────────────────────

	startEdit(server: ComfyServer) {
		this.editingId.set(server.id);
		this.editDraft.set({ name: server.name });
	}

	cancelEdit() {
		this.editingId.set(null);
	}

	saveEdit(server: ComfyServer) {
		const draft = this.editDraft();
		if (!draft.name.trim()) {
			this.dialog.alert("Name cannot be empty.");
			return;
		}
		this.db.updateServer(server.id, { name: draft.name.trim() }).subscribe({
			next: () => {
				this.cancelEdit();
				this.loadServers();
			},
			error: () => this.dialog.alert("Failed to update server."),
		});
	}

	// ── Delete ────────────────────────────────────────────────────────────────

	async deleteServer(server: ComfyServer) {
		const ok = await this.dialog.confirm(
			`Delete "${server.name}"? This will disconnect any linked books and cannot be undone.`,
		);
		if (!ok) return;
		this.db.deleteServer(server.id).subscribe({
			next: () => this.loadServers(),
			error: () => this.dialog.alert("Failed to delete server."),
		});
	}

	// ── Tunnel token ──────────────────────────────────────────────────────────

	tunnelServerUrl(): string {
		return window.location.host;
	}

	toggleTunnelPanel(serverId: string) {
		if (this.tunnelPanelId() === serverId) {
			this.tunnelPanelId.set(null);
			return;
		}
		this.tunnelPanelId.set(serverId);
		if (!(serverId in this.tunnelServerUrlOverrides())) {
			this.tunnelServerUrlOverrides.update((m) => ({ ...m, [serverId]: this.tunnelServerUrl() }));
		}
		if (!(serverId in this.tunnelTokens())) {
			this.loadTunnelToken(serverId);
		}
	}

	loadTunnelToken(serverId: string) {
		this.tunnelTokenLoading.set(serverId);
		this.db.getServerTunnelToken(serverId).subscribe({
			next: (res) => {
				this.tunnelTokens.update((t) => ({ ...t, [serverId]: res.tunnelToken }));
				this.tunnelTokenLoading.set(null);
			},
			error: () => {
				this.tunnelTokens.update((t) => ({ ...t, [serverId]: null }));
				this.tunnelTokenLoading.set(null);
			},
		});
	}

	async regenerateTunnelToken(serverId: string) {
		const ok = await this.dialog.confirm(
			"Regenerate tunnel token? The current comfyuix-tunnel will disconnect and need the new token.",
		);
		if (!ok) return;
		this.tunnelTokenLoading.set(serverId);
		this.db.regenerateServerTunnelToken(serverId).subscribe({
			next: (res) => {
				this.tunnelTokens.update((t) => ({ ...t, [serverId]: res.tunnelToken }));
				this.tunnelTokenVisible.update((v) => ({ ...v, [serverId]: true }));
				this.tunnelTokenLoading.set(null);
			},
			error: () => {
				this.dialog.alert("Failed to regenerate token.");
				this.tunnelTokenLoading.set(null);
			},
		});
	}

	async revokeTunnelToken(serverId: string) {
		const ok = await this.dialog.confirm(
			"Revoke tunnel token? The sidecar will be disconnected and cannot reconnect until a new token is generated.",
		);
		if (!ok) return;
		this.tunnelTokenLoading.set(serverId);
		this.db.revokeServerTunnelToken(serverId).subscribe({
			next: () => {
				this.tunnelTokens.update((t) => ({ ...t, [serverId]: null }));
				this.tunnelTokenLoading.set(null);
			},
			error: () => {
				this.dialog.alert("Failed to revoke token.");
				this.tunnelTokenLoading.set(null);
			},
		});
	}

	toggleTunnelTokenVisible(serverId: string) {
		this.tunnelTokenVisible.update((v) => ({ ...v, [serverId]: !v[serverId] }));
	}

	setDraftName(value: string) {
		this.editDraft.update((d) => ({ ...d, name: value }));
	}

	setTunnelServerUrl(serverId: string, value: string) {
		this.tunnelServerUrlOverrides.update((m) => ({ ...m, [serverId]: value.trim() }));
	}

	copyToClipboard(text: string) {
		navigator.clipboard.writeText(text);
	}

	maskToken(token: string): string {
		return token.slice(0, 8) + "••••••••••••••••••••••••••••••••••••••••••••••••" + token.slice(-8);
	}

	dockerCommand(serverId: string): string {
		const token = this.tunnelTokens()[serverId] ?? "";
		const serverUrl = (this.tunnelServerUrlOverrides()[serverId] ?? this.tunnelServerUrl()).trim();
		const isLinux = true;
		const hostModelsPath = isLinux ? "/root/ComfyUI/models" : "C:/Users/username/ComfyUI/models";
		const hostOutputPath = isLinux ? "/root/ComfyUI/output" : "C:/Users/username/ComfyUI/output";
		return [
			"docker run -d --restart unless-stopped \\",
			"  --name comfyuix-tunnel \\",
			...(isLinux ? ["  --network host \\"] : []),
			`  -v ${hostModelsPath}:/models \\`,
			`  -v ${hostOutputPath}:/output \\`,
			`  -e COMFYUIX_SERVER_URL=${serverUrl} \\`,
			`  -e COMFYUIX_TOKEN=${token} \\`,
			`  -e COMFY_HOST=${isLinux ? "127.0.0.1" : "host.docker.internal"} \\`,
			"  -e COMFY_PORT=8188 \\",
			`  afunworm/comfyuix-tunnel:${TUNNEL_DOCKER_TAG}`,
		].join("\n");
	}

	composeCommand(serverId: string): string {
		const token = this.tunnelTokens()[serverId] ?? "";
		const serverUrl = (this.tunnelServerUrlOverrides()[serverId] ?? this.tunnelServerUrl()).trim();
		const isLinux = true;
		const hostModelsPath = isLinux ? "/root/ComfyUI/models" : "C:/Users/username/ComfyUI/models";
		const hostOutputPath = isLinux ? "/root/ComfyUI/output" : "C:/Users/username/ComfyUI/output";
		return [
			"services:",
			"  comfyuix-tunnel:",
			`    image: afunworm/comfyuix-tunnel:${TUNNEL_DOCKER_TAG}`,
			"    restart: unless-stopped",
			...(isLinux ? ["    network_mode: host"] : []),
			"    volumes:",
			`      - ${hostModelsPath}:/models`,
			`      - ${hostOutputPath}:/output`,
			"    environment:",
			`      - COMFYUIX_SERVER_URL=${serverUrl}`,
			`      - COMFYUIX_TOKEN=${token}`,
			`      - COMFY_HOST=${isLinux ? "127.0.0.1" : "host.docker.internal"}`,
			"      - COMFY_PORT=8188",
		].join("\n");
	}

	nodeCommand(serverId: string): string {
		const token = this.tunnelTokens()[serverId] ?? "";
		const serverUrl = (this.tunnelServerUrlOverrides()[serverId] ?? this.tunnelServerUrl()).trim();
		const isLinux = true;
		const modelsPath = isLinux ? "/root/ComfyUI/models" : "C:/Users/username/ComfyUI/models";
		const outputPath = isLinux ? "/root/ComfyUI/output" : "C:/Users/username/ComfyUI/output";
		return `COMFYUIX_SERVER_URL=${serverUrl} COMFYUIX_TOKEN=${token} COMFY_HOST=${isLinux ? "127.0.0.1" : "host.docker.internal"} COMFY_PORT=8188 MODELS_PATH=${modelsPath} OUTPUT_PATH=${outputPath} node index.js`;
	}
}
