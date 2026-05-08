import {
	Component,
	OnInit,
	OnDestroy,
	ViewChild,
	ElementRef,
	HostListener,
	signal,
	computed,
	effect,
	NgZone,
	ChangeDetectionStrategy,
	ChangeDetectorRef,
	inject,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Subscription } from "rxjs";
import { removeBackground } from "@imgly/background-removal";
import { CanvasEditorService } from "./canvas-editor.service";
import type {
	Tool,
	ResizeHandle,
	Layer,
	TextStyle,
	CanvasEditorConfig,
	CanvasEditorBranding,
	CanvasEditorResult,
	CanvasEditorSaveState,
	LayerSave,
	ContextMenuDef,
	ContextMenuItemDef,
} from "./canvas-editor.types";

let _layerCounter = 0;
function newId() {
	return `layer_${++_layerCounter}_${Date.now()}`;
}
function makeCanvas(w: number, h: number): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	return c;
}

@Component({
	selector: "app-canvas-editor",
	standalone: true,
	imports: [FormsModule],
	templateUrl: "./canvas-editor.component.html",
	styleUrls: ["./canvas-editor.component.scss"],
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CanvasEditorComponent implements OnInit, OnDestroy {
	private svc = inject(CanvasEditorService);
	private zone = inject(NgZone);
	private cdr = inject(ChangeDetectorRef);

	@ViewChild("displayCanvas") displayCanvasRef!: ElementRef<HTMLCanvasElement>;
	@ViewChild("interactionCanvas")
	interactionCanvasRef!: ElementRef<HTMLCanvasElement>;
	@ViewChild("textInput") textInputRef?: ElementRef<HTMLTextAreaElement>;
	@ViewChild("canvasWrap") canvasWrapRef!: ElementRef<HTMLDivElement>;
	@ViewChild("fileInput") fileInputRef!: ElementRef<HTMLInputElement>;

	// ── Visibility ───────────────────────────────────────────────────────────
	isOpen = signal(false);
	config = signal<CanvasEditorConfig>({});
	doneButtonLabel = signal("Done");
	doneButtonDisabled = signal(false);

	// ── Canvas dimensions ────────────────────────────────────────────────────
	canvasWidth = signal(1200);
	canvasHeight = signal(800);
	backgroundColor = signal("transparent");

	// ── Zoom / Pan ───────────────────────────────────────────────────────────
	zoom = signal(1);
	panX = signal(0);
	panY = signal(0);

	// ── Layers ───────────────────────────────────────────────────────────────
	layers = signal<Layer[]>([]);
	activeLayerId = signal<string | null>(null);
	editingMask = signal(false);

	activeLayer = computed(() => {
		const id = this.activeLayerId();
		return this.layers().find((l) => l.id === id) ?? null;
	});

	// ── Tools ────────────────────────────────────────────────────────────────
	currentTool = signal<Tool>("brush");
	brushSize = signal(12);
	brushColor = signal("#000000");
	brushHardness = signal(1); // 0–1
	brushOpacity = signal(1);

	// ── Text editing ─────────────────────────────────────────────────────────
	textEditActive = signal(false);
	textEditX = signal(0); // canvas coords
	textEditY = signal(0); // canvas coords
	textScreenX = signal(0); // screen coords for fixed overlay
	textScreenY = signal(0);
	textEditValue = signal("");
	textEditingLayerId = signal<string | null>(null); // null = new layer, string = editing existing
	textStyle = signal<TextStyle>({
		fontSize: 32,
		fontFamily: "sans-serif",
		color: "#000000",
		bold: false,
		italic: false,
		underline: false,
		strikethrough: false,
		align: "left",
		letterSpacing: 0,
		lineHeight: 1.25,
	});

	// ── Selection drag ───────────────────────────────────────────────────────
	private isDraggingLayer = false;
	private dragStartX = 0;
	private dragStartY = 0;
	private dragLayerInitX = 0;
	private dragLayerInitY = 0;

	// ── Layer resize ─────────────────────────────────────────────────────────
	private resizingHandle: ResizeHandle | null = null;
	private resizeStartX = 0;
	private resizeStartY = 0;
	private resizeStartBounds = { x: 0, y: 0, w: 0, h: 0 };
	private resizeSourceCanvas: HTMLCanvasElement | null = null;
	private resizeSourceImg: HTMLImageElement | null = null;

	// Persistent resize sources to prevent quality degradation across multiple resizes
	private layerResizeSources = new WeakMap<Layer, HTMLCanvasElement>();
	private layerSourceImages = new WeakMap<Layer, HTMLImageElement>();

	// ── Layer rotation ───────────────────────────────────────────────────────
	private isRotating = false;
	private rotateStartAngle = 0;
	private rotateStartRotation = 0;

	// ── Text font scaling ─────────────────────────────────────────────────────
	private isScalingTextFont = false;
	private textScaleStartDist = 0;
	private textScaleStartFontSize = 0;

	// ── Warp/Perspective transform ───────────────────────────────────────────
	isWarpMode = signal(false);
	warpLayerId = signal<string | null>(null);
	private warpCorners: {
		tl: { x: number; y: number };
		tr: { x: number; y: number };
		bl: { x: number; y: number };
		br: { x: number; y: number };
	} | null = null;
	private warpDraggingCorner: "tl" | "tr" | "bl" | "br" | null = null;

	hoveredHandle = signal<ResizeHandle | null>(null);
	hoveredTextLayer = signal(false);
	cursorScreenX = signal(0);
	cursorScreenY = signal(0);
	cursorOnCanvas = signal(false);
	processingMessage = signal<string | null>(null);

	// ── Drawing state ─────────────────────────────────────────────────────────
	private isDrawing = false;
	private lastX = 0;
	private lastY = 0;

	// ── Undo / Redo ──────────────────────────────────────────────────────────
	private undoStacks = new Map<string, ImageData[]>();
	private redoStacks = new Map<string, ImageData[]>();
	private readonly MAX_UNDO = 20;

	// ── Context menu ─────────────────────────────────────────────────────────
	contextMenu = signal<ContextMenuDef | null>(null);

	// ── Resize dialog ────────────────────────────────────────────────────────
	showResizeDialog = signal(false);
	resizeW = signal(1200);
	resizeH = signal(800);

	// ── URL import dialog ────────────────────────────────────────────────────
	showUrlDialog = signal(false);
	importUrl = signal("");

	// ── Background removal dialog ─────────────────────────────────────────────
	showBgRemovalDialog = signal(false);
	bgRemovalLayerId = signal<string | null>(null);

	// ── Rename ────────────────────────────────────────────────────────────────
	renamingLayerId = signal<string | null>(null);
	renameValue = signal("");

	// ── Pan state ─────────────────────────────────────────────────────────────
	private isPanning = false;
	private panStartX = 0;
	private panStartY = 0;
	private panStartPX = 0;
	private panStartPY = 0;
	private spaceDown = false;
	private shiftDown = false;

	// ── Canvas contexts ──────────────────────────────────────────────────────
	private displayCtx: CanvasRenderingContext2D | null = null;

	// ── Subscriptions ────────────────────────────────────────────────────────
	private sub = new Subscription();

	// ── Branding helpers ─────────────────────────────────────────────────────
	get branding(): CanvasEditorBranding {
		return this.config().branding ?? {};
	}
	get accentColor(): string {
		return this.branding.accentColor ?? "#7c3aed";
	}

	// Expose Math to template
	readonly Math = Math;

	// ── Blend modes for UI ───────────────────────────────────────────────────
	readonly blendModes: GlobalCompositeOperation[] = [
		"source-over",
		"multiply",
		"screen",
		"overlay",
		"darken",
		"lighten",
		"color-dodge",
		"color-burn",
		"soft-light",
		"hard-light",
		"difference",
		"exclusion",
	];

	readonly fontFamilies = [
		"sans-serif",
		"serif",
		"monospace",
		"cursive",
		"fantasy",
		"Arial",
		"Georgia",
		"Courier New",
		"Verdana",
		"Impact",
	];

	readonly presetSizes = [
		{ label: "1200×800", w: 1200, h: 800 },
		{ label: "1920×1080", w: 1920, h: 1080 },
		{ label: "1080×1080 (Square)", w: 1080, h: 1080 },
		{ label: "800×600", w: 800, h: 600 },
		{ label: "720×480", w: 720, h: 480 },
	];

	// ─────────────────────────────────────────────────────────────────────────
	// Lifecycle
	// ─────────────────────────────────────────────────────────────────────────
	ngOnInit(): void {
		this.svc._registerComponent(this); // Register for manual control
		this.sub.add(
			this.svc.open$.subscribe((cfg) => {
				this.zone.run(() => {
					this.config.set(cfg);
					this.openEditor(cfg);
				});
			}),
		);
	}

	ngOnDestroy(): void {
		this.sub.unsubscribe();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Open / Close
	// ─────────────────────────────────────────────────────────────────────────
	openEditor(cfg: CanvasEditorConfig = {}): void {
		this.config.set(cfg);
		this.doneButtonLabel.set("Done");
		this.doneButtonDisabled.set(false);
		this.backgroundColor.set("transparent"); // Always start transparent

		if (cfg.initialState) {
			this.loadState(cfg.initialState);
		} else {
			const w = cfg.initialWidth ?? 1200;
			const h = cfg.initialHeight ?? 800;
			this.canvasWidth.set(w);
			this.canvasHeight.set(h);
			this.layers.set([]);
			this.activeLayerId.set(null);
			setTimeout(() => {
				this.initContexts();
				this.addLayer("raster");
				this.fitToWindow();
			});
		}
		this.isOpen.set(true);
		this.cdr.detectChanges();
	}

	close(emit = false): void {
		if (!emit) {
			this.svc._emit(null);
		}
		this.isOpen.set(false);
		this.textEditActive.set(false);
		this.contextMenu.set(null);
		this.cdr.detectChanges();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Canvas init
	// ─────────────────────────────────────────────────────────────────────────
	initContexts(): void {
		if (this.displayCanvasRef?.nativeElement) {
			this.displayCtx = this.displayCanvasRef.nativeElement.getContext("2d")!;
		}
	}

	fitToWindow(): void {
		const container = this.canvasWrapRef?.nativeElement;
		if (!container) return;
		const pad = 80;
		const scaleX = (container.clientWidth - pad) / this.canvasWidth();
		const scaleY = (container.clientHeight - pad) / this.canvasHeight();
		const z = Math.min(scaleX, scaleY, 1);
		this.zoom.set(parseFloat(z.toFixed(3)));
		this.panX.set(0);
		this.panY.set(0);
		this.cdr.detectChanges();
	}

	get canvasTransform(): string {
		return `translate(${this.panX()}px, ${this.panY()}px) scale(${this.zoom()})`;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Layers
	// ─────────────────────────────────────────────────────────────────────────
	addLayer(
		type: "raster" | "image" | "text" = "raster",
		sourceDataUrl?: string,
		name?: string,
	): Layer {
		const w = this.canvasWidth();
		const h = this.canvasHeight();
		const canvas = makeCanvas(w, h);

		const layer: Layer = {
			id: newId(),
			name: name ?? `Layer ${this.layers().length + 1}`,
			type,
			canvas,
			visible: true,
			opacity: 1,
			blendMode: "source-over",
			locked: false,
			x: 0,
			y: 0,
			w,
			h,
			rotation: 0,
		};

		if (type === "image" && sourceDataUrl) {
			layer.srcDataUrl = sourceDataUrl;
			this.drawImageToLayer(layer, sourceDataUrl);
		}

		this.initUndoStack(layer.id);
		this.layers.update((ls) => [layer, ...ls]); // top of stack = index 0
		this.activeLayerId.set(layer.id);
		this.composite();
		this.cdr.detectChanges();
		return layer;
	}

	removeLayer(id: string): void {
		const layers = this.layers();
		if (layers.length <= 1) return;
		this.layers.update((ls) => ls.filter((l) => l.id !== id));
		this.undoStacks.delete(id);
		this.redoStacks.delete(id);

		const remaining = this.layers();
		if (this.activeLayerId() === id) {
			this.activeLayerId.set(remaining[0]?.id ?? null);
		}
		this.composite();
		this.cdr.detectChanges();
	}

	duplicateLayer(id: string): void {
		const src = this.layers().find((l) => l.id === id);
		if (!src) return;
		const newCanvas = makeCanvas(src.canvas.width, src.canvas.height);
		newCanvas.getContext("2d")!.drawImage(src.canvas, 0, 0);
		const dup: Layer = {
			...src,
			id: newId(),
			name: src.name + " copy",
			canvas: newCanvas,
			maskCanvas: src.maskCanvas
				? (() => {
						const mc = makeCanvas(src.maskCanvas!.width, src.maskCanvas!.height);
						mc.getContext("2d")!.drawImage(src.maskCanvas!, 0, 0);
						return mc;
					})()
				: undefined,
		};
		this.initUndoStack(dup.id);
		this.layers.update((ls) => {
			const idx = ls.findIndex((l) => l.id === id);
			const copy = [...ls];
			copy.splice(idx, 0, dup);
			return copy;
		});
		this.activeLayerId.set(dup.id);
		this.composite();
		this.cdr.detectChanges();
	}

	rasterizeLayer(id: string): void {
		this.layers.update((ls) =>
			ls.map((layer) => {
				if (layer.id !== id || layer.type !== "text") return layer;

				// Save state for undo
				this.snapshot(layer.id);

				// Convert text layer to raster layer
				// The canvas already has the rendered text, we just need to:
				// 1. Change the type
				// 2. Remove text properties
				// 3. Capture the current canvas as the final image

				const rasterized: Layer = {
					...layer,
					type: "raster",
					text: undefined,
					textStyle: undefined,
					name: layer.name + " (rasterized)",
				};

				return rasterized;
			}),
		);

		this.composite();
		this.cdr.detectChanges();
	}

	moveLayerUp(id: string): void {
		this.layers.update((ls) => {
			const idx = ls.findIndex((l) => l.id === id);
			if (idx <= 0) return ls;
			const copy = [...ls];
			[copy[idx - 1], copy[idx]] = [copy[idx], copy[idx - 1]];
			return copy;
		});
		this.composite();
		this.cdr.detectChanges();
	}

	moveLayerDown(id: string): void {
		this.layers.update((ls) => {
			const idx = ls.findIndex((l) => l.id === id);
			if (idx >= ls.length - 1) return ls;
			const copy = [...ls];
			[copy[idx], copy[idx + 1]] = [copy[idx + 1], copy[idx]];
			return copy;
		});
		this.composite();
		this.cdr.detectChanges();
	}

	fitLayerToCanvas(id: string): void {
		const layer = this.layers().find((l) => l.id === id);
		if (!layer) return;

		this.snapshot(layer.id);

		const canvasW = this.canvasWidth();
		const canvasH = this.canvasHeight();

		// Capture current layer content
		const sourceCanvas = makeCanvas(layer.canvas.width, layer.canvas.height);
		const sourceCtx = sourceCanvas.getContext("2d")!;
		sourceCtx.drawImage(layer.canvas, 0, 0);

		// For image layers, use the original source if available
		const useSource = layer.type === "image" && layer.srcDataUrl;

		if (useSource) {
			// Load and scale original image for best quality
			const img = new Image();
			img.onload = () => {
				const ctx = layer.canvas.getContext("2d")!;
				ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
				ctx.drawImage(img, 0, 0, canvasW, canvasH);

				layer.x = 0;
				layer.y = 0;
				layer.w = canvasW;
				layer.h = canvasH;

				this.composite();
				this.cdr.detectChanges();
			};
			img.src = layer.srcDataUrl!;
		} else {
			// Scale existing canvas content
			const ctx = layer.canvas.getContext("2d")!;
			ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
			ctx.drawImage(sourceCanvas, 0, 0, canvasW, canvasH);

			layer.x = 0;
			layer.y = 0;
			layer.w = canvasW;
			layer.h = canvasH;

			this.composite();
			this.cdr.detectChanges();
		}
	}

	mergeDown(id: string): void {
		const layers = this.layers();
		const idx = layers.findIndex((l) => l.id === id);
		if (idx >= layers.length - 1) return;
		const top = layers[idx];
		const bottom = layers[idx + 1];
		const ctx = bottom.canvas.getContext("2d")!;
		ctx.save();
		ctx.globalAlpha = top.opacity;
		ctx.globalCompositeOperation = top.blendMode;
		ctx.drawImage(top.canvas, top.x - bottom.x, top.y - bottom.y);
		ctx.restore();
		this.layers.update((ls) => ls.filter((l) => l.id !== id));
		this.activeLayerId.set(bottom.id);
		this.composite();
		this.cdr.detectChanges();
	}

	removeLayerBackground(id: string): void {
		// Show dialog to choose strength
		this.bgRemovalLayerId.set(id);
		this.showBgRemovalDialog.set(true);
		this.cdr.detectChanges();
	}

	enterWarpMode(id: string): void {
		const layer = this.layers().find((l) => l.id === id);
		if (!layer) return;

		// Save state for undo
		this.snapshot(layer.id);

		// Enter warp mode
		this.isWarpMode.set(true);
		this.warpLayerId.set(id);
		this.activeLayerId.set(id);

		// Initialize corners to layer bounds
		this.warpCorners = {
			tl: { x: layer.x, y: layer.y },
			tr: { x: layer.x + layer.w, y: layer.y },
			bl: { x: layer.x, y: layer.y + layer.h },
			br: { x: layer.x + layer.w, y: layer.y + layer.h },
		};

		this.composite();
		this.cdr.detectChanges();
	}

	exitWarpMode(apply: boolean): void {
		if (!this.isWarpMode()) return;

		if (apply && this.warpCorners) {
			const id = this.warpLayerId();
			const layer = this.layers().find((l) => l.id === id);

			if (layer) {
				this.applyWarpTransform(layer, this.warpCorners);
			}
		}

		// Exit warp mode
		this.isWarpMode.set(false);
		this.warpLayerId.set(null);
		this.warpCorners = null;
		this.warpDraggingCorner = null;

		this.composite();
		this.cdr.detectChanges();
	}

	private applyWarpTransform(
		layer: Layer,
		corners: {
			tl: { x: number; y: number };
			tr: { x: number; y: number };
			bl: { x: number; y: number };
			br: { x: number; y: number };
		},
	): void {
		// Capture source image
		const sourceCanvas = makeCanvas(layer.canvas.width, layer.canvas.height);
		const sourceCtx = sourceCanvas.getContext("2d")!;
		sourceCtx.drawImage(layer.canvas, 0, 0);

		// Calculate bounding box of warped corners
		const minX = Math.floor(
			Math.min(corners.tl.x, corners.tr.x, corners.bl.x, corners.br.x),
		);
		const maxX = Math.ceil(
			Math.max(corners.tl.x, corners.tr.x, corners.bl.x, corners.br.x),
		);
		const minY = Math.floor(
			Math.min(corners.tl.y, corners.tr.y, corners.bl.y, corners.br.y),
		);
		const maxY = Math.ceil(
			Math.max(corners.tl.y, corners.tr.y, corners.bl.y, corners.br.y),
		);

		const destW = maxX - minX;
		const destH = maxY - minY;

		// Create destination canvas at full resolution
		const destCanvas = makeCanvas(layer.canvas.width, layer.canvas.height);
		const destCtx = destCanvas.getContext("2d")!;

		// Translate corners to account for new origin
		const adjustedCorners = {
			tl: corners.tl,
			tr: corners.tr,
			bl: corners.bl,
			br: corners.br,
		};

		// Render warped content using grid-based approach
		const gridSize = 40; // Higher resolution for final render

		for (let v = 0; v < gridSize; v++) {
			for (let u = 0; u < gridSize; u++) {
				const u0 = u / gridSize;
				const v0 = v / gridSize;
				const u1 = (u + 1) / gridSize;
				const v1 = (v + 1) / gridSize;

				// Source quad
				const sx0 = layer.x + u0 * layer.w;
				const sy0 = layer.y + v0 * layer.h;
				const sx1 = layer.x + u1 * layer.w;
				const sy1 = layer.y + v1 * layer.h;

				// Destination quad
				const dx0y0 = {
					x: this.bilinearInterp(
						adjustedCorners.tl.x,
						adjustedCorners.tr.x,
						adjustedCorners.bl.x,
						adjustedCorners.br.x,
						u0,
						v0,
					),
					y: this.bilinearInterp(
						adjustedCorners.tl.y,
						adjustedCorners.tr.y,
						adjustedCorners.bl.y,
						adjustedCorners.br.y,
						u0,
						v0,
					),
				};
				const dx1y0 = {
					x: this.bilinearInterp(
						adjustedCorners.tl.x,
						adjustedCorners.tr.x,
						adjustedCorners.bl.x,
						adjustedCorners.br.x,
						u1,
						v0,
					),
					y: this.bilinearInterp(
						adjustedCorners.tl.y,
						adjustedCorners.tr.y,
						adjustedCorners.bl.y,
						adjustedCorners.br.y,
						u1,
						v0,
					),
				};
				const dx0y1 = {
					x: this.bilinearInterp(
						adjustedCorners.tl.x,
						adjustedCorners.tr.x,
						adjustedCorners.bl.x,
						adjustedCorners.br.x,
						u0,
						v1,
					),
					y: this.bilinearInterp(
						adjustedCorners.tl.y,
						adjustedCorners.tr.y,
						adjustedCorners.bl.y,
						adjustedCorners.br.y,
						u0,
						v1,
					),
				};
				const dx1y1 = {
					x: this.bilinearInterp(
						adjustedCorners.tl.x,
						adjustedCorners.tr.x,
						adjustedCorners.bl.x,
						adjustedCorners.br.x,
						u1,
						v1,
					),
					y: this.bilinearInterp(
						adjustedCorners.tl.y,
						adjustedCorners.tr.y,
						adjustedCorners.bl.y,
						adjustedCorners.br.y,
						u1,
						v1,
					),
				};

				// Draw this quad segment
				this.drawWarpedQuad(
					destCtx,
					sourceCanvas,
					sx0,
					sy0,
					sx1 - sx0,
					sy1 - sy0,
					dx0y0,
					dx1y0,
					dx0y1,
					dx1y1,
				);
			}
		}

		// Clear layer canvas and draw result
		const ctx = layer.canvas.getContext("2d")!;
		ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
		ctx.drawImage(destCanvas, 0, 0);

		// Update layer bounds
		layer.x = minX;
		layer.y = minY;
		layer.w = destW;
		layer.h = destH;

		// Clear srcDataUrl for image layers (they're now warped)
		if (layer.type === "image") {
			layer.srcDataUrl = undefined;
			this.layerSourceImages.delete(layer);
		}

		// Clear persistent resize source (warping is destructive)
		this.layerResizeSources.delete(layer);
	}

	private bilinearInterp(
		v00: number,
		v10: number,
		v01: number,
		v11: number,
		u: number,
		v: number,
	): number {
		// Bilinear interpolation formula
		// v00 = top-left, v10 = top-right, v01 = bottom-left, v11 = bottom-right
		const top = v00 * (1 - u) + v10 * u;
		const bottom = v01 * (1 - u) + v11 * u;
		return top * (1 - v) + bottom * v;
	}

	async executeBackgroundRemoval(
		model: "isnet" | "isnet_fp16" | "isnet_quint8",
	): Promise<void> {
		const id = this.bgRemovalLayerId();
		if (!id) return;

		this.showBgRemovalDialog.set(false);
		this.bgRemovalLayerId.set(null);

		const layer = this.layers().find((l) => l.id === id);
		if (!layer) return;

		try {
			// Save state for undo
			this.snapshot(layer.id);

			// Show processing indicator
			this.processingMessage.set("Removing background...");
			this.cdr.detectChanges();

			// Convert layer canvas to blob
			const dataUrl = layer.canvas.toDataURL("image/png");

			// Remove background using imgly
			const resultBlob = await removeBackground(dataUrl, {
				model,
				output: {
					format: "image/png",
					quality: 1,
				},
			});

			// Convert blob to permanent data URL (so it survives URL.revokeObjectURL)
			const reader = new FileReader();
			reader.onload = () => {
				const resultDataUrl = reader.result as string;
				const img = new Image();

				img.onload = () => {
					// Clear the layer canvas
					const ctx = layer.canvas.getContext("2d")!;
					ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);

					// Draw the background-removed image
					ctx.drawImage(img, layer.x, layer.y);

					// Update srcDataUrl for image layers with persistent data URL
					if (layer.type === "image") {
						layer.srcDataUrl = resultDataUrl;
					}

					this.composite();

					// Clear processing message
					this.processingMessage.set(null);
					this.cdr.detectChanges();
				};

				img.onerror = () => {
					console.error("Failed to load processed image");
					this.processingMessage.set(null);
					this.cdr.detectChanges();
				};

				img.src = resultDataUrl;
			};

			reader.onerror = () => {
				console.error("Failed to convert blob to data URL");
				this.processingMessage.set(null);
				this.cdr.detectChanges();
			};

			reader.readAsDataURL(resultBlob);
		} catch (error) {
			console.error("Background removal failed:", error);
			this.processingMessage.set(null);
			this.cdr.detectChanges();
		}
	}

	flattenAll(): void {
		const w = this.canvasWidth();
		const h = this.canvasHeight();
		const flatCanvas = makeCanvas(w, h);
		const flatCtx = flatCanvas.getContext("2d")!;
		const bg = this.backgroundColor();
		if (bg && bg !== "transparent") {
			flatCtx.fillStyle = bg;
			flatCtx.fillRect(0, 0, w, h);
		}
		const layers = this.layers();
		for (let i = layers.length - 1; i >= 0; i--) {
			this.compositeLayerToCtx(flatCtx, layers[i]);
		}
		const flatLayer: Layer = {
			id: newId(),
			name: "Flattened",
			type: "raster",
			canvas: flatCanvas,
			visible: true,
			opacity: 1,
			blendMode: "source-over",
			locked: false,
			x: 0,
			y: 0,
			w,
			h,
			rotation: 0,
		};
		this.initUndoStack(flatLayer.id);
		this.layers.set([flatLayer]);
		this.activeLayerId.set(flatLayer.id);
		this.composite();
		this.cdr.detectChanges();
	}

	addMask(id: string): void {
		this.layers.update((ls) =>
			ls.map((l) => {
				if (l.id !== id) return l;
				if (l.maskCanvas) return l;
				const mc = makeCanvas(l.canvas.width, l.canvas.height);
				const mctx = mc.getContext("2d")!;
				mctx.fillStyle = "#ffffff";
				mctx.fillRect(0, 0, mc.width, mc.height);
				return { ...l, maskCanvas: mc };
			}),
		);
		this.editingMask.set(true);
		this.cdr.detectChanges();
	}

	removeMask(id: string): void {
		this.layers.update((ls) =>
			ls.map((l) => (l.id !== id ? l : { ...l, maskCanvas: undefined })),
		);
		this.editingMask.set(false);
		this.composite();
		this.cdr.detectChanges();
	}

	toggleLayerVisibility(id: string): void {
		this.layers.update((ls) =>
			ls.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)),
		);
		this.composite();
		this.cdr.detectChanges();
	}

	setLayerOpacity(id: string, opacity: number): void {
		this.layers.update((ls) =>
			ls.map((l) => (l.id === id ? { ...l, opacity } : l)),
		);
		this.composite();
		this.cdr.detectChanges();
	}

	setLayerBlendMode(id: string, blendMode: GlobalCompositeOperation): void {
		this.layers.update((ls) =>
			ls.map((l) => (l.id === id ? { ...l, blendMode } : l)),
		);
		this.composite();
		this.cdr.detectChanges();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Image helpers
	// ─────────────────────────────────────────────────────────────────────────
	drawImageToLayer(layer: Layer, dataUrl: string, fit = true): void {
		const img = new Image();
		img.onload = () => {
			// Store the loaded image for high-quality resizing
			if (layer.srcDataUrl === dataUrl) {
				this.layerSourceImages.set(layer, img);
			}

			const ctx = layer.canvas.getContext("2d")!;

			// Enable high-quality image smoothing
			ctx.imageSmoothingEnabled = true;
			ctx.imageSmoothingQuality = "high";

			ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
			if (fit) {
				const scale = Math.min(
					this.canvasWidth() / img.width,
					this.canvasHeight() / img.height,
					1,
				);
				const dw = Math.round(img.width * scale);
				const dh = Math.round(img.height * scale);
				const dx = Math.round((this.canvasWidth() - dw) / 2);
				const dy = Math.round((this.canvasHeight() - dh) / 2);
				layer.x = dx;
				layer.y = dy;
				layer.w = dw;
				layer.h = dh;
				ctx.drawImage(img, dx, dy, dw, dh);
			} else {
				// Draw entire original image scaled to layer bounds
				ctx.drawImage(
					img,
					0,
					0,
					img.width,
					img.height,
					layer.x,
					layer.y,
					layer.w,
					layer.h,
				);
			}
			this.composite();
			this.cdr.detectChanges();
		};
		img.src = dataUrl;
	}

	triggerFileUpload(): void {
		this.fileInputRef.nativeElement.value = "";
		this.fileInputRef.nativeElement.click();
	}

	onFileSelected(event: Event): void {
		const input = event.target as HTMLInputElement;
		if (!input.files?.length) return;
		const file = input.files[0];
		const reader = new FileReader();
		reader.onload = (e) => {
			const dataUrl = e.target?.result as string;
			const name = file.name.replace(/\.[^.]+$/, "");
			const layer = this.addLayer("image", dataUrl, name);
			layer.srcDataUrl = dataUrl;
			this.cdr.detectChanges();
		};
		reader.readAsDataURL(file);
	}

	importFromUrl(): void {
		const url = this.importUrl().trim();
		if (!url) return;
		this.showUrlDialog.set(false);
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => {
			const tmp = makeCanvas(img.width, img.height);
			tmp.getContext("2d")!.drawImage(img, 0, 0);
			const dataUrl = tmp.toDataURL("image/png");
			const name = url.split("/").pop()?.replace(/\?.*/, "") ?? "URL Image";
			const layer = this.addLayer("image", dataUrl, name);
			layer.srcDataUrl = dataUrl;
			this.cdr.detectChanges();
		};
		img.onerror = () =>
			alert("Failed to load image from URL. Check CORS policy.");
		img.src = url;
	}

	async pasteFromClipboard(): Promise<void> {
		try {
			const clipboardItems = await navigator.clipboard.read();

			for (const item of clipboardItems) {
				// Look for image types
				const imageType = item.types.find((type) => type.startsWith("image/"));

				if (imageType) {
					const blob = await item.getType(imageType);

					// Convert blob to data URL
					const reader = new FileReader();
					reader.onload = () => {
						const dataUrl = reader.result as string;
						const img = new Image();

						img.onload = () => {
							const tmp = makeCanvas(img.width, img.height);
							tmp.getContext("2d")!.drawImage(img, 0, 0);
							const finalDataUrl = tmp.toDataURL("image/png");
							const layer = this.addLayer("image", finalDataUrl, "Pasted Image");
							layer.srcDataUrl = finalDataUrl;
							this.cdr.detectChanges();
						};

						img.onerror = () => {
							console.error("Failed to load pasted image");
						};

						img.src = dataUrl;
					};

					reader.onerror = () => {
						console.error("Failed to read clipboard blob");
					};

					reader.readAsDataURL(blob);
					return; // Only paste the first image found
				}
			}

			// No image found in clipboard
			console.log("No image found in clipboard");
		} catch (error) {
			console.error("Failed to read clipboard:", error);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Compositing
	// ─────────────────────────────────────────────────────────────────────────
	composite(): void {
		if (!this.displayCtx) {
			this.initContexts();
			if (!this.displayCtx) return;
		}
		const ctx = this.displayCtx;
		const w = this.canvasWidth();
		const h = this.canvasHeight();

		// Enable high-quality image smoothing for all compositing
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";

		// Draw checkerboard (transparency indicator)
		this.drawCheckerboard(ctx, w, h);

		// Background fill — skip when transparent
		const bg = this.backgroundColor();
		if (bg && bg !== "transparent") {
			ctx.save();
			ctx.globalCompositeOperation = "source-over";
			ctx.fillStyle = bg;
			ctx.fillRect(0, 0, w, h);
			ctx.restore();
		}

		// Draw layers bottom → top
		const layers = this.layers();
		for (let i = layers.length - 1; i >= 0; i--) {
			this.compositeLayerToCtx(ctx, layers[i]);
		}

		// Selection overlay for active layer
		const active = this.activeLayer();
		if (active && (this.currentTool() === "select" || this.resizingHandle)) {
			this.drawSelectionOverlay(ctx, active);
		}

		// Warp mode overlay
		if (this.isWarpMode() && this.warpCorners) {
			this.drawWarpOverlay(ctx);
		}
	}

	private compositeLayerToCtx(
		ctx: CanvasRenderingContext2D,
		layer: Layer,
	): void {
		if (!layer.visible) return;

		// Skip layer being warped (preview is drawn separately)
		if (this.isWarpMode() && layer.id === this.warpLayerId()) return;

		ctx.save();

		// Enable high-quality image smoothing
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";

		ctx.globalAlpha = layer.opacity;
		ctx.globalCompositeOperation = layer.blendMode;

		// Apply rotation if needed
		if (layer.rotation !== 0) {
			const centerX = layer.x + layer.w / 2;
			const centerY = layer.y + layer.h / 2;
			ctx.translate(centerX, centerY);
			ctx.rotate((layer.rotation * Math.PI) / 180);
			ctx.translate(-centerX, -centerY);
		}

		if (layer.maskCanvas) {
			const tmp = makeCanvas(this.canvasWidth(), this.canvasHeight());
			const tmpCtx = tmp.getContext("2d")!;
			tmpCtx.drawImage(layer.canvas, 0, 0);
			tmpCtx.globalCompositeOperation = "destination-in";
			tmpCtx.drawImage(layer.maskCanvas, 0, 0);
			ctx.drawImage(tmp, 0, 0);
		} else {
			ctx.drawImage(layer.canvas, 0, 0);
		}
		ctx.restore();
	}

	private drawCheckerboard(
		ctx: CanvasRenderingContext2D,
		w: number,
		h: number,
	): void {
		const size = 16;
		for (let y = 0; y < h; y += size) {
			for (let x = 0; x < w; x += size) {
				ctx.fillStyle = (x / size + y / size) % 2 === 0 ? "#cccccc" : "#ffffff";
				ctx.fillRect(x, y, size, size);
			}
		}
	}

	private drawSelectionOverlay(
		ctx: CanvasRenderingContext2D,
		layer: Layer,
	): void {
		ctx.save();
		const z = this.zoom();
		const pad = 2 / z;
		const x = layer.x - pad;
		const y = layer.y - pad;
		const w = layer.w + pad * 2;
		const h = layer.h + pad * 2;

		// Dashed bounding box
		ctx.strokeStyle = "rgba(100,160,255,0.85)";
		ctx.lineWidth = 1.5 / z;
		ctx.setLineDash([6 / z, 3 / z]);
		ctx.strokeRect(x, y, w, h);

		// Resize handles
		const hs = 8 / z;
		ctx.setLineDash([]);
		ctx.lineWidth = 1.5 / z;

		if (layer.type === "text") {
			// Text layers: only show bottom-right handle for font size scaling
			const pos = { x: layer.x + layer.w, y: layer.y + layer.h };
			ctx.fillStyle = "#1a1a22";
			ctx.fillRect(pos.x - hs / 2, pos.y - hs / 2, hs, hs);
			ctx.strokeStyle = "rgba(120,170,255,0.95)";
			ctx.strokeRect(pos.x - hs / 2, pos.y - hs / 2, hs, hs);
		} else {
			// Image/raster layers: show all 8 resize handles
			for (const pos of Object.values(this.getHandlePositions(layer))) {
				ctx.fillStyle = "#1a1a22";
				ctx.fillRect(pos.x - hs / 2, pos.y - hs / 2, hs, hs);
				ctx.strokeStyle = "rgba(120,170,255,0.95)";
				ctx.strokeRect(pos.x - hs / 2, pos.y - hs / 2, hs, hs);
			}
		}

		// Rotation handle (circle above top-center)
		const rotatePos = this.getRotateHandlePos(layer);
		ctx.beginPath();
		ctx.arc(rotatePos.x, rotatePos.y, hs * 0.75, 0, Math.PI * 2);
		ctx.fillStyle = "#1a1a22";
		ctx.fill();
		ctx.strokeStyle = "rgba(120,255,170,0.95)";
		ctx.stroke();

		// Line connecting rotation handle to top edge
		ctx.beginPath();
		ctx.moveTo(layer.x + layer.w / 2, layer.y);
		ctx.lineTo(rotatePos.x, rotatePos.y);
		ctx.strokeStyle = "rgba(100,160,255,0.4)";
		ctx.setLineDash([3 / z, 3 / z]);
		ctx.stroke();

		ctx.restore();
	}

	private getRotateHandlePos(layer: Layer): { x: number; y: number } {
		const z = this.zoom();
		const offset = 30 / z; // Distance above the layer
		return {
			x: layer.x + layer.w / 2,
			y: layer.y - offset,
		};
	}

	private drawWarpOverlay(ctx: CanvasRenderingContext2D): void {
		if (!this.warpCorners) return;

		const layer = this.layers().find((l) => l.id === this.warpLayerId());
		if (!layer) return;

		ctx.save();
		const z = this.zoom();
		const { tl, tr, bl, br } = this.warpCorners;

		// Draw warped preview using canvas transform
		// Sample the layer content and draw it warped
		const gridSize = 20; // Grid resolution for warping

		for (let v = 0; v < gridSize; v++) {
			for (let u = 0; u < gridSize; u++) {
				const u0 = u / gridSize;
				const v0 = v / gridSize;
				const u1 = (u + 1) / gridSize;
				const v1 = (v + 1) / gridSize;

				// Source quad (in layer coordinates)
				const sx0 = layer.x + u0 * layer.w;
				const sy0 = layer.y + v0 * layer.h;
				const sx1 = layer.x + u1 * layer.w;
				const sy1 = layer.y + v1 * layer.h;

				// Destination quad (warped corners)
				const dx0y0 = {
					x: this.bilinearInterp(tl.x, tr.x, bl.x, br.x, u0, v0),
					y: this.bilinearInterp(tl.y, tr.y, bl.y, br.y, u0, v0),
				};
				const dx1y0 = {
					x: this.bilinearInterp(tl.x, tr.x, bl.x, br.x, u1, v0),
					y: this.bilinearInterp(tl.y, tr.y, bl.y, br.y, u1, v0),
				};
				const dx0y1 = {
					x: this.bilinearInterp(tl.x, tr.x, bl.x, br.x, u0, v1),
					y: this.bilinearInterp(tl.y, tr.y, bl.y, br.y, u0, v1),
				};
				const dx1y1 = {
					x: this.bilinearInterp(tl.x, tr.x, bl.x, br.x, u1, v1),
					y: this.bilinearInterp(tl.y, tr.y, bl.y, br.y, u1, v1),
				};

				// Use transform to draw this quad
				ctx.save();
				this.drawWarpedQuad(
					ctx,
					layer.canvas,
					sx0,
					sy0,
					sx1 - sx0,
					sy1 - sy0,
					dx0y0,
					dx1y0,
					dx0y1,
					dx1y1,
				);
				ctx.restore();
			}
		}

		// Draw quadrilateral outline
		ctx.strokeStyle = "rgba(100,160,255,0.85)";
		ctx.lineWidth = 2 / z;
		ctx.setLineDash([6 / z, 3 / z]);
		ctx.beginPath();
		ctx.moveTo(tl.x, tl.y);
		ctx.lineTo(tr.x, tr.y);
		ctx.lineTo(br.x, br.y);
		ctx.lineTo(bl.x, bl.y);
		ctx.closePath();
		ctx.stroke();

		// Draw corner handles (larger circles for easier dragging)
		const hs = 10 / z;
		ctx.setLineDash([]);
		ctx.lineWidth = 2 / z;

		for (const pos of [tl, tr, bl, br]) {
			ctx.beginPath();
			ctx.arc(pos.x, pos.y, hs, 0, Math.PI * 2);
			ctx.fillStyle = "#1a1a22";
			ctx.fill();
			ctx.strokeStyle = "rgba(100,255,255,0.95)";
			ctx.stroke();
		}

		ctx.restore();
	}

	private drawWarpedQuad(
		ctx: CanvasRenderingContext2D,
		sourceCanvas: HTMLCanvasElement,
		sx: number,
		sy: number,
		sw: number,
		sh: number,
		p0: { x: number; y: number },
		p1: { x: number; y: number },
		p2: { x: number; y: number },
		p3: { x: number; y: number },
	): void {
		// Draw a source rectangle warped to a destination quadrilateral
		// Using triangulation (split quad into 2 triangles)

		// Triangle 1: p0, p1, p2
		this.drawTriangle(ctx, sourceCanvas, sx, sy, sw, sh, p0, p1, p2, 0);
		// Triangle 2: p1, p3, p2
		this.drawTriangle(ctx, sourceCanvas, sx, sy, sw, sh, p1, p3, p2, 1);
	}

	private drawTriangle(
		ctx: CanvasRenderingContext2D,
		sourceCanvas: HTMLCanvasElement,
		sx: number,
		sy: number,
		sw: number,
		sh: number,
		p0: { x: number; y: number },
		p1: { x: number; y: number },
		p2: { x: number; y: number },
		triIndex: number,
	): void {
		// Map triangle to texture coordinates
		let t0x, t0y, t1x, t1y, t2x, t2y;

		if (triIndex === 0) {
			// Top-left triangle
			t0x = sx;
			t0y = sy;
			t1x = sx + sw;
			t1y = sy;
			t2x = sx;
			t2y = sy + sh;
		} else {
			// Bottom-right triangle
			t0x = sx + sw;
			t0y = sy;
			t1x = sx + sw;
			t1y = sy + sh;
			t2x = sx;
			t2y = sy + sh;
		}

		// Draw textured triangle
		ctx.save();
		ctx.beginPath();
		ctx.moveTo(p0.x, p0.y);
		ctx.lineTo(p1.x, p1.y);
		ctx.lineTo(p2.x, p2.y);
		ctx.closePath();
		ctx.clip();

		// Calculate transform matrix for texture mapping
		const denom = (t0x - t2x) * (t1y - t2y) - (t1x - t2x) * (t0y - t2y);
		if (Math.abs(denom) < 0.0001) {
			ctx.restore();
			return;
		}

		const m11 =
			((p0.x - p2.x) * (t1y - t2y) - (p1.x - p2.x) * (t0y - t2y)) / denom;
		const m12 =
			((t0x - t2x) * (p1.x - p2.x) - (t1x - t2x) * (p0.x - p2.x)) / denom;
		const m21 =
			((p0.y - p2.y) * (t1y - t2y) - (p1.y - p2.y) * (t0y - t2y)) / denom;
		const m22 =
			((t0x - t2x) * (p1.y - p2.y) - (t1x - t2x) * (p0.y - p2.y)) / denom;
		const dx = p2.x - m11 * t2x - m12 * t2y;
		const dy = p2.y - m21 * t2x - m22 * t2y;

		ctx.transform(m11, m21, m12, m22, dx, dy);
		ctx.drawImage(sourceCanvas, 0, 0);
		ctx.restore();
	}

	private getHandlePositions(
		layer: Layer,
	): Record<ResizeHandle, { x: number; y: number }> {
		const { x, y, w, h } = layer;
		return {
			tl: { x, y },
			tc: { x: x + w / 2, y },
			tr: { x: x + w, y },
			ml: { x, y: y + h / 2 },
			mr: { x: x + w, y: y + h / 2 },
			bl: { x, y: y + h },
			bc: { x: x + w / 2, y: y + h },
			br: { x: x + w, y: y + h },
		};
	}

	private getHandleAtPos(
		layer: Layer,
		cx: number,
		cy: number,
	): ResizeHandle | null {
		const hit = 10 / this.zoom();

		if (layer.type === "text") {
			// Text layers: only check bottom-right handle for font scaling
			const pos = { x: layer.x + layer.w, y: layer.y + layer.h };
			if (Math.abs(cx - pos.x) <= hit / 2 && Math.abs(cy - pos.y) <= hit / 2) {
				return "br";
			}
			return null;
		}

		// Image/raster layers: check all handles
		const positions = this.getHandlePositions(layer);
		for (const [handle, pos] of Object.entries(positions) as [
			ResizeHandle,
			{ x: number; y: number },
		][]) {
			if (Math.abs(cx - pos.x) <= hit / 2 && Math.abs(cy - pos.y) <= hit / 2) {
				return handle;
			}
		}
		return null;
	}

	private computeResizeBounds(
		s: { x: number; y: number; w: number; h: number },
		handle: ResizeHandle,
		dx: number,
		dy: number,
		lockRatio = false,
	): { x: number; y: number; w: number; h: number } {
		let { x, y, w, h } = s;
		const ratio = s.w / s.h;

		switch (handle) {
			case "tl":
				x += dx;
				y += dy;
				w -= dx;
				h -= dy;
				break;
			case "tc":
				y += dy;
				h -= dy;
				break;
			case "tr":
				y += dy;
				w += dx;
				h -= dy;
				break;
			case "ml":
				x += dx;
				w -= dx;
				break;
			case "mr":
				w += dx;
				break;
			case "bl":
				x += dx;
				w -= dx;
				h += dy;
				break;
			case "bc":
				h += dy;
				break;
			case "br":
				w += dx;
				h += dy;
				break;
		}

		if (lockRatio && ratio > 0) {
			// Corner handles: fit to whichever axis changed more, keep ratio
			const isCorner = ["tl", "tr", "bl", "br"].includes(handle);
			const isHoriz = ["ml", "mr"].includes(handle);
			const isVert = ["tc", "bc"].includes(handle);

			if (isCorner) {
				// Use the larger delta to drive the resize
				if (Math.abs(w - s.w) / ratio >= Math.abs(h - s.h)) {
					const newW = Math.max(w, 4);
					const newH = Math.round(newW / ratio);
					// Reanchor the fixed corner
					if (handle === "tl") {
						x = s.x + s.w - newW;
						y = s.y + s.h - newH;
					}
					if (handle === "tr") {
						y = s.y + s.h - newH;
					}
					if (handle === "bl") {
						x = s.x + s.w - newW;
					}
					w = newW;
					h = newH;
				} else {
					const newH = Math.max(h, 4);
					const newW = Math.round(newH * ratio);
					if (handle === "tl") {
						x = s.x + s.w - newW;
						y = s.y + s.h - newH;
					}
					if (handle === "tr") {
						y = s.y + s.h - newH;
					}
					if (handle === "bl") {
						x = s.x + s.w - newW;
					}
					w = newW;
					h = newH;
				}
			} else if (isHoriz) {
				// Horizontal handle drives width, derive height
				const newW = Math.max(w, 4);
				const newH = Math.round(newW / ratio);
				y = s.y + (s.h - newH) / 2;
				w = newW;
				h = newH;
			} else if (isVert) {
				// Vertical handle drives height, derive width
				const newH = Math.max(h, 4);
				const newW = Math.round(newH * ratio);
				x = s.x + (s.w - newW) / 2;
				w = newW;
				h = newH;
			}
		}

		return { x, y, w: Math.max(w, 4), h: Math.max(h, 4) };
	}

	private applyResizeToCanvas(
		layer: Layer,
		bounds: { x: number; y: number; w: number; h: number },
	): void {
		const ctx = layer.canvas.getContext("2d")!;
		ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);

		// Enable high-quality image smoothing
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";

		// Image layers: use original high-res source for quality
		if (layer.type === "image" && layer.srcDataUrl && this.resizeSourceImg) {
			// Draw the entire original image (full resolution) scaled to fit the new bounds
			// Use 9-parameter version: source rect from full image, dest rect at new size
			ctx.drawImage(
				this.resizeSourceImg,
				0,
				0,
				this.resizeSourceImg.width,
				this.resizeSourceImg.height, // source: entire original image
				bounds.x,
				bounds.y,
				bounds.w,
				bounds.h, // dest: new position and size
			);
		} else if (this.resizeSourceCanvas) {
			// Raster layers: draw from captured canvas
			// Extract the content from the original bounds and scale to new bounds
			const origX = this.resizeStartBounds.x;
			const origY = this.resizeStartBounds.y;
			const origW = this.resizeStartBounds.w;
			const origH = this.resizeStartBounds.h;

			ctx.drawImage(
				this.resizeSourceCanvas,
				origX,
				origY,
				origW,
				origH, // source rect (what to copy)
				bounds.x,
				bounds.y,
				bounds.w,
				bounds.h, // dest rect (where to put it)
			);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Drawing tools
	// ─────────────────────────────────────────────────────────────────────────
	getCanvasPos(e: PointerEvent | MouseEvent): { x: number; y: number } {
		const rect = this.interactionCanvasRef.nativeElement.getBoundingClientRect();
		const x = (e.clientX - rect.left) * (this.canvasWidth() / rect.width);
		const y = (e.clientY - rect.top) * (this.canvasHeight() / rect.height);
		return { x, y };
	}

	onPointerDown(e: PointerEvent): void {
		e.preventDefault();
		if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
			this.isPanning = true;
			this.panStartX = e.clientX;
			this.panStartY = e.clientY;
			this.panStartPX = this.panX();
			this.panStartPY = this.panY();
			return;
		}
		if (e.button === 2) return; // handled by contextmenu event

		const { x, y } = this.getCanvasPos(e);
		const layer = this.activeLayer();
		const tool = this.currentTool();

		// Warp mode - check for corner dragging
		if (this.isWarpMode() && this.warpCorners) {
			const z = this.zoom();
			const hitRadius = 15 / z;

			for (const [corner, pos] of Object.entries(this.warpCorners) as [
				"tl" | "tr" | "bl" | "br",
				{ x: number; y: number },
			][]) {
				const dist = Math.sqrt((x - pos.x) ** 2 + (y - pos.y) ** 2);
				if (dist <= hitRadius) {
					this.warpDraggingCorner = corner;
					this.interactionCanvasRef.nativeElement.setPointerCapture(e.pointerId);
					return;
				}
			}
		}

		if (tool === "select") {
			if (layer) {
				// Check rotation handle first
				const rotatePos = this.getRotateHandlePos(layer);
				const z = this.zoom();
				const rotateRadius = 8 / z;
				const dist = Math.sqrt((x - rotatePos.x) ** 2 + (y - rotatePos.y) ** 2);

				if (dist <= rotateRadius) {
					this.isRotating = true;
					const centerX = layer.x + layer.w / 2;
					const centerY = layer.y + layer.h / 2;
					this.rotateStartAngle = Math.atan2(y - centerY, x - centerX);
					this.rotateStartRotation = layer.rotation;
					this.snapshot(layer.id);
					this.interactionCanvasRef.nativeElement.setPointerCapture(e.pointerId);
					return;
				}

				const handle = this.getHandleAtPos(layer, x, y);
				if (handle) {
					// Special handling for text layer font scaling
					if (layer.type === "text" && handle === "br") {
						this.isScalingTextFont = true;
						this.resizeStartX = x;
						this.resizeStartY = y;
						const centerX = layer.x + layer.w / 2;
						const centerY = layer.y + layer.h / 2;
						this.textScaleStartDist = Math.sqrt(
							(x - centerX) ** 2 + (y - centerY) ** 2,
						);
						this.textScaleStartFontSize = layer.textStyle?.fontSize ?? 32;
						this.snapshot(layer.id);
						this.interactionCanvasRef.nativeElement.setPointerCapture(e.pointerId);
						return;
					}

					// Normal resize for image/raster layers
					this.resizingHandle = handle;
					this.resizeStartX = x;
					this.resizeStartY = y;
					this.resizeStartBounds = {
						x: layer.x,
						y: layer.y,
						w: layer.w,
						h: layer.h,
					};
					this.snapshot(layer.id);

					// Use persistent resize source if available, otherwise create it
					if (!this.layerResizeSources.has(layer)) {
						const pristineCanvas = makeCanvas(
							layer.canvas.width,
							layer.canvas.height,
						);
						pristineCanvas.getContext("2d")!.drawImage(layer.canvas, 0, 0);
						this.layerResizeSources.set(layer, pristineCanvas);
					}

					// Capture source for this resize operation
					this.resizeSourceCanvas = this.layerResizeSources.get(layer)!;

					// For image layers, use the pre-loaded high-res image from WeakMap
					if (layer.type === "image" && this.layerSourceImages.has(layer)) {
						this.resizeSourceImg = this.layerSourceImages.get(layer)!;
					} else {
						this.resizeSourceImg = null;
					}

					this.interactionCanvasRef.nativeElement.setPointerCapture(e.pointerId);
					return;
				}
			}
			this.isDraggingLayer = true;
			this.dragStartX = x;
			this.dragStartY = y;
			this.dragLayerInitX = layer?.x ?? 0;
			this.dragLayerInitY = layer?.y ?? 0;
			return;
		}

		if (tool === "text") {
			// If clicking an existing text layer, edit it; otherwise create new
			const hit = this.textLayerAtPos(x, y);
			if (hit) {
				this.openTextEdit(hit, hit.x, hit.y);
			} else {
				this.openTextEdit(null, x, y);
			}
			return;
		}

		if (!layer || layer.locked) return;

		if (tool === "fill") {
			this.snapshot(layer.id);
			// Clear srcDataUrl for image layers when filling
			if (layer.type === "image" && layer.srcDataUrl) {
				layer.srcDataUrl = undefined;
				this.layerSourceImages.delete(layer);
			}
			// Clear persistent resize source (filling is destructive)
			this.layerResizeSources.delete(layer);
			this.floodFill(layer, Math.round(x), Math.round(y), this.brushColor());
			return;
		}

		if (tool === "eyedropper") {
			this.pickColor(x, y);
			return;
		}

		this.isDrawing = true;
		this.lastX = x;
		this.lastY = y;
		this.snapshot(layer.id);

		// Clear srcDataUrl for image layers when drawing/erasing
		// This makes the layer "destructive" - can no longer resize from original
		if (layer.type === "image" && layer.srcDataUrl) {
			layer.srcDataUrl = undefined;
			this.layerSourceImages.delete(layer);
		}

		// Clear persistent resize source (drawing/erasing is destructive)
		this.layerResizeSources.delete(layer);

		this.applyStroke(layer, x, y, x, y);

		this.interactionCanvasRef.nativeElement.setPointerCapture(e.pointerId);
	}

	onPointerMove(e: PointerEvent): void {
		// Always track screen position for the cursor overlay
		this.cursorScreenX.set(e.clientX);
		this.cursorScreenY.set(e.clientY);

		if (this.isPanning) {
			const dx = e.clientX - this.panStartX;
			const dy = e.clientY - this.panStartY;
			this.panX.set(this.panStartPX + dx);
			this.panY.set(this.panStartPY + dy);
			this.cdr.detectChanges();
			return;
		}

		const { x, y } = this.getCanvasPos(e);

		// ── Warp Corner Dragging ──────────────────────────────────────────────
		if (this.warpDraggingCorner && this.warpCorners) {
			this.warpCorners[this.warpDraggingCorner] = { x, y };
			this.composite();
			this.cdr.detectChanges();
			return;
		}

		// ── Rotation ──────────────────────────────────────────────────────────
		if (this.isRotating) {
			const layer = this.activeLayer();
			if (layer) {
				const centerX = layer.x + layer.w / 2;
				const centerY = layer.y + layer.h / 2;
				const currentAngle = Math.atan2(y - centerY, x - centerX);
				const deltaAngle = currentAngle - this.rotateStartAngle;
				let newRotation = this.rotateStartRotation + (deltaAngle * 180) / Math.PI;

				// Snap to 15-degree increments if Shift is held
				if (this.shiftDown) {
					newRotation = Math.round(newRotation / 15) * 15;
				}

				// Normalize to -180 to 180
				while (newRotation > 180) newRotation -= 360;
				while (newRotation < -180) newRotation += 360;

				layer.rotation = newRotation;
				this.composite();
				this.cdr.detectChanges();
			}
			return;
		}

		// ── Text Font Scaling ─────────────────────────────────────────────────
		if (this.isScalingTextFont) {
			const layer = this.activeLayer();
			if (layer && layer.type === "text" && layer.text && layer.textStyle) {
				const centerX = layer.x + layer.w / 2;
				const centerY = layer.y + layer.h / 2;
				const currentDist = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
				const scale = currentDist / this.textScaleStartDist;
				const newFontSize = Math.max(
					8,
					Math.min(1000, Math.round(this.textScaleStartFontSize * scale)),
				);

				// Update font size and re-render
				const updatedStyle = { ...layer.textStyle, fontSize: newFontSize };
				layer.textStyle = updatedStyle;
				this.renderTextToLayer(layer, layer.text, updatedStyle);
				this.composite();
				this.cdr.detectChanges();
			}
			return;
		}

		// ── Resize ────────────────────────────────────────────────────────────
		if (this.resizingHandle) {
			const layer = this.activeLayer();
			if (layer) {
				const dx = x - this.resizeStartX;
				const dy = y - this.resizeStartY;

				// Prevent resize on accidental click without drag (minimum 2px movement)
				const dragDist = Math.sqrt(dx * dx + dy * dy);
				if (dragDist < 2) {
					return;
				}

				const nb = this.computeResizeBounds(
					this.resizeStartBounds,
					this.resizingHandle,
					dx,
					dy,
					this.shiftDown,
				);
				if (nb.w > 4 && nb.h > 4) {
					layer.x = nb.x;
					layer.y = nb.y;
					layer.w = nb.w;
					layer.h = nb.h;
					this.applyResizeToCanvas(layer, nb);
					this.composite();
					this.cdr.detectChanges();
				}
			}
			return;
		}

		// ── Update hovered handle for cursor ──────────────────────────────────
		if (
			!this.isDrawing &&
			!this.isDraggingLayer &&
			this.currentTool() === "select"
		) {
			const active = this.activeLayer();
			const hovered = active ? this.getHandleAtPos(active, x, y) : null;
			if (hovered !== this.hoveredHandle()) {
				this.hoveredHandle.set(hovered);
				this.cdr.detectChanges();
			}
			// Show text cursor when hovering any text layer
			const onText = !!this.textLayerAtPos(x, y);
			if (onText !== this.hoveredTextLayer()) {
				this.hoveredTextLayer.set(onText);
				this.cdr.detectChanges();
			}
		}

		if (this.isDraggingLayer) {
			const layer = this.activeLayer();
			if (layer) {
				// Round to integers to prevent sub-pixel blurriness
				const newX = Math.round(this.dragLayerInitX + x - this.dragStartX);
				const newY = Math.round(this.dragLayerInitY + y - this.dragStartY);
				this.translateLayerCanvas(layer, newX, newY);
				this.composite();
				this.cdr.detectChanges();
			}
			return;
		}

		if (!this.isDrawing) return;
		const layer = this.activeLayer();
		if (!layer || layer.locked) return;

		this.applyStroke(layer, this.lastX, this.lastY, x, y);
		this.lastX = x;
		this.lastY = y;
	}

	onPointerUp(e: PointerEvent): void {
		this.isPanning = false;
		this.isDraggingLayer = false;
		this.isRotating = false;
		this.isScalingTextFont = false;
		this.warpDraggingCorner = null;
		if (this.resizingHandle) {
			const layer = this.activeLayer();
			if (layer) {
				// For raster layers, update the pristine resize source with current state
				// For image layers with srcDataUrl, we keep the original - don't update
				if (layer.type !== "image" || !layer.srcDataUrl) {
					const pristineCanvas = makeCanvas(layer.canvas.width, layer.canvas.height);
					pristineCanvas.getContext("2d")!.drawImage(layer.canvas, 0, 0);
					this.layerResizeSources.set(layer, pristineCanvas);
				}
			}

			this.resizingHandle = null;
			this.resizeSourceCanvas = null;
			this.resizeSourceImg = null;
			return;
		}
		if (!this.isDrawing) return;
		this.isDrawing = false;
		const layer = this.activeLayer();
		if (layer) {
			const ctx = this.getLayerDrawCtx(layer);
			if (ctx) {
				ctx.beginPath();
			}
		}
	}

	onDblClick(e: MouseEvent): void {
		if (this.currentTool() !== "select") return;
		const { x, y } = this.getCanvasPos(e);
		const hit = this.textLayerAtPos(x, y);
		if (hit) {
			this.activeLayerId.set(hit.id);
			this.openTextEdit(hit, hit.x, hit.y);
		}
	}

	private translateLayerCanvas(layer: Layer, newX: number, newY: number): void {
		// For image layers with original source, redraw from source at new position
		if (layer.type === "image" && layer.srcDataUrl) {
			layer.x = newX;
			layer.y = newY;
			this.drawImageToLayer(layer, layer.srcDataUrl, false);
			return;
		}

		// For text layers, update position and re-render text
		if (layer.type === "text" && layer.text && layer.textStyle) {
			layer.x = newX;
			layer.y = newY;
			this.renderTextToLayer(layer, layer.text, layer.textStyle);
			return;
		}

		// For raster layers (or layers without source), move pixels
		const cw = layer.canvas.width;
		const ch = layer.canvas.height;
		const dx = newX - layer.x;
		const dy = newY - layer.y;

		const tmp = makeCanvas(cw, ch);
		tmp.getContext("2d")!.drawImage(layer.canvas, dx, dy);
		layer.canvas.getContext("2d")!.clearRect(0, 0, cw, ch);
		layer.canvas.getContext("2d")!.drawImage(tmp, 0, 0);
		layer.x = newX;
		layer.y = newY;
	}

	private applyStroke(
		layer: Layer,
		x0: number,
		y0: number,
		x1: number,
		y1: number,
	): void {
		const ctx = this.getLayerDrawCtx(layer);
		if (!ctx) return;
		const tool = this.currentTool();
		const size = this.brushSize();

		ctx.beginPath();
		ctx.moveTo(x0, y0);
		ctx.lineTo(x1, y1);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.lineWidth = size;

		if (tool === "eraser") {
			ctx.globalCompositeOperation = "destination-out";
			ctx.strokeStyle = "rgba(0,0,0,1)";
		} else {
			ctx.globalCompositeOperation = "source-over";
			ctx.globalAlpha = this.brushOpacity();
			ctx.strokeStyle = this.brushColor();
		}
		ctx.stroke();
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
		this.composite();
	}

	private getLayerDrawCtx(layer: Layer): CanvasRenderingContext2D | null {
		const target =
			this.editingMask() && layer.maskCanvas ? layer.maskCanvas : layer.canvas;
		return target.getContext("2d");
	}

	private pickColor(x: number, y: number): void {
		if (!this.displayCtx) return;
		const px = Math.round(x);
		const py = Math.round(y);
		const data = this.displayCtx.getImageData(px, py, 1, 1).data;
		const hex =
			"#" +
			[data[0], data[1], data[2]]
				.map((v) => v.toString(16).padStart(2, "0"))
				.join("");
		this.brushColor.set(hex);
		this.currentTool.set("brush");
		this.cdr.detectChanges();
	}

	private floodFill(
		layer: Layer,
		sx: number,
		sy: number,
		fillColor: string,
	): void {
		const canvas = layer.canvas;
		const ctx = canvas.getContext("2d")!;
		const w = canvas.width;
		const h = canvas.height;
		const imageData = ctx.getImageData(0, 0, w, h);
		const data = imageData.data;
		const targetIdx = (sy * w + sx) * 4;
		const tr = data[targetIdx],
			tg = data[targetIdx + 1],
			tb = data[targetIdx + 2],
			ta = data[targetIdx + 3];

		const [fr, fg, fb] = this.hexToRgb(fillColor);
		if (tr === fr && tg === fg && tb === fb && ta === 255) return;

		const tolerance = 30;
		const match = (idx: number) =>
			Math.abs(data[idx] - tr) <= tolerance &&
			Math.abs(data[idx + 1] - tg) <= tolerance &&
			Math.abs(data[idx + 2] - tb) <= tolerance &&
			Math.abs(data[idx + 3] - ta) <= tolerance;

		const stack = [sy * w + sx];
		const visited = new Uint8Array(w * h);
		while (stack.length) {
			const pos = stack.pop()!;
			if (visited[pos]) continue;
			visited[pos] = 1;
			const x = pos % w,
				y = Math.floor(pos / w);
			const idx = pos * 4;
			if (!match(idx)) continue;
			data[idx] = fr;
			data[idx + 1] = fg;
			data[idx + 2] = fb;
			data[idx + 3] = 255;
			if (x > 0) stack.push(pos - 1);
			if (x < w - 1) stack.push(pos + 1);
			if (y > 0) stack.push(pos - w);
			if (y < h - 1) stack.push(pos + w);
		}
		ctx.putImageData(imageData, 0, 0);
		this.composite();
		this.cdr.detectChanges();
	}

	private hexToRgb(hex: string): [number, number, number] {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return [r, g, b];
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Text tool
	// ─────────────────────────────────────────────────────────────────────────

	/** Find the topmost text layer whose bounding box contains (cx, cy) */
	private textLayerAtPos(cx: number, cy: number): Layer | null {
		const layers = this.layers();
		for (const layer of layers) {
			if (layer.type !== "text" || !layer.visible) continue;
			if (
				cx >= layer.x &&
				cx <= layer.x + layer.w &&
				cy >= layer.y &&
				cy <= layer.y + layer.h
			) {
				return layer;
			}
		}
		return null;
	}

	/** Open the text overlay — pass existing layer to edit it, null to create new */
	openTextEdit(
		existingLayer: Layer | null,
		canvasX: number,
		canvasY: number,
	): void {
		// Always switch to text tool so format bar appears
		this.currentTool.set("text");

		// Pre-fill style and value from existing layer
		if (existingLayer) {
			this.textEditingLayerId.set(existingLayer.id);
			this.textEditValue.set(existingLayer.text ?? "");
			if (existingLayer.textStyle) {
				const s = existingLayer.textStyle;
				// Fill in any fields added after the layer was saved
				this.textStyle.set({
					fontSize: s.fontSize,
					fontFamily: s.fontFamily,
					color: s.color,
					bold: s.bold,
					italic: s.italic,
					align: s.align,
					underline: s.underline ?? false,
					strikethrough: s.strikethrough ?? false,
					letterSpacing: s.letterSpacing ?? 0,
					lineHeight: s.lineHeight ?? 1.25,
				});
			}
			this.activeLayerId.set(existingLayer.id);
		} else {
			this.textEditingLayerId.set(null);
			this.textEditValue.set("");
		}

		this.textEditX.set(canvasX);
		this.textEditY.set(canvasY);

		// Compute fixed screen coords
		const rect = this.displayCanvasRef.nativeElement.getBoundingClientRect();
		const scaleX = rect.width / this.canvasWidth();
		const scaleY = rect.height / this.canvasHeight();
		this.textScreenX.set(rect.left + canvasX * scaleX);
		this.textScreenY.set(rect.top + canvasY * scaleY);

		this.textEditActive.set(true);
		this.cdr.detectChanges();
		setTimeout(() => {
			const ta = this.textInputRef?.nativeElement;
			if (ta) {
				// Set value once, imperatively — no binding will ever overwrite it
				ta.value = this.textEditValue();
				ta.focus();
				// Place cursor at end for edits, start for new
				const pos = existingLayer ? ta.value.length : 0;
				ta.setSelectionRange(pos, pos);
			}
			this.cdr.detectChanges();
		}, 30);
	}

	confirmText(): void {
		const txt = this.textEditValue().trim();
		this.textEditActive.set(false);

		const editingId = this.textEditingLayerId();
		this.textEditingLayerId.set(null);

		if (!txt) {
			this.cdr.detectChanges();
			return;
		}

		const style = this.textStyle();
		const w = this.canvasWidth();
		const h = this.canvasHeight();

		// ── Editing existing layer ──────────────────────────────────────────
		if (editingId) {
			const existing = this.layers().find((l) => l.id === editingId);
			if (existing) {
				this.snapshot(existing.id);
				existing.text = txt;
				existing.textStyle = { ...style };
				this.renderTextToLayer(existing, txt, style);
				this.composite();
				this.cdr.detectChanges();
				return;
			}
		}

		// ── Creating a new layer ────────────────────────────────────────────
		const layer = this.addLayer("text", undefined, "Text");
		layer.text = txt;
		layer.textStyle = { ...style };
		layer.x = Math.round(this.textEditX());
		layer.y = Math.round(this.textEditY());
		this.renderTextToLayer(layer, txt, style);
		this.composite();
		this.cdr.detectChanges();
	}

	/** Render text string + style onto a layer's canvas */
	private renderTextToLayer(layer: Layer, txt: string, style: TextStyle): void {
		const ctx = layer.canvas.getContext("2d")!;
		ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);

		const font = `${style.italic ? "italic " : ""}${style.bold ? "bold " : ""}${style.fontSize}px ${style.fontFamily}`;
		ctx.font = font;
		ctx.fillStyle = style.color;
		ctx.textAlign = "left"; // always measure from left, handle align manually
		ctx.textBaseline = "top";

		const lineH = style.fontSize * (style.lineHeight ?? 1.25);
		const lines = txt.split("\n");

		// Measure max width for bounding box and alignment
		let maxW = 0;
		const widths: number[] = lines.map((line) => {
			const w = this.measureTextWithSpacing(ctx, line, style.letterSpacing ?? 0);
			if (w > maxW) maxW = w;
			return w;
		});

		layer.w = Math.max(Math.round(maxW) + 4, 10);
		layer.h = Math.max(Math.round(lines.length * lineH) + 4, 10);

		// Ensure layer position is pixel-aligned to prevent blurriness
		layer.x = Math.round(layer.x);
		layer.y = Math.round(layer.y);

		lines.forEach((line, i) => {
			// Round all positions to integers for crisp rendering
			const y = Math.round(layer.y + i * lineH);
			const lw = widths[i];

			// Align offset (rounded to prevent sub-pixel rendering)
			let xOff = layer.x;
			if (style.align === "center") xOff = Math.round(layer.x + (maxW - lw) / 2);
			if (style.align === "right") xOff = Math.round(layer.x + (maxW - lw));

			this.fillTextWithSpacing(ctx, line, xOff, y, style.letterSpacing ?? 0);

			// Underline
			if (style.underline) {
				const uy = Math.round(y + style.fontSize + 2);
				ctx.beginPath();
				ctx.strokeStyle = style.color;
				ctx.lineWidth = Math.max(1, style.fontSize / 16);
				ctx.moveTo(xOff, uy);
				ctx.lineTo(xOff + lw, uy);
				ctx.stroke();
			}

			// Strikethrough
			if (style.strikethrough) {
				const sy = Math.round(y + style.fontSize * 0.55);
				ctx.beginPath();
				ctx.strokeStyle = style.color;
				ctx.lineWidth = Math.max(1, style.fontSize / 16);
				ctx.moveTo(xOff, sy);
				ctx.lineTo(xOff + lw, sy);
				ctx.stroke();
			}
		});
	}

	/** Measure text width accounting for letter spacing */
	private measureTextWithSpacing(
		ctx: CanvasRenderingContext2D,
		text: string,
		spacing: number,
	): number {
		if (!spacing) return ctx.measureText(text).width;
		let w = 0;
		for (const ch of text) w += ctx.measureText(ch).width + spacing;
		return Math.max(0, w - spacing); // don't add spacing after last char
	}

	/** Fill text with letter spacing by rendering char by char */
	private fillTextWithSpacing(
		ctx: CanvasRenderingContext2D,
		text: string,
		x: number,
		y: number,
		spacing: number,
	): void {
		if (!spacing) {
			ctx.fillText(text, x, y);
			return;
		}
		let cx = x;
		for (const ch of text) {
			// Round position to prevent sub-pixel blurriness
			ctx.fillText(ch, Math.round(cx), y);
			cx += ctx.measureText(ch).width + spacing;
		}
	}

	cancelText(): void {
		this.textEditActive.set(false);
		this.textEditingLayerId.set(null);
		this.cdr.detectChanges();
	}

	get textInputStyle(): object {
		const style = this.textStyle();
		// Use fixed screen coords — no transform math needed
		return {
			position: "fixed",
			left: `${this.textScreenX()}px`,
			top: `${this.textScreenY()}px`,
			fontSize: `${style.fontSize * this.zoom()}px`,
			fontFamily: style.fontFamily,
			fontWeight: style.bold ? "bold" : "normal",
			fontStyle: style.italic ? "italic" : "normal",
			color: style.color,
			textAlign: style.align,
			zIndex: 10001,
			minWidth: "120px",
		};
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Undo / Redo
	// ─────────────────────────────────────────────────────────────────────────
	private initUndoStack(id: string): void {
		this.undoStacks.set(id, []);
		this.redoStacks.set(id, []);
	}

	snapshot(layerId: string): void {
		const layer = this.layers().find((l) => l.id === layerId);
		if (!layer) return;
		const ctx = layer.canvas.getContext("2d")!;
		const data = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
		const stack = this.undoStacks.get(layerId) ?? [];
		stack.push(data);
		if (stack.length > this.MAX_UNDO) stack.shift();
		this.undoStacks.set(layerId, stack);
		this.redoStacks.set(layerId, []);
	}

	undo(): void {
		const id = this.activeLayerId();
		if (!id) return;
		const undoStack = this.undoStacks.get(id) ?? [];
		const redoStack = this.redoStacks.get(id) ?? [];
		if (!undoStack.length) return;
		const layer = this.layers().find((l) => l.id === id);
		if (!layer) return;
		// Save current state to redo
		const ctx = layer.canvas.getContext("2d")!;
		redoStack.push(
			ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height),
		);
		this.redoStacks.set(id, redoStack);
		// Restore
		const prev = undoStack.pop()!;
		this.undoStacks.set(id, undoStack);
		ctx.putImageData(prev, 0, 0);
		// Clear persistent resize source (content has changed)
		this.layerResizeSources.delete(layer);
		this.composite();
		this.cdr.detectChanges();
	}

	redo(): void {
		const id = this.activeLayerId();
		if (!id) return;
		const undoStack = this.undoStacks.get(id) ?? [];
		const redoStack = this.redoStacks.get(id) ?? [];
		if (!redoStack.length) return;
		const layer = this.layers().find((l) => l.id === id);
		if (!layer) return;
		const ctx = layer.canvas.getContext("2d")!;
		undoStack.push(
			ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height),
		);
		this.undoStacks.set(id, undoStack);
		const next = redoStack.pop()!;
		this.redoStacks.set(id, redoStack);
		ctx.putImageData(next, 0, 0);
		// Clear persistent resize source (content has changed)
		this.layerResizeSources.delete(layer);
		this.composite();
		this.cdr.detectChanges();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Canvas operations
	// ─────────────────────────────────────────────────────────────────────────
	clearActiveLayer(): void {
		const layer = this.activeLayer();
		if (!layer) return;
		this.snapshot(layer.id);
		const ctx = layer.canvas.getContext("2d")!;
		ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
		this.composite();
		this.cdr.detectChanges();
	}

	resizeCanvas(): void {
		const newW = this.resizeW();
		const newH = this.resizeH();
		this.canvasWidth.set(newW);
		this.canvasHeight.set(newH);

		if (this.displayCanvasRef?.nativeElement) {
			this.displayCanvasRef.nativeElement.width = newW;
			this.displayCanvasRef.nativeElement.height = newH;
			this.displayCtx = this.displayCanvasRef.nativeElement.getContext("2d");
		}
		if (this.interactionCanvasRef?.nativeElement) {
			this.interactionCanvasRef.nativeElement.width = newW;
			this.interactionCanvasRef.nativeElement.height = newH;
		}

		// Grow layer backing buffers if the document grew — content is preserved.
		// Never shrink them and never touch x/y/w/h (those belong to the content).
		this.layers.update((layers) =>
			layers.map((l) => {
				const needsGrow = newW > l.canvas.width || newH > l.canvas.height;
				if (!needsGrow) return l;
				const grown = makeCanvas(
					Math.max(newW, l.canvas.width),
					Math.max(newH, l.canvas.height),
				);
				grown.getContext("2d")!.drawImage(l.canvas, 0, 0);
				const grownMask = l.maskCanvas
					? (() => {
							const mc = makeCanvas(
								Math.max(newW, l.maskCanvas!.width),
								Math.max(newH, l.maskCanvas!.height),
							);
							mc.getContext("2d")!.drawImage(l.maskCanvas!, 0, 0);
							return mc;
						})()
					: undefined;
				// x, y, w, h are intentionally NOT changed
				return { ...l, canvas: grown, maskCanvas: grownMask };
			}),
		);

		this.composite();
		this.showResizeDialog.set(false);
		this.cdr.detectChanges();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Zoom / Pan
	// ─────────────────────────────────────────────────────────────────────────
	onWheel(e: WheelEvent): void {
		e.preventDefault();
		const delta = e.deltaY > 0 ? 0.9 : 1.1;
		const newZoom = Math.min(Math.max(this.zoom() * delta, 0.1), 8);
		this.zoom.set(parseFloat(newZoom.toFixed(3)));
		this.cdr.detectChanges();
	}

	zoomIn(): void {
		this.zoom.update((z) => Math.min(z * 1.25, 8));
		this.cdr.detectChanges();
	}
	zoomOut(): void {
		this.zoom.update((z) => Math.max(z * 0.8, 0.1));
		this.cdr.detectChanges();
	}
	zoomReset(): void {
		this.zoom.set(1);
		this.panX.set(0);
		this.panY.set(0);
		this.cdr.detectChanges();
	}
	get zoomPercent(): string {
		return Math.round(this.zoom() * 100) + "%";
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Context menus
	// ─────────────────────────────────────────────────────────────────────────
	showLayerContextMenu(e: MouseEvent, layer: Layer): void {
		e.preventDefault();
		e.stopPropagation();

		const menuItems: ContextMenuItemDef[] = [
			{
				label: "Duplicate",
				icon: "copy",
				action: () => this.duplicateLayer(layer.id),
			},
			{
				label: "Paste",
				icon: "clipboard",
				action: () => this.pasteFromClipboard(),
			},
			{ separator: true },
			{
				label: "Fit to Canvas",
				icon: "expand",
				action: () => this.fitLayerToCanvas(layer.id),
			},
			{
				label: "Free Transform",
				icon: "transform",
				action: () => this.enterWarpMode(layer.id),
			},
		];

		// Add Rasterize option for text layers
		if (layer.type === "text") {
			menuItems.push({
				label: "Rasterize Layer",
				icon: "image",
				action: () => this.rasterizeLayer(layer.id),
			});
		}

		menuItems.push(
			{
				label: "Remove Background",
				icon: "scissors",
				action: () => this.removeLayerBackground(layer.id),
			},
			{ separator: true },
			{
				label: "Move Up",
				icon: "arrow-up",
				action: () => this.moveLayerUp(layer.id),
			},
			{
				label: "Move Down",
				icon: "arrow-down",
				action: () => this.moveLayerDown(layer.id),
			},
			{ separator: true },
			{
				label: layer.maskCanvas ? "Remove Mask" : "Add Mask",
				icon: "mask",
				action: () =>
					layer.maskCanvas ? this.removeMask(layer.id) : this.addMask(layer.id),
			},
			{
				label: "Merge Down",
				icon: "merge",
				disabled: this.layers().indexOf(layer) >= this.layers().length - 1,
				action: () => this.mergeDown(layer.id),
			},
			{ separator: true },
			{
				label: "Start Rename",
				icon: "edit",
				action: () => this.startRename(layer),
			},
			{ separator: true },
			{
				label: "Delete Layer",
				icon: "trash",
				disabled: this.layers().length <= 1,
				action: () => this.removeLayer(layer.id),
			},
		);

		this.contextMenu.set({ x: e.clientX, y: e.clientY, items: menuItems });
		this.cdr.detectChanges();
	}

	showCanvasContextMenu(e: MouseEvent): void {
		e.preventDefault();
		const activeLayer = this.activeLayer();

		const menuItems: ContextMenuItemDef[] = [
			{
				label: "Add Raster Layer",
				icon: "plus",
				action: () => this.addLayer("raster"),
			},
			{
				label: "Add Image from File",
				icon: "upload",
				action: () => this.triggerFileUpload(),
			},
			{
				label: "Add Image from URL",
				icon: "link",
				action: () => {
					this.showUrlDialog.set(true);
					this.cdr.detectChanges();
				},
			},
			{
				label: "Paste",
				icon: "clipboard",
				action: () => this.pasteFromClipboard(),
			},
			{ separator: true },
			{
				label: "Fit Layer to Canvas",
				icon: "expand",
				disabled: !activeLayer,
				action: () => activeLayer && this.fitLayerToCanvas(activeLayer.id),
			},
			{
				label: "Free Transform",
				icon: "transform",
				disabled: !activeLayer,
				action: () => activeLayer && this.enterWarpMode(activeLayer.id),
			},
		];

		// Add Rasterize option for text layers
		if (activeLayer?.type === "text") {
			menuItems.push({
				label: "Rasterize Layer",
				icon: "image",
				action: () => this.rasterizeLayer(activeLayer.id),
			});
		}

		menuItems.push(
			{
				label: "Remove Background",
				icon: "scissors",
				disabled: !activeLayer,
				action: () => activeLayer && this.removeLayerBackground(activeLayer.id),
			},
			{ separator: true },
			{
				label: "Resize Canvas",
				icon: "expand",
				action: () => {
					this.resizeW.set(this.canvasWidth());
					this.resizeH.set(this.canvasHeight());
					this.showResizeDialog.set(true);
					this.cdr.detectChanges();
				},
			},
			{ label: "Flatten All", icon: "layers", action: () => this.flattenAll() },
			{ separator: true },
			{
				label: "Fit Canvas to Window",
				icon: "fit",
				action: () => this.fitToWindow(),
			},
		);

		this.contextMenu.set({ x: e.clientX, y: e.clientY, items: menuItems });
		this.cdr.detectChanges();
	}

	showLayerMenu(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();
		const activeLayer = this.activeLayer();
		const rect = (e.target as HTMLElement).getBoundingClientRect();
		this.contextMenu.set({
			x: rect.left,
			y: rect.bottom + 4,
			items: [
				{
					label: "Add Raster Layer",
					icon: "plus",
					action: () => this.addLayer("raster"),
				},
				{
					label: "Add Image from File",
					icon: "upload",
					action: () => this.triggerFileUpload(),
				},
				{
					label: "Paste",
					icon: "clipboard",
					action: () => this.pasteFromClipboard(),
				},
				{ separator: true },
				{
					label: "Remove Background",
					icon: "scissors",
					disabled: !activeLayer,
					action: () => activeLayer && this.removeLayerBackground(activeLayer.id),
				},
				{ separator: true },
				{
					label: "Duplicate Layer",
					icon: "copy",
					disabled: !activeLayer,
					action: () => activeLayer && this.duplicateLayer(activeLayer.id),
				},
				{
					label: "Merge Down",
					icon: "merge",
					disabled:
						!activeLayer ||
						this.layers().indexOf(activeLayer) >= this.layers().length - 1,
					action: () => activeLayer && this.mergeDown(activeLayer.id),
				},
				{ label: "Flatten All", icon: "layers", action: () => this.flattenAll() },
				{ separator: true },
				{
					label: "Delete Layer",
					icon: "trash",
					disabled: !activeLayer || this.layers().length <= 1,
					action: () => activeLayer && this.removeLayer(activeLayer.id),
				},
			],
		});
		this.cdr.detectChanges();
	}

	dismissContextMenu(): void {
		if (this.contextMenu()) {
			this.contextMenu.set(null);
			this.cdr.detectChanges();
		}
	}

	runContextAction(fn?: () => void): void {
		this.contextMenu.set(null);
		fn?.();
		this.cdr.detectChanges();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Rename
	// ─────────────────────────────────────────────────────────────────────────
	startRename(layer: Layer): void {
		this.renamingLayerId.set(layer.id);
		this.renameValue.set(layer.name);
		this.cdr.detectChanges();
	}

	confirmRename(): void {
		const id = this.renamingLayerId();
		if (!id) return;
		this.layers.update((ls) =>
			ls.map((l) =>
				l.id === id ? { ...l, name: this.renameValue() || l.name } : l,
			),
		);
		this.renamingLayerId.set(null);
		this.cdr.detectChanges();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Keyboard shortcuts
	// ─────────────────────────────────────────────────────────────────────────
	@HostListener("document:keydown", ["$event"])
	onKeyDown(e: KeyboardEvent): void {
		if (!this.isOpen()) return;

		// While the text overlay is open, only intercept Escape.
		// Everything else (space, backspace, arrows, Ctrl+Z…) must reach the textarea.
		if (this.textEditActive()) {
			if (e.key === "Escape") {
				this.cancelText();
			}
			return;
		}

		if (e.key === "Shift") this.shiftDown = true;

		if (e.key === "Escape") {
			if (this.isWarpMode()) {
				this.exitWarpMode(false);
				return;
			}
			if (this.contextMenu()) {
				this.dismissContextMenu();
				return;
			}
		}

		if (e.key === "Enter") {
			if (this.isWarpMode()) {
				e.preventDefault();
				this.exitWarpMode(true);
				return;
			}
		}

		// Don't intercept keys while focus is inside any other input / textarea
		const tag = (document.activeElement as HTMLElement)?.tagName?.toLowerCase();
		const isTyping = tag === "input" || tag === "textarea";
		if (isTyping) return;

		if (e.key === " ") {
			this.spaceDown = true;
			e.preventDefault();
			return;
		}

		const ctrl = e.ctrlKey || e.metaKey;
		if (ctrl && e.key === "z") {
			e.preventDefault();
			e.shiftKey ? this.redo() : this.undo();
		}
		if (ctrl && e.key === "y") {
			e.preventDefault();
			this.redo();
		}
		if (ctrl && e.key === "v") {
			e.preventDefault();
			this.pasteFromClipboard();
		}
		if (!ctrl) {
			const keyMap: Record<string, Tool> = {
				b: "brush",
				e: "eraser",
				t: "text",
				v: "select",
				g: "fill",
				i: "eyedropper",
			};
			if (keyMap[e.key]) this.currentTool.set(keyMap[e.key]);
			if (e.key === "[") this.brushSize.update((s) => Math.max(1, s - 2));
			if (e.key === "]") this.brushSize.update((s) => Math.min(200, s + 2));
			if (e.key === "Delete" || e.key === "Backspace") {
				const id = this.activeLayerId();
				if (id) {
					e.preventDefault();
					this.removeLayer(id);
				}
			}
		}
		this.cdr.detectChanges();
	}

	@HostListener("document:keyup", ["$event"])
	onKeyUp(e: KeyboardEvent): void {
		if (e.key === " ") this.spaceDown = false;
		if (e.key === "Shift") this.shiftDown = false;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Save / Resume
	// ─────────────────────────────────────────────────────────────────────────
	async getSaveState(): Promise<CanvasEditorSaveState> {
		const layerSaves: LayerSave[] = this.layers().map((l) => ({
			id: l.id,
			name: l.name,
			type: l.type,
			imageData: l.canvas.toDataURL("image/png"),
			maskData: l.maskCanvas?.toDataURL("image/png"),
			visible: l.visible,
			opacity: l.opacity,
			blendMode: l.blendMode,
			locked: l.locked,
			x: l.x,
			y: l.y,
			w: l.w,
			h: l.h,
			rotation: l.rotation,
			srcDataUrl: l.srcDataUrl,
			text: l.text,
			textStyle: l.textStyle ? { ...l.textStyle } : undefined,
		}));
		return {
			version: 1,
			width: this.canvasWidth(),
			height: this.canvasHeight(),
			backgroundColor: this.backgroundColor(),
			layers: layerSaves,
		};
	}

	loadState(state: CanvasEditorSaveState): void {
		this.canvasWidth.set(state.width);
		this.canvasHeight.set(state.height);
		// Treat missing or legacy #ffffff as transparent — explicit non-white values are preserved
		const bg = state.backgroundColor;
		this.backgroundColor.set(
			!bg || bg === "#ffffff" || bg === "#fff" || bg === "white"
				? "transparent"
				: bg,
		);
		this.layers.set([]);

		const loadPromises = state.layers.map(
			(ls) =>
				new Promise<Layer>((resolve) => {
					const canvas = makeCanvas(state.width, state.height);
					const ctx = canvas.getContext("2d")!;
					const img = new Image();
					img.onload = () => {
						ctx.drawImage(img, 0, 0);
						const layer: Layer = {
							id: ls.id,
							name: ls.name,
							type: ls.type,
							canvas,
							visible: ls.visible,
							opacity: ls.opacity,
							blendMode: ls.blendMode as GlobalCompositeOperation,
							locked: ls.locked,
							x: ls.x,
							y: ls.y,
							w: ls.w,
							h: ls.h,
							rotation: ls.rotation ?? 0,
							srcDataUrl: ls.srcDataUrl,
							text: ls.text,
							textStyle: ls.textStyle,
						};
						if (ls.maskData) {
							const mc = makeCanvas(state.width, state.height);
							const mctx = mc.getContext("2d")!;
							const mi = new Image();
							mi.onload = () => {
								mctx.drawImage(mi, 0, 0);
								layer.maskCanvas = mc;
								resolve(layer);
							};
							mi.src = ls.maskData;
						} else {
							resolve(layer);
						}
					};
					img.src = ls.imageData;
				}),
		);

		Promise.all(loadPromises).then((layers) => {
			layers.forEach((l) => this.initUndoStack(l.id));
			this.layers.set(layers);
			this.activeLayerId.set(layers[0]?.id ?? null);
			setTimeout(() => {
				this.initContexts();
				this.composite();
				this.fitToWindow();
				this.cdr.detectChanges();
			});
		});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Export / Done
	// ─────────────────────────────────────────────────────────────────────────
	async done(): Promise<void> {
		const w = this.canvasWidth();
		const h = this.canvasHeight();
		const exportCanvas = makeCanvas(w, h);
		const exportCtx = exportCanvas.getContext("2d")!;
		// Only fill background if it's not transparent
		const bg = this.backgroundColor();
		if (bg && bg !== "transparent") {
			exportCtx.fillStyle = bg;
			exportCtx.fillRect(0, 0, w, h);
		}
		const layers = this.layers();
		for (let i = layers.length - 1; i >= 0; i--) {
			this.compositeLayerToCtx(exportCtx, layers[i]);
		}
		const dataUrl = exportCanvas.toDataURL("image/png");
		const state = await this.getSaveState();
		const result: CanvasEditorResult = { dataUrl, width: w, height: h, state };
		this.svc._emit(result);

		// Only auto-close if configured to do so (default true)
		const autoClose = this.config().autoCloseOnDone ?? true;
		if (autoClose) {
			this.close(true);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Layer drag-reorder in panel
	// ─────────────────────────────────────────────────────────────────────────
	private dragLayerFromPanel: string | null = null;

	onLayerDragStart(e: DragEvent, layer: Layer): void {
		this.dragLayerFromPanel = layer.id;
		e.dataTransfer!.effectAllowed = "move";
	}

	onLayerDragOver(e: DragEvent, layer: Layer): void {
		e.preventDefault();
		e.dataTransfer!.dropEffect = "move";
	}

	onLayerDrop(e: DragEvent, targetLayer: Layer): void {
		e.preventDefault();
		const fromId = this.dragLayerFromPanel;
		if (!fromId || fromId === targetLayer.id) return;
		this.layers.update((ls) => {
			const copy = [...ls];
			const fromIdx = copy.findIndex((l) => l.id === fromId);
			const toIdx = copy.findIndex((l) => l.id === targetLayer.id);
			const [moved] = copy.splice(fromIdx, 1);
			copy.splice(toIdx, 0, moved);
			return copy;
		});
		this.dragLayerFromPanel = null;
		this.composite();
		this.cdr.detectChanges();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Preset canvas sizes
	// ─────────────────────────────────────────────────────────────────────────
	applyPreset(w: number, h: number): void {
		this.resizeW.set(w);
		this.resizeH.set(h);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Cursor
	// ─────────────────────────────────────────────────────────────────────────
	get cursorStyle(): string {
		const tool = this.currentTool();
		if (this.spaceDown || this.isPanning) return "grab";
		if (this.isRotating) return "grabbing";
		if (this.isScalingTextFont) return "nwse-resize";
		if (this.resizingHandle) return this.handleToCursor(this.resizingHandle);
		if (tool === "brush" || tool === "eraser") return "none"; // custom overlay handles it
		if (tool === "select") {
			const h = this.hoveredHandle();
			if (h) return this.handleToCursor(h);
			if (this.hoveredTextLayer()) return "text";
			return "default";
		}
		if (tool === "eyedropper") return "crosshair";
		if (tool === "text") return "text";
		return "crosshair";
	}

	/** Whether the brush/eraser cursor overlay should be visible */
	get showBrushCursor(): boolean {
		const tool = this.currentTool();
		return (
			this.cursorOnCanvas() &&
			!this.textEditActive() &&
			(tool === "brush" || tool === "eraser")
		);
	}

	/** Size of the brush cursor in screen pixels */
	get brushCursorPx(): number {
		return Math.max(2, this.brushSize() * this.zoom());
	}

	/** Inline styles for the brush cursor circle */
	get brushCursorStyle(): object {
		const r = this.brushCursorPx / 2;
		const tool = this.currentTool();
		const color = this.brushColor();

		// Eraser: white fill with dark border
		// Brush: colored ring with a subtle fill tint
		const isEraser = tool === "eraser";
		const border = isEraser
			? "1.5px solid rgba(80,80,80,0.9)"
			: `1.5px solid ${color}`;
		const bg = isEraser ? "rgba(255,255,255,0.25)" : this.hexToRgba(color, 0.15);
		const outline = isEraser ? "1px solid rgba(255,255,255,0.4)" : "none";

		return {
			position: "fixed",
			left: `${this.cursorScreenX()}px`,
			top: `${this.cursorScreenY()}px`,
			width: `${r * 2}px`,
			height: `${r * 2}px`,
			transform: "translate(-50%, -50%)",
			borderRadius: "50%",
			border,
			outline,
			background: bg,
			pointerEvents: "none",
			zIndex: 10002,
			// Crosshair dot in center for small brushes
			boxShadow: r > 8 ? "none" : `0 0 0 1px ${isEraser ? "#666" : color}`,
		};
	}

	private hexToRgba(hex: string, alpha: number): string {
		// Expand shorthand #rgb → #rrggbb
		const full = hex.replace(
			/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i,
			"#$1$1$2$2$3$3",
		);
		const r = parseInt(full.slice(1, 3), 16);
		const g = parseInt(full.slice(3, 5), 16);
		const b = parseInt(full.slice(5, 7), 16);
		if (isNaN(r) || isNaN(g) || isNaN(b)) return `rgba(0,0,0,${alpha})`;
		return `rgba(${r},${g},${b},${alpha})`;
	}

	private handleToCursor(h: ResizeHandle): string {
		const map: Record<ResizeHandle, string> = {
			tl: "nw-resize",
			tc: "n-resize",
			tr: "ne-resize",
			ml: "w-resize",
			mr: "e-resize",
			bl: "sw-resize",
			bc: "s-resize",
			br: "se-resize",
		};
		return map[h];
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Layer thumbnail
	// ─────────────────────────────────────────────────────────────────────────
	getLayerThumbnail(layer: Layer): string {
		const size = 40;
		const thumb = makeCanvas(size, size);
		const ctx = thumb.getContext("2d")!;
		ctx.drawImage(layer.canvas, 0, 0, size, size);
		return thumb.toDataURL("image/png");
	}

	setActiveLayerW(newW: number): void {
		const layer = this.activeLayer();
		if (!layer || newW < 1) return;
		this.snapshot(layer.id);

		// Use persistent resize source if available, otherwise create it
		if (!this.layerResizeSources.has(layer)) {
			const pristineCanvas = makeCanvas(layer.canvas.width, layer.canvas.height);
			pristineCanvas.getContext("2d")!.drawImage(layer.canvas, 0, 0);
			this.layerResizeSources.set(layer, pristineCanvas);
		}

		this.resizeSourceCanvas = this.layerResizeSources.get(layer)!;
		if (layer.srcDataUrl) {
			const img = new Image();
			img.src = layer.srcDataUrl;
			this.resizeSourceImg = img;
		}
		const nb = { x: layer.x, y: layer.y, w: newW, h: layer.h };
		layer.w = newW;
		this.applyResizeToCanvas(layer, nb);
		this.resizeSourceCanvas = null;
		this.resizeSourceImg = null;
		this.composite();
		this.cdr.detectChanges();
	}

	setActiveLayerH(newH: number): void {
		const layer = this.activeLayer();
		if (!layer || newH < 1) return;
		this.snapshot(layer.id);

		// Use persistent resize source if available, otherwise create it
		if (!this.layerResizeSources.has(layer)) {
			const pristineCanvas = makeCanvas(layer.canvas.width, layer.canvas.height);
			pristineCanvas.getContext("2d")!.drawImage(layer.canvas, 0, 0);
			this.layerResizeSources.set(layer, pristineCanvas);
		}

		this.resizeSourceCanvas = this.layerResizeSources.get(layer)!;
		if (layer.srcDataUrl) {
			const img = new Image();
			img.src = layer.srcDataUrl;
			this.resizeSourceImg = img;
		}
		const nb = { x: layer.x, y: layer.y, w: layer.w, h: newH };
		layer.h = newH;
		this.applyResizeToCanvas(layer, nb);
		this.resizeSourceCanvas = null;
		this.resizeSourceImg = null;
		this.composite();
		this.cdr.detectChanges();
	}

	setActiveLayerRotation(newRotation: number): void {
		const layer = this.activeLayer();
		if (!layer) return;
		this.snapshot(layer.id);
		// Normalize to -180 to 180
		while (newRotation > 180) newRotation -= 360;
		while (newRotation < -180) newRotation += 360;
		layer.rotation = newRotation;
		this.composite();
		this.cdr.detectChanges();
	}

	setTextLayerFontSize(newFontSize: number): void {
		const layer = this.activeLayer();
		if (!layer || layer.type !== "text" || !layer.text || !layer.textStyle)
			return;
		newFontSize = Math.max(8, Math.min(1000, newFontSize));
		this.snapshot(layer.id);
		const updatedStyle = { ...layer.textStyle, fontSize: newFontSize };
		layer.textStyle = updatedStyle;
		this.renderTextToLayer(layer, layer.text, updatedStyle);
		this.composite();
		this.cdr.detectChanges();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Template-safe helpers (arrow functions not allowed in Angular templates)
	// ─────────────────────────────────────────────────────────────────────────
	toggleEditingMask(): void {
		this.editingMask.update((v) => !v);
		this.cdr.detectChanges();
	}

	setTextFontSize(event: Event): void {
		const v = +(event.target as HTMLInputElement).value;
		this.textStyle.update((s) => ({ ...s, fontSize: v }));
	}

	setTextFontFamily(event: Event): void {
		const v = (event.target as HTMLSelectElement).value;
		this.textStyle.update((s) => ({ ...s, fontFamily: v }));
	}

	setTextColor(event: Event): void {
		const v = (event.target as HTMLInputElement).value;
		this.textStyle.update((s) => ({ ...s, color: v }));
	}

	toggleTextBold(): void {
		this.textStyle.update((s) => ({ ...s, bold: !s.bold }));
	}

	toggleTextItalic(): void {
		this.textStyle.update((s) => ({ ...s, italic: !s.italic }));
	}

	toggleTextUnderline(): void {
		this.textStyle.update((s) => ({ ...s, underline: !s.underline }));
	}

	toggleTextStrikethrough(): void {
		this.textStyle.update((s) => ({ ...s, strikethrough: !s.strikethrough }));
	}

	setTextAlign(align: CanvasTextAlign): void {
		this.textStyle.update((s) => ({ ...s, align }));
	}

	setTextLetterSpacing(event: Event): void {
		const v = parseFloat((event.target as HTMLInputElement).value);
		if (!isNaN(v)) this.textStyle.update((s) => ({ ...s, letterSpacing: v }));
	}

	setTextLineHeight(event: Event): void {
		const v = parseFloat((event.target as HTMLInputElement).value);
		if (!isNaN(v)) this.textStyle.update((s) => ({ ...s, lineHeight: v }));
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Layer opacity input helper
	// ─────────────────────────────────────────────────────────────────────────
	onLayerOpacityChange(layer: Layer, event: Event): void {
		const val = parseFloat((event.target as HTMLInputElement).value);
		if (!isNaN(val)) this.setLayerOpacity(layer.id, val / 100);
	}

	onLayerBlendModeChange(layer: Layer, event: Event): void {
		const val = (event.target as HTMLSelectElement)
			.value as GlobalCompositeOperation;
		this.setLayerBlendMode(layer.id, val);
	}

	selectLayer(layer: Layer): void {
		this.activeLayerId.set(layer.id);
		this.editingMask.set(false);
		this.cdr.detectChanges();
	}

	get activeLayerOpacity(): number {
		return Math.round((this.activeLayer()?.opacity ?? 1) * 100);
	}
}
