import { Component, inject, signal, Input, Output, EventEmitter, OnInit } from "@angular/core";
import { CommonModule, JsonPipe, DecimalPipe } from "@angular/common";
import { ComfyUIDatabaseService, FsEntry } from "../comfyui/comfyui-database.service";

@Component({
	selector: "app-model-info-modal",
	standalone: true,
	imports: [CommonModule, JsonPipe, DecimalPipe],
	templateUrl: "./model-info-modal.html",
	styleUrl: "./model-info-modal.scss",
})
export class ModelInfoModal implements OnInit {
	@Input({ required: true }) serverId!: string;
	@Input({ required: true }) entry!: FsEntry;
	@Input({ required: true }) fullPath!: string;
	@Output() close = new EventEmitter<void>();

	private db = inject(ComfyUIDatabaseService);

	fileMetaLoading = signal(true);
	modelInfoLoading = signal(true);
	fileMeta = signal<Record<string, any> | null>(null);
	modelInfo = signal<any | null>(null);
	fileMetaError = signal('');
	modelInfoError = signal('');
	imageIndex = signal(0);
	showNsfw = signal(false);

	ngOnInit() {
		this.db.readFileMeta(this.serverId, this.fullPath).subscribe({
			next: (data) => { this.fileMetaLoading.set(false); this.fileMeta.set(data); },
			error: (err) => { this.fileMetaLoading.set(false); this.fileMetaError.set(err?.error?.message ?? 'Failed'); },
		});
		this.db.getModelInfo(this.serverId, this.fullPath).subscribe({
			next: (data) => { this.modelInfoLoading.set(false); this.modelInfo.set(data); },
			error: (err) => { this.modelInfoLoading.set(false); this.modelInfoError.set(err?.error?.message ?? 'Failed'); },
		});
	}

	prevImage() {
		this.imageIndex.update((i) => Math.max(0, i - 1));
	}

	nextImage() {
		const count = this.modelInfo()?.data?.images?.length ?? 0;
		this.imageIndex.update((i) => Math.min(count - 1, i + 1));
	}

	toggleNsfw() {
		this.showNsfw.update((v) => !v);
	}

	isImageNsfw(): boolean {
		if (this.showNsfw()) return false;
		const img = this.modelInfo()?.data?.images?.[this.imageIndex()];
		return !!(this.modelInfo()?.data?.model?.nsfw || (img?.nsfwLevel ?? 0) > 1);
	}

	stripHtml(html: string): string {
		if (!html) return '';
		return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
	}

	metaRows(data: Record<string, any>): { k: string; v: string }[] {
		return Object.entries(data).map(([k, v]) => ({
			k,
			v: v !== null && typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v),
		}));
	}
}
