import { Component, inject, OnInit, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { ComfyUIDatabaseService, ComfyServer } from "../../comfyui/comfyui-database.service";
import { HeaderComponent } from "../../header/header.component";
import { FooterComponent } from "../../footer/footer.component";

@Component({
	selector: "app-model-picker",
	standalone: true,
	imports: [RouterLink, HeaderComponent, FooterComponent],
	template: `
		<div class="app">
			<app-header />
			<main class="page">
				<section class="panel section">
					<div class="output__head">
						<h2 class="output__title">Model Manager</h2>
					</div>
					<p style="opacity: 0.6; font-size: 0.85rem; margin-bottom: 16px">
						Select a server to manage its models.
					</p>
					@if (loading()) {
						<p style="opacity: 0.5">Loading…</p>
					} @else if (servers().length === 0) {
						<p style="opacity: 0.5">No servers found. Create a server first on the <a routerLink="/servers">Servers</a> page.</p>
					} @else {
						<div style="display: flex; flex-direction: column; gap: 8px">
							@for (server of servers(); track server.id) {
								<a
									class="btn"
									style="justify-content: flex-start"
									[routerLink]="['/servers', server.id, 'models']"
								>{{ server.name }}</a>
							}
						</div>
					}
				</section>
			</main>
			<app-footer />
		</div>
	`,
})
export class ModelPickerPage implements OnInit {
	private db = inject(ComfyUIDatabaseService);
	servers = signal<ComfyServer[]>([]);
	loading = signal(true);

	ngOnInit() {
		this.db.getServers().subscribe({
			next: (servers) => { this.servers.set(servers); this.loading.set(false); },
			error: () => this.loading.set(false),
		});
	}
}
