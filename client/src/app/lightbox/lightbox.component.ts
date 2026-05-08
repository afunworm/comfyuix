import {
	Component,
	Input,
	Output,
	EventEmitter,
	HostListener,
	ViewEncapsulation,
	ElementRef,
	ViewChild,
	AfterViewInit,
	OnDestroy,
} from "@angular/core";

@Component({
	selector: "app-lightbox",
	standalone: true,
	encapsulation: ViewEncapsulation.None,
	template: `
		<div
			class="backdrop"
			data-open="true"
			role="dialog"
			aria-modal="true"
			(click)="onBackdropClick($event)"
		>
			<div class="lightbox">
				<button
					type="button"
					class="lightbox__close"
					aria-label="Close"
					(click)="close.emit()"
				>
					✕
				</button>

				<div #hud class="lightbox__hud" aria-live="polite">
					<div class="lightbox__hud-title">
						<span class="badge badge--accent" style="font-size: 0.8em;">
							<span class="badge__dot"></span>
							{{ naturalW }}×{{ naturalH }}
						</span>

						@if (afterSrc) {
							<button
								type="button"
								class="btn"
								style="padding: 4px 10px; font-size: 0.85em;"
								(click)="toggleCompare()"
							>
								{{ compareEnabled ? "Single Mode" : "Compare Mode" }}
							</button>
						}
					</div>

					<div class="lightbox__hud-url" title="{{ src }}">
						{{ src }}
					</div>

					<!-- @if (afterSrc && compareEnabled) {
						<div class="lightbox__hud-url" title="{{ afterSrc }}">
							{{ afterSrc }}
						</div>
					} -->
				</div>

				<div
					#viewport
					class="lightbox__viewport"
					(wheel)="onWheel($event)"
					(pointerdown)="onPointerDown($event)"
					(pointermove)="onPointerMove($event)"
					(pointerup)="onPointerUp($event)"
					(pointercancel)="onPointerUp($event)"
					(pointerleave)="onPointerUp($event)"
				>
					@if (!afterSrc || !compareEnabled) {
						<img
							#img
							class="lightbox__img"
							[src]="afterSrc || src"
							[alt]="alt"
							draggable="false"
							(load)="onImgLoadPrimary()"
						/>
					} @else {
						<img
							#imgBefore
							class="lightbox__img"
							[src]="src"
							alt="Before"
							draggable="false"
							(load)="onImgLoadPrimary()"
						/>

						<img
							#imgAfter
							class="lightbox__img lightbox__img--after"
							[src]="afterSrc!"
							alt="After"
							draggable="false"
							(load)="onImgLoadAfter()"
						/>

						<div class="compare" aria-hidden="true">
							<div class="compare__line" [style.left.px]="compareX"></div>

							<div
								#compareHandle
								class="compare__handle"
								[style.left.px]="compareX"
								role="slider"
								aria-label="Before/after slider"
								aria-valuemin="0"
								[attr.aria-valuemax]="viewportW"
								[attr.aria-valuenow]="compareX"
								tabindex="0"
								(pointerdown)="onCompareDown($event)"
							>
								⇆
							</div>
						</div>
					}
				</div>
			</div>
		</div>
	`,
	styles: [
		`
			.backdrop {
				display: grid;
				place-items: center;
				padding: 0;
			}

			.lightbox {
				position: relative;
				width: 100vw;
				height: 100vh;
				padding: 5vh 5vw; /* breathing room */
				box-sizing: border-box;
				overflow: hidden;
				display: grid;
				place-items: center;
			}

			.lightbox__viewport {
				width: 100%;
				height: 100%;
				overflow: hidden;
				touch-action: none;
				position: relative; /* important */
				cursor: grab;
				user-select: none;

				/* remove centering */
				display: block;
			}

			.lightbox__viewport.dragging {
				cursor: grabbing;
			}

			.lightbox__img {
				position: absolute; /* important */
				left: 0;
				top: 0;

				display: block;
				transform-origin: 0 0;
				will-change: transform;
				pointer-events: none;

				/* keep these (since TS sets exact fitted size) */
				max-width: none;
				max-height: none;
			}

			.lightbox__img--after {
				/* clip-path set in TS */
			}

			/* Compare overlay (doesn't intercept normal drag except on handle) */
			.compare {
				position: absolute;
				inset: 0;
				pointer-events: none;
			}

			.compare__line {
				position: absolute;
				top: 0;
				bottom: 0;
				width: 2px;
				transform: translateX(-1px);
				background: rgba(255, 255, 255, 0.65);
				box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
				pointer-events: none;
			}

			.compare__handle {
				position: absolute;
				top: 50%;
				transform: translate(-50%, -50%);
				pointer-events: auto;

				width: 44px;
				height: 44px;
				border-radius: 999px;

				border: 1px solid rgba(42, 58, 75, 0.9);
				background: rgba(15, 22, 32, 0.92);
				color: var(--text);

				display: grid;
				place-items: center;

				cursor: ew-resize;
				user-select: none;
				touch-action: none;
				-webkit-user-select: none;

				box-shadow: 0 18px 45px rgba(0, 0, 0, 0.45);
			}

			.lightbox__close {
				position: fixed;
				top: 20px;
				right: 20px;
				appearance: none;
				border: 1px solid var(--border);
				background: rgba(15, 22, 32, 0.92);
				color: var(--text);
				width: 42px;
				height: 42px;
				border-radius: 999px;
				cursor: pointer;
				font-size: 18px;
				line-height: 1;
				box-shadow: 0 18px 45px var(--shadow);
				z-index: 2;
			}

			.lightbox__hud {
				position: fixed;
				right: 5px;
				bottom: 5px;
				z-index: 2;

				display: grid;
				gap: 8px;

				max-width: min(800px, calc(100vw - 40px));
				padding: 10px 12px;

				border-radius: 14px;
				border: 1px solid rgba(42, 58, 75, 0.85);
				background: rgba(15, 22, 32, 0.85);
				backdrop-filter: blur(10px);

				box-shadow: 0 18px 45px rgba(0, 0, 0, 0.45);
			}

			.lightbox__hud-title {
				display: flex;
				align-items: center;
				gap: 10px;
			}

			.lightbox__hud-url {
				color: var(--muted);
				font-size: 0.8em;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
		`,
	],
})
export class LightboxComponent implements AfterViewInit, OnDestroy {
	@Input() src!: string;
	@Input() alt = "Photo";
	@Input() afterSrc?: string;

	@Output() close = new EventEmitter<void>();

	@ViewChild("viewport", { static: true })
	viewportRef!: ElementRef<HTMLDivElement>;

	@ViewChild("hud", { static: true })
	hudRef!: ElementRef<HTMLDivElement>;

	// Single mode
	@ViewChild("img") imgRef?: ElementRef<HTMLImageElement>;

	// Compare mode
	@ViewChild("imgBefore") imgBeforeRef?: ElementRef<HTMLImageElement>;
	@ViewChild("imgAfter") imgAfterRef?: ElementRef<HTMLImageElement>;
	@ViewChild("compareHandle") compareHandleRef?: ElementRef<HTMLDivElement>;

	// For HUD box
	naturalW = 0;
	naturalH = 0;

	// Compare toggle
	compareEnabled = false;

	// Transform state
	private scale = 1;
	private minScale = 1;
	private maxScale = 6;

	private tx = 0;
	private ty = 0;

	// Drag state (pan)
	private dragging = false;
	private pointerId: number | null = null;
	private startX = 0;
	private startY = 0;
	private startTx = 0;
	private startTy = 0;

	// Cached sizes
	viewportW = 0;
	private viewportH = 0;
	private baseW = 0; // image size as displayed at scale=1 (fit-to-screen)
	private baseH = 0;

	// Compare slider state
	compareX = 0; // in viewport px
	private comparing = false;
	private comparePointerId: number | null = null;
	private compareStartClientX = 0;
	private compareStartX = 0;

	@HostListener("document:keydown.escape")
	onEsc() {
		this.close.emit();
	}

	ngAfterViewInit() {
		this.recomputeBaseSize();
		this.applyTransform();
		window.addEventListener("resize", this.onResize, { passive: true });

		// Default slider position
		queueMicrotask(() => {
			this.recomputeViewport();
			if (this.isCompareActive()) {
				this.compareX = Math.round(this.viewportW / 2);
				this.applyClip();
			}
		});
	}

	ngOnDestroy() {
		window.removeEventListener("resize", this.onResize as any);
		this.teardownCompareGlobalListeners();
	}

	// --- Public API (service can call these) ---
	toggleCompare(force?: boolean) {
		if (!this.afterSrc) {
			this.compareEnabled = false;
			return;
		}

		this.compareEnabled =
			typeof force === "boolean" ? force : !this.compareEnabled;

		if (this.compareEnabled) {
			this.recomputeViewport();
			this.compareX = Math.round(this.viewportW / 2);
			queueMicrotask(() => this.applyClip());
			queueMicrotask(() => this.recomputeBaseSize());
			queueMicrotask(() => this.reset());
		} else {
			// Switching back to single: refit and reset using primary image
			queueMicrotask(() => this.recomputeBaseSize());
			queueMicrotask(() => this.reset());
		}
	}

	setCompareEnabled(v: boolean) {
		this.compareEnabled = !!this.afterSrc && v;
		if (this.compareEnabled) {
			this.recomputeViewport();
			this.compareX = Math.round(this.viewportW / 2);
			queueMicrotask(() => this.applyClip());
		}
	}

	// --- Image load handlers ---
	onImgLoadPrimary() {
		const img = this.getPrimaryImgEl();
		if (!img) return; // Image not ready yet

		this.naturalW = img.naturalWidth || 0;
		this.naturalH = img.naturalHeight || 0;

		this.recomputeBaseSize();
		this.reset();

		if (this.isCompareActive()) this.applyClip();
	}

	onImgLoadAfter() {
		// We still fit based on primary image. Just ensure transform & clip apply.
		this.recomputeBaseSize();
		this.applyTransform();
		this.applyClip();
	}

	private onResize = () => {
		const prevScale = this.scale;

		// Preserve slider position as a fraction of the IMAGE width (not viewport)
		let imageRatio = 0.5;
		if (this.isCompareActive()) {
			const b = this.getImageBoundsInViewport();
			const w = Math.max(1, b.right - b.left);
			imageRatio = (this.compareX - b.left) / w;
			imageRatio = this.clamp(imageRatio, 0, 1);
		}

		this.recomputeBaseSize();
		this.scale = this.clamp(prevScale, this.minScale, this.maxScale);
		this.clampTranslation();

		if (this.isCompareActive()) {
			const b = this.getImageBoundsInViewport();
			this.compareX = Math.round(b.left + imageRatio * (b.right - b.left));
			this.compareX = this.clamp(
				Math.round(this.compareX),
				Math.round(b.left),
				Math.round(b.right),
			);
			this.applyClip();
		}

		this.applyTransform();
	};

	// --- Backdrop close ---
	onBackdropClick(event: MouseEvent) {
		const viewportRect = this.viewportRef.nativeElement.getBoundingClientRect();
		const hudRect = this.hudRef.nativeElement.getBoundingClientRect();

		const insideViewport =
			event.clientX >= viewportRect.left &&
			event.clientX <= viewportRect.right &&
			event.clientY >= viewportRect.top &&
			event.clientY <= viewportRect.bottom;

		const insideHud =
			event.clientX >= hudRect.left &&
			event.clientX <= hudRect.right &&
			event.clientY >= hudRect.top &&
			event.clientY <= hudRect.bottom;

		if (!insideViewport && !insideHud) {
			this.close.emit();
		}
	}

	// --- Zoom ---
	onWheel(event: WheelEvent) {
		event.preventDefault();

		const delta = -event.deltaY;
		const zoomFactor = delta > 0 ? 1.12 : 1 / 1.12;

		const prevScale = this.scale;
		const nextScale = this.clamp(
			prevScale * zoomFactor,
			this.minScale,
			this.maxScale,
		);
		if (nextScale === prevScale) return;

		const viewport = this.viewportRef.nativeElement;
		const rect = viewport.getBoundingClientRect();

		const px = event.clientX - rect.left;
		const py = event.clientY - rect.top;

		const wx = (px - this.tx) / prevScale;
		const wy = (py - this.ty) / prevScale;

		this.scale = nextScale;

		this.tx = px - wx * this.scale;
		this.ty = py - wy * this.scale;

		this.clampTranslation();
		this.applyTransform();
		if (this.isCompareActive()) this.applyClip();
	}

	// --- Pan (drag viewport) ---
	onPointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		if (this.comparing) return; // don't fight the slider

		this.dragging = true;
		this.pointerId = event.pointerId;

		const viewport = this.viewportRef.nativeElement;
		viewport.classList.add("dragging");
		viewport.setPointerCapture(event.pointerId);

		this.startX = event.clientX;
		this.startY = event.clientY;
		this.startTx = this.tx;
		this.startTy = this.ty;
	}

	onPointerMove(event: PointerEvent) {
		if (!this.dragging || this.pointerId !== event.pointerId) return;

		const dx = event.clientX - this.startX;
		const dy = event.clientY - this.startY;

		this.tx = this.startTx + dx;
		this.ty = this.startTy + dy;

		this.clampTranslation();
		this.applyTransform();
	}

	onPointerUp(event: PointerEvent) {
		if (this.pointerId === event.pointerId) {
			this.dragging = false;
			this.pointerId = null;

			const viewport = this.viewportRef.nativeElement;
			viewport.classList.remove("dragging");
		}
	}

	// --- Compare slider (smooth + sticky) ---
	onCompareDown(event: PointerEvent) {
		if (!this.isCompareActive()) return;
		if (event.button !== 0) return;

		event.preventDefault();
		event.stopPropagation();

		this.comparing = true;
		this.comparePointerId = event.pointerId;

		this.compareStartClientX = event.clientX;
		this.compareStartX = this.compareX;

		const handle = this.compareHandleRef?.nativeElement;
		(handle ?? this.viewportRef.nativeElement).setPointerCapture(event.pointerId);

		window.addEventListener("pointermove", this.onCompareMove, {
			passive: false,
		});
		window.addEventListener("pointerup", this.onCompareEnd, { passive: true });
		window.addEventListener("pointercancel", this.onCompareEnd, {
			passive: true,
		});

		// clamp right away (so it doesn't start "outside the image")
		const b = this.getImageBoundsInViewport();
		this.compareX = this.clamp(this.compareX, b.left, b.right);
		this.applyClip();
	}

	private onCompareMove = (event: PointerEvent) => {
		if (!this.comparing || this.comparePointerId !== event.pointerId) return;
		event.preventDefault();

		const dx = event.clientX - this.compareStartClientX;
		let nextX = this.compareStartX + dx;

		const b = this.getImageBoundsInViewport();
		nextX = this.clamp(nextX, b.left, b.right);

		this.compareX = Math.round(nextX);
		this.applyClip();
	};

	private onCompareEnd = (event: PointerEvent) => {
		if (this.comparePointerId !== event.pointerId) return;

		this.comparing = false;
		this.comparePointerId = null;
		this.teardownCompareGlobalListeners();
	};

	private teardownCompareGlobalListeners() {
		window.removeEventListener("pointermove", this.onCompareMove as any);
		window.removeEventListener("pointerup", this.onCompareEnd as any);
		window.removeEventListener("pointercancel", this.onCompareEnd as any);
	}

	// --- Layout / sizing ---
	private isCompareActive() {
		return !!this.afterSrc && this.compareEnabled;
	}

	private recomputeViewport() {
		const viewport = this.viewportRef.nativeElement;
		this.viewportW = viewport.clientWidth;
		this.viewportH = viewport.clientHeight;
	}

	private getPrimaryImgEl(): HTMLImageElement | null {
		if (this.isCompareActive()) return this.imgBeforeRef?.nativeElement ?? null;
		return this.imgRef?.nativeElement ?? null;
	}

	private getImgs(): HTMLImageElement[] {
		if (this.isCompareActive()) {
			const before = this.imgBeforeRef?.nativeElement;
			const after = this.imgAfterRef?.nativeElement;
			return [before, after].filter((el): el is HTMLImageElement => !!el);
		}
		const img = this.imgRef?.nativeElement;
		return img ? [img] : [];
	}

	private recomputeBaseSize() {
		this.recomputeViewport();

		const img = this.getPrimaryImgEl();
		if (!img) return; // Image not ready yet

		const nw = img.naturalWidth || 1;
		const nh = img.naturalHeight || 1;

		const fitScale = Math.min(this.viewportW / nw, this.viewportH / nh);

		this.baseW = Math.round(nw * fitScale);
		this.baseH = Math.round(nh * fitScale);

		for (const el of this.getImgs()) {
			el.style.width = `${this.baseW}px`;
			el.style.height = `${this.baseH}px`;
		}

		this.minScale = 1;
	}

	reset() {
		this.scale = 1;
		this.tx = (this.viewportW - this.baseW) / 2;
		this.ty = (this.viewportH - this.baseH) / 2;

		if (this.isCompareActive()) {
			const b = this.getImageBoundsInViewport();
			this.compareX = Math.round((b.left + b.right) / 2);
			this.applyClip();
		}

		this.applyTransform();
	}

	private clampTranslation() {
		const scaledW = this.baseW * this.scale;
		const scaledH = this.baseH * this.scale;

		if (scaledW <= this.viewportW) {
			this.tx = (this.viewportW - scaledW) / 2;
		} else {
			const minX = this.viewportW - scaledW;
			const maxX = 0;
			this.tx = this.clamp(this.tx, minX, maxX);
		}

		if (scaledH <= this.viewportH) {
			this.ty = (this.viewportH - scaledH) / 2;
		} else {
			const minY = this.viewportH - scaledH;
			const maxY = 0;
			this.ty = this.clamp(this.ty, minY, maxY);
		}
	}

	private applyTransform() {
		const t = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
		for (const img of this.getImgs()) {
			img.style.transform = t;
		}
	}

	private applyClip() {
		if (!this.isCompareActive()) return;
		const after = this.imgAfterRef?.nativeElement;
		if (!after) return;

		// Slider X is in viewport pixels.
		// clip-path inset() is in the element's *local* pixels (pre-transform).
		// Convert viewport compareX into image-local X:
		const localX = (this.compareX - this.tx) / this.scale;

		// Clamp to the actual image width in local coords
		const clampedLocalX = this.clamp(localX, 0, this.baseW);

		after.style.clipPath = `inset(0px 0px 0px ${clampedLocalX}px)`;
	}

	private clamp(v: number, min: number, max: number) {
		return Math.max(min, Math.min(max, v));
	}

	private getImageBoundsInViewport() {
		// image bounds in viewport pixels, based on current transform
		const left = this.tx;
		const top = this.ty;
		const right = this.tx + this.baseW * this.scale;
		const bottom = this.ty + this.baseH * this.scale;
		return { left, top, right, bottom };
	}
}
