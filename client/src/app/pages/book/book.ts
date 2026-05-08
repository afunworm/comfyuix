import {
	AfterViewInit,
	Component,
	computed,
	DestroyRef,
	effect,
	ElementRef,
	HostListener,
	inject,
	Input,
	NgZone,
	signal,
	ViewChild,
	WritableSignal,
} from "@angular/core";
import { Dialog } from "../../dialog";
import { CommonModule } from "@angular/common";
import { applyPatch, Operation } from "fast-json-patch";
import { ViewportScroller } from "@angular/common";
import { SpinnerComponent } from "../../spinner/spinner.component";
import { ComfyUIUploadService } from "../../comfyui/comfyui-upload.service";
import {
	ImageAssetStorageService,
	StoredImageAsset,
	StoredFolder,
} from "../../comfyui/comfyui-asset-storage.service";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { placeholderImage } from "../../placeholder-image/placeholder-image.component";

import { PanicService } from "../../panic/panic.service";
import {
	FlowConfig,
	FlowTemplate,
	Configurable,
	BindingTarget,
	PromptTemplate,
} from "../../types/flow.type";
import {
	ComfyUIDatabaseService,
	QuickFlowGroupWithFlows,
	QuickFlow,
	AskOnRunParam,
	FsEntry,
} from "../../comfyui/comfyui-database.service";
import { parsePromptTemplate, assemblePrompt, getDefaultSelections } from "../../utils/prompt-template";
import { ContextMenuService } from "../../context-menu/context-menu.service";
import { AuthService } from "../../auth/auth.service";
import { CanvasEditorService } from "../../canvas-editor";
import { tap } from "rxjs/operators";
import { firstValueFrom, Observable } from "rxjs";
import { Router } from "@angular/router";
import { EXPECTED_TUNNEL_VERSION } from "../../version";
import { ModelInfoModal } from "../../model-info-modal/model-info-modal";
import { MultirunPanelComponent } from "./multirun-panel.component";
import {
	MultirunEntry,
	MultirunEntryStatus,
	MultirunRunPayload,
	MultirunSharedField,
} from "./multirun.types";
import { GalleryModeComponent } from "./gallery-mode.component";
import { SysHudComponent } from "./sys-hud/sys-hud.component";
import { ImageCompareComponent } from "./image-compare/image-compare.component";
import { LayerPanelComponent } from "./layer-panel/layer-panel.component";
import { LayerPanelService } from "./layer-panel/layer-panel.service";

type ComfyNodeResponse = {
	value: number;
	max: number;
	state: "running" | "finished" | "pending";
	node_id: string;
	prompt_id: string;
	display_node_id: string;
	parent_node_id: string | null;
	real_node_id: string;
};

interface LogEntry {
	time: string;
	message: string;
	type: "muted" | "success" | "warn" | "accent" | "danger";
}

@Component({
	selector: "app-flow",
	imports: [CommonModule, SpinnerComponent, ModelInfoModal, MultirunPanelComponent, GalleryModeComponent, SysHudComponent, ImageCompareComponent, LayerPanelComponent],
	providers: [LayerPanelService],
	templateUrl: "./book.html",
	styleUrl: "./book.scss",
})
export class Book implements AfterViewInit {
	readonly excludedConfigurables = [
		"positivePrompt",
		"negativePrompt",
		"outputNode",
	];
	flows: WritableSignal<FlowConfig[]> = signal([]);

	private dialog = inject(Dialog);
	private scroller = inject(ViewportScroller);
	private readonly uploadService = inject(ComfyUIUploadService);
	private readonly assetService = inject(ImageAssetStorageService);
	panic = inject(PanicService);
	private db = inject(ComfyUIDatabaseService);
	private destroyRef = inject(DestroyRef);
	private contextMenu = inject(ContextMenuService);
	private editorSvc = inject(CanvasEditorService);
	protected authService = inject(AuthService);
	private router = inject(Router);
	private ngZone = inject(NgZone);
	readonly layerPanel = inject(LayerPanelService);

	@Input("bookId") bookId!: string;

	serverId = signal<string | null>(null);
	loraFiles = signal<FsEntry[]>([]);
	loraInfoEntry = signal<{ entry: FsEntry; fullPath: string } | null>(null);
	/** Tracks user lora selections separately; empty string = None (no override). */
	loraSelections = signal<Record<string, string>>({});

	selectedApiData = signal<FlowTemplate | undefined>(undefined);
	selectedFlow = signal<string | undefined>(undefined);
	selectedTemplate = signal<string | undefined>(undefined);
	resultPhotoURL = signal<string>(placeholderImage(600, 400));

	activePageTab = signal<'generator' | 'editor'>('generator');
	editorSourceAsset = signal<StoredImageAsset | null>(null);
	isExportingMask = signal<boolean>(false);
	resultPhotoAlt = signal<string>("600x400 placeholder image");
	activeFlow = computed(() =>
		this.flows().find((FlowConfig) => FlowConfig.id === this.selectedFlow()),
	);
	activeTemplate = computed(() => {
		const flow = this.activeFlow();
		const templateId = this.selectedTemplate();

		if (!flow || !templateId) return undefined;

		return flow.templates.find((t) => t.id === templateId);
	});
	statusBarConfigs = computed(() => {
		const flow = this.activeFlow();
		if (!flow) return [];
		return flow.configurables.filter(
			(c) =>
				c.visible &&
				!this.excludedConfigurables.includes(c.id) &&
				c.type !== "core" &&
				c.type !== "inputImage",
		);
	});

	numberConfigurables = computed(
		() =>
			this.activeFlow()?.configurables.filter(
				(c) =>
					c.type === "number" ||
					c.type === "finalImageWidth" ||
					c.type === "finalImageHeight",
			) ?? [],
	);

	canSwapDimensions = computed(() => {
		const cfgs = this.activeFlow()?.configurables ?? [];
		return cfgs.some((c) => c.type === "finalImageWidth") && cfgs.some((c) => c.type === "finalImageHeight");
	});

	inputImageConfigurables = computed(
		() =>
			this.activeFlow()?.configurables.filter((c) => c.type === "inputImage") ??
			[],
	);

	isInputImageFlow = computed(() => this.inputImageConfigurables().length > 0);

	hasNegativePrompt = computed(
		() =>
			!!this.activeFlow()?.configurables.some((c) => c.id === "negativePrompt"),
	);

	negativePromptVisible = computed(() => {
		const cfg = this.activeFlow()?.configurables.find(
			(c) => c.id === "negativePrompt",
		);
		return cfg?.visible ?? false;
	});
	currentPromptId = signal<string>("");
	randomizeSeed = signal<Boolean>(true);
	currentlyQueuedNodeId = signal<string>("");
	currentlyQueuedNodeName = signal<string>("");
	logs = signal<LogEntry[]>([]);
	MAX_LINES = 500;
	lastLogText = signal<string>("");
	statusScrollActive = signal<boolean>(true);
	statusTextOverflows = signal<boolean>(false);
	openDropdownId = signal<string | null>(null);
	private clearLogTimer: ReturnType<typeof setTimeout> | null = null;
	private _propagatingFromSet = new Set<string>();
	@ViewChild("statusText") statusTextRef!: ElementRef<HTMLElement>;
	@ViewChild("console") consoleElement!: ElementRef<HTMLElement>;
	@ViewChild("consoleWrapper") consoleWrapperElement!: ElementRef<HTMLElement>;
	@ViewChild("viewerStage") viewerStageRef!: ElementRef<HTMLElement>;
	@ViewChild("statusScroll") statusScrollRef!: ElementRef<HTMLElement>;
	@ViewChild(SysHudComponent) sysHudRef?: SysHudComponent;
	@ViewChild('maskCanvas')
	set maskCanvasRefSetter(ref: ElementRef<HTMLCanvasElement> | undefined) {
		this.layerPanel.canvas = ref?.nativeElement ?? null;
	}
	@ViewChild('editorMaskCanvas')
	set editorMaskCanvasRefSetter(ref: ElementRef<HTMLCanvasElement> | undefined) {
		this.layerPanel.canvas = ref?.nativeElement ?? null;
	}
	private wsProxiedEndpoint = "";
	protected httpProxiedEndpoint = "";
	private ws: WebSocket | null = null;
	private wsRetryCount = 0;
	private wsMaxRetries = 10;
	private wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private tunnelStatusTimer: ReturnType<typeof setInterval> | null = null;
	private tunnelEventCursor = 0;
	private pendingRunApiData: { apiData: any; promptPositive?: string; promptNegative?: string; seed?: string } | null = null;
	private queuePollTimer: ReturnType<typeof setInterval> | null = null;
	queueDepth = signal<number | null>(null);
	activeQueueJobs = signal<number>(0);
	repeatCount = signal<number>(1);
	isQueueRunning = computed(() => this.activeQueueJobs() > 0);
	imgTransform = computed(() =>
		`translate(${this.imagePanX()}px, ${this.imagePanY()}px) scale(${this.imageZoom()})`
	);
	setRepeatCount(value: string): void {
		const n = parseInt(value, 10);
		this.repeatCount.set(isNaN(n) ? 1 : Math.max(1, Math.min(99, n)));
	}
	isLoading = signal<boolean>(false);
	isUploadingToInput = signal<boolean>(false);
	showProgressBar = signal<boolean>(false);
	progressBarProgress = signal<number>(0);
	progressText = signal<string>("");
	startTime = signal<Date>(new Date());
	isConnectedToServer = signal<boolean>(false);
	promptTemplatesVisible = signal<boolean>(false);
	flowsOverlayVisible = signal<boolean>(false);
	ctrlSidebarVisible = signal<boolean>(false);
	accountMenuOpen = signal<boolean>(false);

	multirunOpen = signal<boolean>(false);
	multirunRunning = signal<boolean>(false);
	multirunStatuses = signal<Record<string, MultirunEntryStatus>>({});
	private multirunCurrentEntryId = signal<string | null>(null);

	galleryModeActive = signal<boolean>(false);
	galleryModeAssets = signal<StoredImageAsset[]>([]);
	galleryModeIndex = signal<number>(0);

	imagePreview = signal<{
		url: string;
		filename: string;
		x: number;
		y: number;
		left: number;
		right: number;
		naturalWidth?: number;
		naturalHeight?: number;
	} | null>(null);

	showImagePreview(event: MouseEvent, asset: StoredImageAsset): void {
		const filename =
			asset.filename || this.extractExtraAssetParams(asset.url).filename;
		this.imagePreview.set({
			url: asset.url,
			filename,
			x: event.clientX,
			y: event.clientY,
			left: event.clientX + 20,
			right: window.innerWidth - event.clientX + 20,
		});
	}

	updateImagePreviewPosition(event: MouseEvent): void {
		const p = this.imagePreview();
		if (!p) return;
		this.imagePreview.set({
			...p,
			x: event.clientX,
			y: event.clientY,
			left: event.clientX + 20,
			right: window.innerWidth - event.clientX + 20,
		});
	}

	setImagePreviewSize(event: Event): void {
		const img = event.target as HTMLImageElement;
		const p = this.imagePreview();
		if (!p) return;
		this.imagePreview.set({
			...p,
			naturalWidth: img.naturalWidth,
			naturalHeight: img.naturalHeight,
		});
	}

	hideImagePreview(): void {
		this.imagePreview.set(null);
	}
	bookInfoVisible = signal<boolean>(false);
	consoleOverlayVisible = signal<boolean>(false);
	advancedCollapsed = signal<boolean>(true);
	imageZoom = signal<number>(1);
	imagePanX = signal<number>(0);
	imagePanY = signal<number>(0);
	imageIsPanning = signal<boolean>(false);

	private readonly _gesturePointers = new Map<number, PointerEvent>();
	private _gestureActive = false;
	private _pinchBaseZoom = 1;
	private _pinchBaseDist = 0;
	private _panBaseX = 0;
	private _panBaseY = 0;
	compareMode = signal<boolean>(false);

	promptSearchQuery = signal<string>("");
	filteredPromptTemplates = computed(() => {
		const query = this.promptSearchQuery().trim().toLowerCase();
		const prompts = this.activeTemplate()?.promptTemplates ?? [];
		const locked = this.contentLocked();
		const visible = prompts
			.map((pt, i) => ({ pt, i }))
			.filter(({ pt }) => !locked || !pt.protected);
		if (!query) return visible;
		return visible.filter(
			({ pt }) =>
				pt.positive.toLowerCase().includes(query) ||
				pt.negative.toLowerCase().includes(query),
		);
	});
	galleryVisible = signal<boolean>(false);
	galleryTab = signal<"input" | "output">("input");
	galleryMode = signal<"select" | "compare">("select");
	gallerySelectMode = signal<boolean>(false);
	galleryBookFilter = signal<"this" | "all">("this");
	quickFlowGroups = signal<QuickFlowGroupWithFlows[]>([]);
	quickFlowRunningName = signal<string | null>(null);
	lastPromptJson = signal<string | null>(null);
	showLastPrompt = signal(false);
	tunnelVersion = signal<string>('');
	tunnelVersionMismatch = computed(() => {
		const v = this.tunnelVersion();
		return v !== '' && v !== EXPECTED_TUNNEL_VERSION;
	});
	changePromptBeforeRun = signal(false);
	canvasImageNaturalSize = signal<{ w: number; h: number } | null>(null);
	selectedAssetIds = signal<Set<string>>(new Set());
	dragOverFolderId = signal<number | null>(null);
	private lastSelectedIndex = -1;

	// Folder navigation: null = root (all assets), number = inside a folder
	currentInputFolderId = signal<number | null>(null);
	currentOutputFolderId = signal<number | null>(null);

	readonly inputFolders = this.assetService.inputFolders$;
	readonly outputFolders = this.assetService.outputFolders$;

	readonly visibleInputAssets = computed(() => {
		const folderId = this.currentInputFolderId();
		const bookFilter = this.galleryBookFilter();
		return this.uploadedAssets().filter((a) => {
			if (bookFilter === "this" && a.bookId !== this.bookId) return false;
			return folderId === null ? a.folderId == null : a.folderId === folderId;
		});
	});

	readonly visibleOutputAssets = computed(() => {
		const folderId = this.currentOutputFolderId();
		const bookFilter = this.galleryBookFilter();
		return this.generatedAssets().filter((a) => {
			if (bookFilter === "this" && a.bookId !== this.bookId) return false;
			return folderId === null ? a.folderId == null : a.folderId === folderId;
		});
	});

	readonly OUTPUT_PAGE_SIZE = 20;
	outputPage = signal<number>(0);
	pageEditActive = signal<boolean>(false);

	readonly outputTotalPages = computed(() =>
		Math.max(1, Math.ceil(this.visibleOutputAssets().length / this.OUTPUT_PAGE_SIZE))
	);

	readonly paginatedOutputAssets = computed(() => {
		const page = this.outputPage();
		const start = page * this.OUTPUT_PAGE_SIZE;
		return this.visibleOutputAssets().slice(start, start + this.OUTPUT_PAGE_SIZE);
	});

	activatePageEdit(): void {
		this.pageEditActive.set(true);
		setTimeout(() => {
			const input = document.querySelector('.gallery-pagination__input') as HTMLInputElement;
			if (input) { input.select(); input.focus(); }
		}, 0);
	}

	submitPageEdit(value: string): void {
		const n = parseInt(value, 10);
		if (!isNaN(n)) {
			this.outputPage.set(Math.max(0, Math.min(n - 1, this.outputTotalPages() - 1)));
		}
		this.pageEditActive.set(false);
	}

	contentLocked = signal<boolean>(true);
	selectedTemplatePromptIndex = signal<number | null>(null);
	selectedTemplateDisplayIndex = computed(() => {
		const idx = this.selectedTemplatePromptIndex();
		if (idx === null) return null;
		return this.filteredPromptTemplates().findIndex((item) => item.i === idx);
	});
	readonly uploadedAssets = this.assetService.input$;
	readonly generatedAssets = this.assetService.output$;
	inputImageSelectedKey: Record<string, string | null> = {
		inputImage1: null,
		inputImage2: null,
	};

	currentInputImageConfigName = computed(() => {
		const cfg = this.activeFlow()?.configurables.find(
			(c) => c.id === this.currentInputImageConfigId(),
		);
		return cfg?.name || "";
	});
	selectedAssetKeyByConfigId: Record<string, string | null> = {
		inputImage1: null,
		inputImage2: null,
	};

	// inputImages = signal<InputImagesMap>({});

	inputImagesMap = signal<Record<string, string>>({});
	currentInputImageConfigId = signal<string>("");
	extractExtraAssetParams = (urlString: string) => {
		try {
			const url = new URL(urlString);
			const params = url.searchParams;

			const type = params.get("type") ?? "";
			const subfolder = params.get("subfolder") ?? "";

			// 1. Try ?filename= query param (ComfyUI view URLs)
			// 2. Try last path segment (e.g. /uploads/foo.png)
			// 3. Give up
			const filename =
				params.get("filename") ||
				url.pathname.split("/").filter(Boolean).pop() ||
				"";

			return {
				filename,
				type: type || "",
				subfolder: subfolder || "",
			};
		} catch (err) {
			return {
				filename: "",
				type: "",
				subfolder: "",
			};
		}
	};
	allImageMetadata = computed(() => {
		const result: Record<string, any> = {};
		const configIds = Object.keys(this.inputImagesMap());

		for (const configId of configIds) {
			const assetId = this.inputImagesMap()[configId];
			if (!assetId) {
				result[configId] = undefined;
				continue;
			}

			const data = this.uploadedAssets().find((a) => a.id === assetId);
			result[configId] = {
				...this.extractExtraAssetParams(data?.url || ""),
				...data,
			};
		}

		return result;
	});

	currentImageMetaData = computed(() => {
		const configId = this.currentInputImageConfigId();
		return this.allImageMetadata()[configId];
	});
	imageDimensionMetaData = signal<
		Record<string, { naturalWidth: number; naturalHeight: number }>
	>({});
	configBindings = signal<Record<string, BindingTarget>>({});
	bindingPopoverFor = signal<string | null>(null);
	beforePhotoURL = signal<string>("");

	constructor() {
		// Reset output page when folder or book filter changes (not tab — preserve position across tab switches)
		effect(() => {
			this.currentOutputFolderId();
			this.galleryBookFilter();
			this.outputPage.set(0);
		});

		// When flows arrive, select the first flow only if nothing selected yet
		effect(() => {
			const list = this.flows();
			if (!list.length) return;

			if (!this.selectedFlow()) {
				this.onWorkflowChange(list[0].id!);
				this.syncPhotoURL();
			}
		});

		// Keep LayerPanelService context in sync
		effect(() => {
			this.layerPanel.canvasNaturalSize = this.canvasImageNaturalSize();
			this.layerPanel.resultPhotoURL = this.resultPhotoURL();
		});

		// Set ComfyUIUploadService base URL when httpProxiedEndpoint changes
		// effect(() => {
		// 	this.uploadService.setBaseUrl(this.httpProxiedEndpoint);
		// });
	}

	connectWS(): void {
		// Prevent multiple simultaneous attempts
		if (
			this.ws &&
			(this.ws.readyState === WebSocket.CONNECTING ||
				this.ws.readyState === WebSocket.OPEN)
		) {
			return;
		}

		this.log(`Establishing WebSocket connection to ${this.wsProxiedEndpoint}...`);

		this.ws = new WebSocket(this.wsProxiedEndpoint);
		const ws = this.ws;

		const ip = this.wsProxiedEndpoint.replace("ws://", "").split(":")[0];
		const portParts =
			this.wsProxiedEndpoint.replace("ws://", "").split(":")[1] || "80";
		const port = portParts.split("/")[0];

		ws.onopen = () => {
			this.wsRetryCount = 0; // Reset on success

			this.isConnectedToServer.set(true);
			this.log(
				`Connected to remote server at <span class="warn">${ip}</span> on port <span class="warn">${port}</span>.`,
			);
		};

		ws.onmessage = (event) => {
			// ComfyUI sends binary preview frames as Blobs — skip them
			if (event.data instanceof Blob) return;
			try {
				const msg = JSON.parse(event.data);

				if (
					msg.type === "progress_state" &&
					msg.data.prompt_id === this.currentPromptId()
				) {
					const nodes = Object.values(msg.data.nodes) as ComfyNodeResponse[];
					// console.log(nodes);

					// Get the target value for the configurable outputNode from the activeFlows()
					const outputNodeId = this.activeFlow()?.configurables?.find(
						(c) => c.id === "outputNode",
					)?.target;

					// Find the finished node, and if it matches outputNode, queue is done
					const isOutputNodeFinished = !!nodes.find(
						(n) =>
							n.state === "finished" && String(n.node_id) === String(outputNodeId),
					);

					if (isOutputNodeFinished) {
						const timeElapsed =
							Math.abs(Date.now() - this.startTime().getTime()) / 1000;
						this.log(`Queue completed in ${timeElapsed} seconds.`, "success");
						return;
					}

					const runningNode = nodes.find((n) => n.state === "running");

					const currentNodeId = runningNode?.node_id;

					if (!currentNodeId) {
						// There's no node that is running, no need to log
						return;
					}

					// Get current node name that comfyui is running
					const currentNodeName =
						this.activeFlow()?.apiData?.[currentNodeId]?._meta?.title ??
						this.pendingRunApiData?.apiData?.[currentNodeId]?._meta?.title ??
						currentNodeId;

					if (
						currentNodeId !== this.currentlyQueuedNodeId() &&
						currentNodeName !== this.currentlyQueuedNodeName()
					) {
						this.log(`Executing node ${currentNodeName}...`);
					}

					// Keep the current node name and ID to track progress
					this.currentlyQueuedNodeId.set(currentNodeId);
					this.currentlyQueuedNodeName.set(currentNodeName);
					const percent = Math.round((runningNode.value / runningNode.max) * 100);
					const clampedPercent = Math.min(100, Math.max(0, percent));

					this.progressBarProgress.set(clampedPercent);

					// Forward progress to the active multirun entry if one is running
					const multirunEntryId = this.multirunCurrentEntryId();
					if (this.multirunRunning() && multirunEntryId) {
						this.multirunStatuses.update((s) => ({
							...s,
							[multirunEntryId]: { ...s[multirunEntryId], progress: clampedPercent },
						}));
					}

					// Update statusbar text inline with percent (no new log entry)
					this.lastLogText.set(`Executing node ${currentNodeName}...`);
					if (this.clearLogTimer) clearTimeout(this.clearLogTimer);
				}
			} catch (error) {
				this.log(this.trimErrorMessage(error), "danger");
			}
		};

		ws.onclose = (event) => {
			if (!event.wasClean) {
				if (this.wsRetryCount >= this.wsMaxRetries) {
					this.log("WebSocket gave up after max retries");
					return;
				}
				// Exponential backoff: 1s, 2s, 4s, 8s... capped at 30s
				const delay = Math.min(1000 * 2 ** this.wsRetryCount, 30000);
				this.wsRetryCount++;
				this.log(
					`WebSocket dropped, reconnecting in ${delay / 1000}s (attempt ${this.wsRetryCount})`,
				);
				this.wsRetryTimer = setTimeout(() => this.connectWS(), delay);
			} else {
				this.log(`Connection to <span class="warn">${ip}</span> lost.`);
			}
		};

		ws.onerror = (err) => {
			// WebSocket error occurred
		};
	}

	ngOnDestroy(): void {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		if (this.tunnelStatusTimer) {
			clearInterval(this.tunnelStatusTimer);
			this.tunnelStatusTimer = null;
		}
	}

	ngOnInit(): void {
		if (!this.authService.isLoggedIn()) {
			this.router.navigate(["/login"]);
			return;
		}

		if (!this.bookId) {
			this.log("Missing book ID in route. Exited.", "danger");
			return;
		}

		// Initiate proxy endpoints
		this.httpProxiedEndpoint = this.db.httpProxiedEndpoint(this.bookId);
		this.wsProxiedEndpoint = this.db.wsProxiedEndpoint(this.bookId);
		// Initialize storage service with book ID
		this.assetService.initialize(this.bookId);

		// Poll tunnel status — connectWS() is triggered from fetchTunnelStatus once connected
		this.startTunnelStatusPoll();

		firstValueFrom(this.db.getQuickFlows())
			.then((groups) => {
				this.quickFlowGroups.set(groups);
			})
			.catch(() => {
				/* non-critical */
			});

		// Fetch server ID and load LoRA files
		this.db.getBookServerId(this.bookId).subscribe({
			next: (id) => {
				if (!id) return;
				this.serverId.set(id);
				this.db.listFiles(id, 'loras', true).subscribe({
					next: (entries) => this.loraFiles.set(entries.filter((e) => e.type === 'file')),
					error: () => { /* non-critical */ },
				});
			},
			error: () => { /* non-critical */ },
		});

		this.db.getFlows(this.bookId).subscribe((flows) => {
			const ok = flows.filter(Boolean) as FlowConfig[];

			this.flows.set(ok);
			this.resetPrompts();

			const totalWorkflows = ok.length;
			const totalTemplates = ok.reduce(
				(sum, flow) => sum + (flow.templates?.length ?? 0),
				0,
			);

			this.log(
				`Loaded <span class="warn">${totalWorkflows} workflow(s)</span> and <span class="warn">${totalTemplates} template(s)</span>.`,
			);
		});
	}

	async onWorkflowChange(id: string) {
		const flow = this.flows().find((f: FlowConfig) => f.id === id);

		// Set new API data using clone so we don't mutate original config
		this.selectedApiData.set(structuredClone(flow?.apiData));

		// Update placeholder immediately using the flow's base dimensions
		this.syncPhotoURL();

		// Reset lora selections for the new flow
		this.loraSelections.set({});

		// Set selected workflow
		this.selectedFlow.set(id);

		// Always clear prompt fields — the stored apiData may have baked-in values
		this.resetPrompts();

		// Load persisted bindings for this flow
		this.loadBindings(id);

		// Set the selected template to the first template of the new workflow
		if (!flow?.templates || flow?.templates.length <= 0) {
			await this.dialog.alert(
				"Corrupted flow data: workflow requires at least 1 template.",
			);
			return;
		}

		this.onTemplateChange(flow?.templates[0].id);
	}

	trimErrorMessage(msg: string): string;
	trimErrorMessage(err: unknown): string;
	trimErrorMessage(msgOrErr: unknown): string {
		const maxLength = 1000;
		let msg: string;
		if (typeof msgOrErr === 'string') {
			msg = msgOrErr;
		} else if (msgOrErr && typeof msgOrErr === 'object' && 'error' in msgOrErr) {
			// HttpErrorResponse — prefer the server's message body
			const body = (msgOrErr as any).error;
			msg = (typeof body === 'object' && body?.message)
				? (Array.isArray(body.message) ? body.message.join('; ') : String(body.message))
				: String((msgOrErr as any).message ?? msgOrErr);
		} else {
			msg = String((msgOrErr as any)?.message ?? msgOrErr);
		}
		if (msg.length <= maxLength) return msg;
		return msg.slice(0, maxLength) + "...";
	}

	async onTemplateChange(id: string) {
		// Set the selected template
		this.selectedTemplate.set(id);

		// If the template is custom, there's nothing to do
		if (id === "custom") return;

		// Get the template data of the selected template
		const activeFlow = this.activeFlow();
		const template = activeFlow?.templates.find((t) => t.id === id);

		if (!activeFlow || !template) {
			await this.dialog.alert("Corrupted flow and/or template data.");
			return;
		}

		// Apply the template changes
		// Use structuredClone because applyPatch mutates the input object
		// Which won't trigger updates in the signal
		const doc = structuredClone(this.selectedApiData());

		if (!doc) {
			await this.dialog.alert("Missing selected API data.");
			return;
		}

		// Build JSON Patch ops from template changes
		const ops: Operation[] = [];

		for (const change of template.changes) {
			const cfg = activeFlow.configurables.find((c) => c.id === change.configId);

			// If configurable is missing or has no target path, skip
			if (!cfg?.target) continue;

			// Are we changing the visibility of an element?
			if (change.visible !== undefined) {
				this.setConfigVisibibility(
					this.selectedFlow() || "",
					cfg.id,
					change.visible,
				);
			}

			if (change.value !== undefined) {
				ops.push({
					op: "replace",
					path: cfg.target,
					value: change.value,
				});
			}

			// Apply patch
			try {
				const result = applyPatch(doc, ops, /*validate*/ true);

				// Update signal with patched doc
				this.selectedApiData.set(result.newDocument);
			} catch (error) {
				await this.dialog.alert(
					`Failed to apply template changes:<br>${this.trimErrorMessage(error)}`,
				);
				return;
			}
		}

		// Always sync the placeholder after template changes are applied,
		// including when the template has no changes (dimensions live in base apiData).
		this.syncPhotoURL();
	}

	private pointerGet(obj: any, pointer: string | null) {
		if (!pointer) return undefined;

		// JSON Pointer: split, decode ~1 => /, ~0 => ~
		const parts = pointer
			.split("/")
			.slice(1)
			.map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));

		let cur = obj;
		for (const key of parts) {
			if (cur == null) return undefined;
			cur = cur[key];
		}
		return cur;
	}

	syncPhotoURL(text?: string) {
		const height = this.getConfigValue("finalImageHeight");
		const width = this.getConfigValue("finalImageWidth");

		const hasDimensions = width != null && height != null;
		const w = hasDimensions ? width : 600;
		const h = hasDimensions ? height : 400;
		const label = text ?? (hasDimensions ? undefined : 'Result Dimension Varies');

		this.resultPhotoURL.set(placeholderImage(w, h, label));
		this.resultPhotoAlt.set(label ?? `${w}x${h} placeholder image`);
	}

	setConfigVisibibility(flowId: string, configId: string, visible: boolean) {
		if (!flowId) return;

		this.flows.update((list) =>
			list.map((flow) => {
				if (flow.id !== flowId) return flow;

				return {
					...flow,
					configurables: flow.configurables.map((c) =>
						c.id === configId ? { ...c, visible } : c,
					),
				};
			}),
		);
	}

	getConfigValue(configId: string) {
		const cfg = this.activeFlow()?.configurables.find((c) => c.id === configId);
		if (!cfg?.target) return undefined;

		if (cfg.type === 'lora') {
			const sel = this.loraSelections();
			return configId in sel ? sel[configId] : this.pointerGet(this.selectedApiData(), cfg.target);
		}

		return this.pointerGet(this.selectedApiData(), cfg.target);
	}

	private resetPrompts() {
		this.setConfigValue("positivePrompt", "");
		this.setConfigValue("negativePrompt", "");
	}

	swapDimensions() {
		const w = this.getConfigValue("finalImageWidth");
		const h = this.getConfigValue("finalImageHeight");
		this.setConfigValue("finalImageWidth", h);
		this.setConfigValue("finalImageHeight", w);
	}

	// ── Dimension Calculator ────────────────────────────────────────────────────
	async openDimCalc() {
		const initialW = this.canSwapDimensions() ? Number(this.getConfigValue("finalImageWidth")) || 0 : 0;
		const initialH = this.canSwapDimensions() ? Number(this.getConfigValue("finalImageHeight")) || 0 : 0;
		const result = await this.dialog.openDimCalc(this.canSwapDimensions(), initialW, initialH);
		if (result) {
			if (result.w) this.setConfigValue("finalImageWidth", result.w);
			if (result.h) this.setConfigValue("finalImageHeight", result.h);
		}
	}

	async setConfigValue(configId: string, raw: any) {
		const cfg = this.activeFlow()?.configurables.find((c) => c.id === configId);
		if (!cfg?.target) return;

		// Lora selections are tracked separately and applied at submit time
		// to avoid writing empty/invalid values into apiData.
		if (cfg.type === 'lora') {
			const value = typeof raw === 'string' ? raw : String(raw);
			this.loraSelections.update((s) => ({ ...s, [configId]: value }));
			return;
		}

		const value = typeof raw === 'number' ? raw : raw.toString();
		const doc = structuredClone(this.selectedApiData());

		// Use add if missing, replace if exists
		const exists = this.pointerGet(doc, cfg.target) !== undefined;

		try {
			const result = applyPatch(
				doc,
				[{ op: exists ? "replace" : "add", path: cfg.target, value }],
				true,
			);

			this.selectedApiData.set(result.newDocument);

			// Update the placeholder image
			if (cfg.id === "finalImageHeight" || cfg.id === "finalImageWidth") {
				this.syncPhotoURL();
			}
		} catch (error) {
			await this.dialog.alert(
				`Failed to set config value:<br>${this.trimErrorMessage(error)}`,
			);
			return;
		}

		// Propagate to any configs bound to this one (cycle-safe)
		await this.propagateBindings(configId, value);
	}

	scrollToConsole() {
		this.scroller.setOffset([0, 64]);
		this.scroller.scrollToAnchor("consoleWrapper");

		const element = this.consoleWrapperElement?.nativeElement;
		if (element) {
			element.animate(
				[
					{
						boxShadow: "0 0 0 0 rgba(255,255,255,0)",
					},
					{
						boxShadow: "0 0 0 2px rgba(255,255,255,0.2)",
					},
					{
						boxShadow: "0 0 0 0 rgba(255,255,255,0)",
					},
					{
						boxShadow: "0 0 0 2px rgba(255,255,255,0.2)",
					},
				],
				{ duration: 1200, easing: "ease-out" },
			);
		}
	}


	/**
	 * Start the loading indicator.
	 * @param text    Label shown in the status bar (e.g. "Uploading…")
	 * @param withBar Show the progress bar track (set false for indeterminate tasks)
	 */
	startLoading(text: string = "Loading…", withBar: boolean = true): void {
		this.isLoading.set(true);
		this.showProgressBar.set(withBar);
		this.progressBarProgress.set(0);
		this.progressText.set(text);
		this.startTime.set(new Date());
	}

	/**
	 * Update the loading state mid-task.
	 * @param text       Optional new label
	 * @param percent    Optional 0-100 progress value; omit to leave bar unchanged
	 */
	updateLoading(text?: string, percent?: number): void {
		if (text !== undefined) this.progressText.set(text);
		if (percent !== undefined)
			this.progressBarProgress.set(Math.min(100, Math.max(0, percent)));
	}

	/**
	 * Stop the loading indicator and clear all state.
	 */
	focusConfig(id: string): void {
		const doFocus = () => {
			const el = document.querySelector<HTMLElement>(`[data-config-id="${id}"]`);
			if (!el) return;
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			el.focus({ preventScroll: true });
			el.classList.remove("config-flash");
			void el.offsetWidth;
			el.classList.add("config-flash");
			el.addEventListener(
				"animationend",
				() => el.classList.remove("config-flash"),
				{ once: true },
			);
		};

		// If element not in DOM, it's likely inside collapsed Advanced Settings — open it first
		const el = document.querySelector<HTMLElement>(`[data-config-id="${id}"]`);
		if (!el && this.advancedCollapsed()) {
			this.advancedCollapsed.set(false);
			// Wait for Angular to render the newly expanded section
			setTimeout(doFocus, 50);
		} else {
			doFocus();
		}
	}

	private startQueuePoll(bookId: string): void {
		this.stopQueuePoll();
		const poll = () => {
			firstValueFrom(this.db.getQueueStatus(bookId)).then((status) => {
				const total = status.queue_running.length + status.queue_pending.length;
				this.queueDepth.set(total >= 1 ? total : null);
			}).catch(() => {});
		};
		poll();
		this.queuePollTimer = setInterval(poll, 3000);
	}

	private stopQueuePoll(): void {
		if (this.queuePollTimer !== null) {
			clearInterval(this.queuePollTimer);
			this.queuePollTimer = null;
		}
		this.queueDepth.set(null);
	}

	private ordinal(n: number): string {
		const v = n % 100;
		const s = ['th', 'st', 'nd', 'rd'];
		return n + (s[(v - 20) % 10] || s[v] || s[0]);
	}

	queueLabel(depth: number): string {
		if (depth === 1) return 'Running';
		if (depth === 2) return 'Next in queue · 1 job ahead';
		return `${this.ordinal(depth)} in queue · ${depth - 1} jobs ahead`;
	}

	stopLoading(): void {
		this.isLoading.set(false);
		this.showProgressBar.set(false);
		this.progressBarProgress.set(0);
		this.progressText.set("");
		this.quickFlowRunningName.set(null);
		this.stopQueuePoll();
	}

	onCanvasImageLoad(ev: Event): void {
		const img = ev.target as HTMLImageElement;
		if (!img.src || img.src.startsWith("data:")) return;
		if (img.naturalWidth && img.naturalHeight) {
			this.canvasImageNaturalSize.set({
				w: img.naturalWidth,
				h: img.naturalHeight,
			});
		}
		if (this.isLoading()) {
			this.stopLoading();
		}
	}


	async queueFlow(): Promise<void> {
		const count = Math.max(1, Math.min(99, this.repeatCount()));
		const flow = this.activeFlow();
		const templateId = this.selectedTemplate();
		if (!flow?.id || !templateId) return;

		// Build base overrides once — validates images before firing any jobs
		const baseOverrides: Record<string, string | number> = {};
		for (const cfg of flow.configurables) {
			if (cfg.type === 'inputImage') {
				const imgId = this.inputImagesMap()[cfg.id];
				const meta = this.uploadedAssets().find((a) => a.id === imgId);
				const url = meta?.url || '';
				const { filename, subfolder } = this.extractExtraAssetParams(url);
				if (!filename) {
					await this.dialog.alert(`Missing required input image: ${cfg.name}`);
					return;
				}
				baseOverrides[cfg.id] = subfolder ? `${subfolder}/${filename}` : filename;
			} else if (cfg.type === 'lora') {
				const sel = this.loraSelections()[cfg.id];
				if (sel) baseOverrides[cfg.id] = sel;
			} else {
				const val = this.getConfigValue(cfg.id);
				if (val !== undefined && val !== '') baseOverrides[cfg.id] = val as string | number;
			}
		}

		if (!this.isQueueRunning()) {
			this.startLoading();
			this.scrollToConsole();
			if (!this.isInputImageFlow()) this.syncPhotoURL("Generating...");
		}
		this.activeQueueJobs.update(n => n + count);

		const selectedFlowName = flow.name;
		const selectedTemplateName = flow.templates.find((t) => t.id === templateId)?.name;
		this.log(
			count > 1
				? `Queuing <span class="warn">${count}</span> jobs — ${selectedFlowName} › ${selectedTemplateName}.`
				: `Starting queue — <span class="warn">${selectedFlowName}</span> › <span class="warn">${selectedTemplateName}</span>.`,
			'success',
		);

		const configString = Object.entries(baseOverrides)
			.filter(([k]) => k !== 'seed' && k !== 'positivePrompt' && k !== 'negativePrompt')
			.map(([k, v]) => `${k}=${v}`)
			.join(', ');
		if (configString) this.log(`Parameters: ${configString}`);

		// Fire all jobs in parallel — ComfyUI queues them server-side
		for (let i = 0; i < count; i++) {
			const overrides = { ...baseOverrides };
			if (this.randomizeSeed()) {
				const seed = Math.floor(Math.random() * 2147483647);
				overrides['seed'] = seed;
				if (count === 1) {
					this.log(`Randomized seed: ${seed}.`);
					this.setConfigValue('seed', seed);
				}
			}
			this.runSingleQueueJob(flow, templateId, overrides, count, i + 1);
		}
	}

	private async runSingleQueueJob(
		flow: FlowConfig,
		templateId: string,
		overrides: Record<string, string | number>,
		totalCount: number,
		jobIndex: number,
	): Promise<void> {
		const label = totalCount > 1 ? `[Job ${jobIndex}/${totalCount}] ` : '';
		try {
			const { promptId, seed, apiData } = await firstValueFrom(
				this.db.submitFlow(this.bookId, { flowId: flow.id!, templateId, overrides }),
			);
			this.currentPromptId.set(promptId);
			if (seed !== undefined && totalCount === 1) this.setConfigValue('seed', seed);
			if (this.queuePollTimer === null) this.startQueuePoll(this.bookId);
			firstValueFrom(this.db.getQueueStatus(this.bookId)).then((status) => {
				const total = status.queue_running.length + status.queue_pending.length;
				if (total > 1) this.log(`${label}Queue position: ${total} jobs running/pending (${total - 1} ahead).`, 'warn');
			}).catch(() => {});

			const result = await firstValueFrom(this.db.waitFlowResult(this.bookId, promptId));
			const fileURL = this.db.httpEndpoint() + result.viewPath;
			this.log(`${label}Result: <a href="${fileURL}" target="_BLANK">${fileURL}</a>.`);
			this.resultPhotoURL.set(fileURL);

			const seedTarget = this.activeFlow()?.configurables.find(c => c.id === 'seed')?.target;
			await this.assetService.addAsset('output', {
				filename: result.filename,
				subfolder: result.subfolder,
				type: 'input',
				url: fileURL,
				apiData: JSON.stringify(apiData),
				promptPositive: this.getConfigValue('positivePrompt') as string | undefined,
				promptNegative: this.getConfigValue('negativePrompt') as string | undefined,
				seed: seedTarget ? seedTarget.replace(/^\//, '') : undefined,
			});
		} catch (error) {
			const msg = this.trimErrorMessage(error);
			this.log(`<strong>${label}Failed:</strong> ${msg}`, 'danger');
			if (totalCount === 1) this.dialog.alert(`Failed to queue flow: ${msg}`);
		} finally {
			this.activeQueueJobs.update(n => Math.max(0, n - 1));
			if (this.activeQueueJobs() === 0) this.stopLoading();
		}
	}

	isHistoryEmpty(jsonData: Record<string, unknown>): boolean {
		if (jsonData === null || typeof jsonData !== "object") {
			return true;
		}

		return Object.keys(jsonData).length === 0;
	}

	// ── Multirun ──────────────────────────────────────────────────────────────

	async runMultirun(payload: MultirunRunPayload): Promise<void> {
		if (this.multirunRunning()) return;

		this.multirunRunning.set(true);
		this.scrollToConsole();

		// Initialise all entries as pending
		const initial: Record<string, MultirunEntryStatus> = {};
		for (const entry of payload.entries) {
			initial[entry.id] = { state: 'pending', progress: 0 };
		}
		this.multirunStatuses.set(initial);

		const runAssets: StoredImageAsset[] = [];
		for (const entry of payload.entries) {
			this.multirunCurrentEntryId.set(entry.id);
			this.multirunStatuses.update((s) => ({
				...s,
				[entry.id]: { state: 'running', progress: 0 },
			}));

			try {
				const flow = this.flows().find((f) => f.id === entry.flowId);
				const templateName = flow?.templates.find((t) => t.id === entry.templateId)?.name ?? '';
				this.log(`[Multirun] Running: <span class="warn">${flow?.name ?? entry.flowId}</span> / ${templateName}`);

				// Resolve overrides: shared field links take priority over per-entry overrides
				const overrides: Record<string, string | number> = {};
				for (const [cfgId, value] of Object.entries(entry.overrides)) {
					if (value !== '' && !entry.links[cfgId]) overrides[cfgId] = value;
				}
				for (const [cfgId, fieldId] of Object.entries(entry.links)) {
					const field = payload.sharedFields.find((f) => f.id === fieldId);
					if (field?.value !== undefined && field.value !== '') overrides[cfgId] = field.value;
				}

				const { promptId, apiData } = await firstValueFrom(
					this.db.submitFlow(this.bookId, {
						flowId: entry.flowId,
						templateId: entry.templateId,
						overrides,
					}),
				);
				this.currentPromptId.set(promptId);

				const result = await firstValueFrom(this.db.waitFlowResult(this.bookId, promptId));

				const fileURL = this.db.httpEndpoint() + result.viewPath;
				this.resultPhotoURL.set(fileURL);

				const seedTargetMr = this.activeFlow()?.configurables.find(c => c.id === 'seed')?.target;
				const added = await this.assetService.addAsset('output', {
					filename: result.filename,
					subfolder: result.subfolder,
					type: 'input',
					url: fileURL,
					apiData: JSON.stringify(apiData),
					seed: seedTargetMr ? seedTargetMr.replace(/^\//, '') : undefined,
				});
				if (added) runAssets.push(added);

				this.multirunStatuses.update((s) => ({
					...s,
					[entry.id]: { state: 'done', progress: 100, resultUrl: fileURL },
				}));

			} catch (e) {
				const msg = this.trimErrorMessage(e);
				this.log(`[Multirun] Failed: ${msg}`, 'danger');
				this.multirunStatuses.update((s) => ({
					...s,
					[entry.id]: { state: 'error', progress: 0, error: msg },
				}));
				// Continue to next entry
			}
		}

		this.multirunCurrentEntryId.set(null);
		this.multirunRunning.set(false);
		this.log('[Multirun] All entries finished.', 'success');

		// Auto-enter gallery mode with the run's result assets
		if (runAssets.length) {
			this.openGalleryMode(runAssets, 0);
		}
	}

	private scrollToBottom() {
		const element = this.consoleElement?.nativeElement;
		if (element) element.scrollTop = element.scrollHeight;
	}

	log(message: string, type: LogEntry["type"] = "muted") {
		const now = new Date();
		const time = now.toLocaleTimeString("en-GB", { hour12: true });

		const entry: LogEntry = {
			time,
			message,
			type,
		};

		this.logs.update((curr) => {
			const next = [...curr, entry];
			return next.length > this.MAX_LINES
				? next.slice(next.length - this.MAX_LINES)
				: next;
		});

		// Strip HTML tags and decode entities for the plain status bar display
		const tmp = document.createElement("div");
		tmp.innerHTML = message.replace(/<[^>]*>/g, "");
		const plain = tmp.textContent ?? "";
		this.lastLogText.set(plain);

		// Reset animation to start position before showing new text
		this.statusScrollActive.set(false);
		setTimeout(() => {
			this.statusScrollActive.set(true);
			// Measure real overflow after Angular renders the new text
			const el = this.statusTextRef?.nativeElement;
			if (el) {
				this.statusTextOverflows.set(el.scrollWidth > el.clientWidth);
			}
		}, 0);

		if (this.clearLogTimer) clearTimeout(this.clearLogTimer);
		this.clearLogTimer = setTimeout(() => this.lastLogText.set(""), 5000);

		// Let Angular render first, then scroll
		setTimeout(() => this.scrollToBottom());
	}

	toggleDropdown(id: string): void {
		this.openDropdownId.update((curr) => (curr === id ? null : id));
	}

	closeDropdown(): void {
		this.openDropdownId.set(null);
	}

	getLoraOptions(presets: string[] | undefined): FsEntry[] {
		const files = this.loraFiles().filter((f) => f.name.includes('.'));
		if (!presets?.length) return files;
		return files.filter((f) => presets.includes(f.path));
	}

	openLoraInfo(configId: string): void {
		const value = this.getConfigValue(configId);
		if (!value) return;
		const entry = this.loraFiles().find((f) => f.path === value);
		if (!entry) return;
		this.loraInfoEntry.set({ entry, fullPath: `loras/${entry.path}` });
	}

	@HostListener("document:click", ["$event"])
	onDocumentClick(event: MouseEvent): void {
		const target = event.target as HTMLElement;
		if (!target.closest(".dropdown")) {
			this.openDropdownId.set(null);
		}
		if (!target.closest(".bind-container")) {
			this.bindingPopoverFor.set(null);
		}
	}

	selectTemplatePrompt(i: number) {
		this.selectedTemplatePromptIndex.set(i);
	}

	private isDialogOpen(): boolean {
		return !!document.querySelector("app-dialog");
	}

	@HostListener("document:keydown.escape")
	onEscape(): void {
		if (this.isDialogOpen()) return;
		// Close in priority order — most-modal first
		if (this.galleryModeActive()) {
			this.closeGalleryMode();
			return;
		}
		if (this.bindingPopoverFor()) {
			this.bindingPopoverFor.set(null);
			return;
		}
		if (this.promptTemplatesVisible()) {
			this.closePromptTemplates();
			return;
		}
		if (this.galleryVisible()) {
			this.closeGallery();
			return;
		}
		if (this.flowsOverlayVisible()) {
			this.flowsOverlayVisible.set(false);
			return;
		}
		if (this.bookInfoVisible()) {
			this.bookInfoVisible.set(false);
			return;
		}
		if (this.consoleOverlayVisible()) {
			this.consoleOverlayVisible.set(false);
			return;
		}
	}

	closePromptTemplates(): void {
		if (this.isDialogOpen()) return;
		this.promptTemplatesVisible.set(false);
	}

	showPromptTemplates(): void {
		this.promptSearchQuery.set("");
		this.selectedTemplatePromptIndex.set(null);
		this.promptTemplatesVisible.set(true);
	}

	@HostListener("document:keydown.arrowleft", ["$event"])
	onArrowLeft(e: Event): void {
		if (!this.galleryModeActive()) return;
		e.preventDefault();
		const len = this.galleryModeAssets().length;
		if (len > 1) this.galleryModeIndex.update((i) => (i - 1 + len) % len);
	}

	@HostListener("document:keydown.arrowright", ["$event"])
	onArrowRight(e: Event): void {
		if (!this.galleryModeActive()) return;
		e.preventDefault();
		const len = this.galleryModeAssets().length;
		if (len > 1) this.galleryModeIndex.update((i) => (i + 1) % len);
	}

	onHistoryItemClick(asset: StoredImageAsset, event: MouseEvent): void {
		if (this.gallerySelectMode()) {
			this.toggleAssetSelection(asset.id, event, this.visibleOutputAssets());
		} else if (this.galleryMode() === "compare") {
			this.setBeforePhoto(asset.url);
			this.compareMode.set(true);
		} else if (!this.isLoading()) {
			this.resultPhotoURL.set(asset.url);
		}
	}

	toggleSelectMode(): void {
		this.gallerySelectMode.update((v) => !v);
		this.selectedAssetIds.set(new Set());
		this.lastSelectedIndex = -1;
	}

	openGalleryMode(assets: StoredImageAsset[], startIndex = 0): void {
		this.galleryModeAssets.set(assets);
		this.galleryModeIndex.set(startIndex);
		this.galleryModeActive.set(true);
	}

	closeGalleryMode(): void {
		this.galleryModeActive.set(false);
	}

	viewSelectedInGalleryMode(): void {
		const ids = this.selectedAssetIds();
		const source = this.galleryTab() === 'output' ? this.visibleOutputAssets() : this.visibleInputAssets();
		const assets = source.filter((a) => ids.has(a.id));
		if (!assets.length) return;
		this.openGalleryMode(assets, 0);
	}

	openGalleryModeFromNav(): void {
		this.galleryTab.set('output');
		this.gallerySelectMode.set(true);
		this.selectedAssetIds.set(new Set());
		this.galleryVisible.set(true);
	}

	toggleAssetSelection(
		id: string,
		event?: MouseEvent,
		allAssets?: { id: string }[],
	): void {
		const currentIndex = allAssets?.findIndex((a) => a.id === id) ?? -1;

		if (
			event?.shiftKey &&
			allAssets &&
			this.lastSelectedIndex >= 0 &&
			currentIndex >= 0
		) {
			// Shift+click: select contiguous range
			const from = Math.min(this.lastSelectedIndex, currentIndex);
			const to = Math.max(this.lastSelectedIndex, currentIndex);
			this.selectedAssetIds.update((curr) => {
				const next = new Set(curr);
				for (let i = from; i <= to; i++) next.add(allAssets[i].id);
				return next;
			});
		} else {
			// Ctrl+click or plain click: toggle single item
			this.selectedAssetIds.update((curr) => {
				const next = new Set(curr);
				next.has(id) ? next.delete(id) : next.add(id);
				return next;
			});
			if (currentIndex >= 0) this.lastSelectedIndex = currentIndex;
		}
	}

	isAssetSelected(id: string): boolean {
		return this.selectedAssetIds().has(id);
	}

	async bulkDeleteSelected(): Promise<void> {
		const ids = [...this.selectedAssetIds()];
		if (!ids.length) return;

		const confirmed = await this.dialog.confirm(
			`Delete ${ids.length} selected image${ids.length > 1 ? "s" : ""}? This cannot be undone.`,
		);
		if (!confirmed) return;

		const total = ids.length;

		this.isLoading.set(true);
		this.progressBarProgress.set(0);

		for (let i = 0; i < total; i++) {
			const id = ids[i];
			const assets = [...this.uploadedAssets(), ...this.generatedAssets()];
			const asset = assets.find((a) => a.id === id);
			const name = asset?.filename || id;

			this.log(`Deleting ${name}... (${i + 1}/${total})`);
			this.removeAsset(id);
			this.progressBarProgress.set(Math.round(((i + 1) / total) * 100));
		}

		this.log(`Deleted ${total} image${total > 1 ? "s" : ""}.`, "success");
		this.selectedAssetIds.set(new Set());
		this.gallerySelectMode.set(false);
		this.lastSelectedIndex = -1;

		setTimeout(() => {
			this.isLoading.set(false);
			this.progressBarProgress.set(0);
		}, 800);
	}

	toggleContentLock(): void {
		const nowLocked = !this.contentLocked();
		this.contentLocked.set(nowLocked);
		this.log(nowLocked ? "Hidden content locked." : "Hidden content unlocked.");
	}

	@HostListener("document:keydown.alt.l", ["$event"])
	onAltL(event: Event): void {
		event.preventDefault();
		this.toggleContentLock();
	}

	closeGallery(): void {
		this.galleryVisible.set(false);
		this.gallerySelectMode.set(false);
		this.selectedAssetIds.set(new Set());
	}

	showGallery(configId?: string, tab?: "input" | "output"): void {
		if (!configId && tab === undefined) {
			this.galleryVisible.update((v) => !v);
			return;
		}
		this.currentInputImageConfigId.set(configId ?? "");
		if (tab) {
			this.galleryTab.set(tab);
		} else if (configId) {
			this.galleryTab.set("input");
			this.galleryMode.set("select");
		}
		this.galleryVisible.set(true);
	}

	insertPrompt() {
		const template = this.activeTemplate();
		const index = this.selectedTemplatePromptIndex();

		if (!template || index === null) return;

		const prompt = template.promptTemplates[index];

		// This updates selectedApiData → textarea updates automatically
		this.setConfigValue("positivePrompt", prompt.positive);

		if (prompt.negative) {
			this.setConfigValue("negativePrompt", prompt.negative);
		}

		this.closePromptTemplates();
	}

	async deletePromptTemplate(): Promise<void> {
		const flow = this.activeFlow();
		const template = this.activeTemplate();
		const index = this.selectedTemplatePromptIndex();
		if (!flow?.id || !template || index === null) return;

		const confirmed = await this.dialog.confirm(
			"Delete this prompt? This cannot be undone.",
		);
		if (!confirmed) return;

		const updatedTemplates = flow.templates.map((t) =>
			t.id === template.id
				? { ...t, promptTemplates: t.promptTemplates.filter((_, i) => i !== index) }
				: t,
		);
		const updatedFlow: FlowConfig = { ...flow, templates: updatedTemplates };

		try {
			await firstValueFrom(this.db.updateFlow(this.bookId, flow.id, updatedFlow));
			this.flows.update((list) =>
				list.map((f) => (f.id === flow.id ? updatedFlow : f)),
			);
			this.selectedTemplatePromptIndex.set(null);
			this.log("Prompt deleted from template.", "success");
		} catch (error) {
			await this.dialog.alert(
				`Failed to delete prompt:<br>${this.trimErrorMessage(error)}`,
			);
		}
	}

	async addToPromptTemplate(): Promise<void> {
		const flow = this.activeFlow();
		const template = this.activeTemplate();
		if (!flow?.id || !template) return;

		const positive = (this.getConfigValue("positivePrompt") ?? "") as string;
		const negative = (this.getConfigValue("negativePrompt") ?? "") as string;

		const newPrompt: PromptTemplate = { positive, negative, protected: false };
		const updatedTemplates = flow.templates.map((t) =>
			t.id === template.id
				? { ...t, promptTemplates: [...t.promptTemplates, newPrompt] }
				: t,
		);
		const updatedFlow: FlowConfig = { ...flow, templates: updatedTemplates };

		try {
			await firstValueFrom(this.db.updateFlow(this.bookId, flow.id, updatedFlow));
			this.flows.update((list) =>
				list.map((f) => (f.id === flow.id ? updatedFlow : f)),
			);
			this.log("Prompt saved to template.", "success");
		} catch (error) {
			await this.dialog.alert(
				`Failed to save prompt:<br>${this.trimErrorMessage(error)}`,
			);
		}
	}

	handleImageUpload(file: File): Observable<any> {
		this.log(`Uploading image ${file.name}...`);

		const userFolder = this.authService.user()
			? String(this.authService.user()!.userId)
			: undefined;

		// Upload and return the observable - don't subscribe here
		return this.uploadService
			.uploadImage(this.bookId, file, { subfolder: userFolder })
			.pipe(
				takeUntilDestroyed(this.destroyRef),
				tap(async (response) => {
					// Build the view URL from Comfy response
					const viewUrl = this.uploadService.buildViewUrl(this.bookId, {
						filename: response.name,
						subfolder: response.subfolder,
						type: "input",
					});

					// Store asset in local and cloud storage
					const asset = await this.assetService.addAsset("input", {
						filename: response.name,
						subfolder: response.subfolder,
						type: "input",
						url: viewUrl,
					});

					if (asset?.id) this.selectAsset(asset.id);
				}),
			);
	}

	onFileSelected(event: Event): void {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		this.startLoading("Uploading image…", false);
		this.handleImageUpload(file).subscribe({
			next: (response) => {
				this.log(`OK`, "success");
				this.stopLoading();
			},
			error: (err) => {
				this.log(
					`<strong>Failed to upload image:</strong> ${this.trimErrorMessage(err)}`,
					"danger",
				);
				this.stopLoading();
			},
		});
	}

	selectAsset(assetId: string): void {
		const configId = this.currentInputImageConfigId();

		this.inputImagesMap.update((curr) => {
			return {
				...curr,
				[configId]: assetId,
			};
		});
	}

	selectAssetAndPreview(asset: StoredImageAsset): void {
		this.selectAsset(asset.id);
		this.resultPhotoURL.set(asset.url);
	}

	updateImageDimensionInfo(configId: string, ev: Event) {
		const img = ev.target as HTMLImageElement;

		const assetId = this.inputImagesMap()[configId];
		if (!assetId) return;

		this.imageDimensionMetaData.update((curr) => ({
			...curr,
			[configId]: {
				naturalWidth: img.naturalWidth,
				naturalHeight: img.naturalHeight,
			},
		}));

		this.propagateImageBindings(configId, img.naturalWidth, img.naturalHeight);
	}

	removeAsset(id: string) {
		this.hideImagePreview();
		this.assetService.removeAsset(id);
	}

	async confirmRemoveInputAsset(id: string): Promise<void> {
		const confirmed = await this.dialog.confirm('Delete this uploaded image? This cannot be undone.');
		if (confirmed) this.removeAsset(id);
	}

	openCompareGallery(): void {
		this.galleryMode.set("compare");
		this.galleryVisible.set(true);
	}

	swapCompareImages(): void {
		const before = this.beforePhotoURL();
		const after = this.resultPhotoURL();
		if (!before) return;
		this.resultPhotoURL.set(before);
		this.beforePhotoURL.set(after);
	}

	getBookInfo(): string {
		const editBookURL = `/books`;
		const flow = this.activeFlow();
		const editFlowLine = flow?.id
			? `Click <a href="/bookmaker/${this.bookId}/flowimport/${flow.id}" target="_blank">here</a> to edit the current flow.<br>`
			: '';
		return `
			<strong>HTTP Proxy Endpoint:</strong><br>${this.httpProxiedEndpoint}<br>
			<strong>WS Proxy Endpoint:</strong><br>${this.wsProxiedEndpoint}<br><br>
			<strong>Book ID:</strong> ${this.bookId}<br>
			<strong>Flow ID:</strong> ${flow?.id ?? '(none selected)'}<br><br>
			${editFlowLine}
			Click <a href="${editBookURL}" target="_blank">here</a> to edit your books.
		`;
	}

	showBookInfo(): void {
		this.bookInfoVisible.update((v) => !v);
	}

	setBeforePhoto(url: string) {
		this.beforePhotoURL.set(url);
	}

	private dataUrlToFile(dataUrl: string): File {
		const arr = dataUrl.split(",");
		const mime = arr[0].match(/:(.*?);/)?.[1] || "image/png";
		const bstr = atob(arr[1]);

		let n = bstr.length;
		const u8arr = new Uint8Array(n);
		while (n--) {
			u8arr[n] = bstr.charCodeAt(n);
		}

		const fileName = `comfyfordummies_editor_${Date.now()}.png`;
		return new File([u8arr], fileName, { type: mime });
	}

	async urlToFile(imageUrl: string, filename?: string): Promise<File> {
		// Fetch the image
		const response = await fetch(imageUrl);
		const blob = await response.blob();

		// Generate filename if not provided
		const name =
			filename || `image_${Date.now()}.${blob.type.split("/")[1] || "png"}`;

		// Convert blob to File
		return new File([blob], name, { type: blob.type });
	}

	openImageInEditor(imageUrl: string): void {
		const img = new Image();
		img.crossOrigin = "anonymous";

		img.onload = () => {
			const w = img.naturalWidth;
			const h = img.naturalHeight;

			// Draw image to a temp canvas to get its dataUrl
			const tmp = document.createElement("canvas");
			tmp.width = w;
			tmp.height = h;
			tmp.getContext("2d")!.drawImage(img, 0, 0);
			const dataUrl = tmp.toDataURL("image/png");

			this.editorSvc
				.open({
					initialWidth: w,
					initialHeight: h,
					autoCloseOnDone: false,
					initialState: {
						version: 1,
						width: w,
						height: h,
						backgroundColor: "#ffffff",
						layers: [
							{
								id: "layer_img_1",
								name: "Image",
								type: "image",
								imageData: dataUrl,
								visible: true,
								opacity: 1,
								blendMode: "source-over",
								locked: false,
								x: 0,
								y: 0,
								w,
								h,
								srcDataUrl: dataUrl,
							},
						],
					},
				})
				.subscribe((result) => {
					if (result) {
						this.editorSvc.setDoneButtonLabel("Uploading image...");
						this.editorSvc.setDoneButtonDisabled(true);

						// Convert the edited base64 image back to a File
						const editedFile = this.dataUrlToFile(result.dataUrl);

						this.handleImageUpload(editedFile).subscribe({
							next: (response) => {
								this.log(`OK`, "success");
								this.editorSvc.setDoneButtonLabel("Done");
								this.editorSvc.setDoneButtonDisabled(false);
								this.editorSvc.closeEditor();
								this.showGallery(this.currentInputImageConfigId());
							},
							error: (err) => {
								this.log(
									`<strong>Failed to upload image:</strong> ${this.trimErrorMessage(err)}`,
									"danger",
								);
								// Reset button on error so user can retry
								this.editorSvc.setDoneButtonLabel("Done");
								this.editorSvc.setDoneButtonDisabled(false);
							},
						});
					}
				});
		};

		img.src = imageUrl;
	}

	openCanvasImageMenu(ev: MouseEvent): void {
		if (this.activePageTab() === 'editor') {
			this.openEditorCanvasMenu(ev);
			return;
		}
		const url = this.resultPhotoURL();
		if (!url) return;

		const menuItems = [];

		menuItems.push({
			label: "Open in New Tab",
			run: () => {
				window.open(url, "_blank", "noopener,noreferrer");
			},
		});

		menuItems.push({
			label: "Save Image As",
			run: async () => {
				this.saveImageAs(url);
			},
		});

		menuItems.push({
			label: "Copy Image URL",
			run: () => {
				navigator.clipboard.writeText(url);
			},
		});

		menuItems.push({ divider: true });

		menuItems.push({
			label: "Upload as Input Image",
			disabled: url.startsWith("data:"),
			run: async () => {
				this.isUploadingToInput.set(true);
				this.startLoading("Uploading image…", false);

				// Resolve which input-image slot to target. Use the currently active slot if one is
				// set (e.g. the user already had the gallery open), otherwise fall back to the first
				// inputImage configurable in the active flow. This must be set before the upload so
				// that handleImageUpload's internal selectAsset() call targets the right config ID.
				const configId =
					this.currentInputImageConfigId() ||
					this.activeFlow()?.configurables.find((c) => c.type === "inputImage")
						?.id ||
					"";
				if (configId) this.currentInputImageConfigId.set(configId);

				const editedFile = await this.urlToFile(url);

				this.handleImageUpload(editedFile).subscribe({
					next: () => {
						this.isUploadingToInput.set(false);
						this.stopLoading();
						this.log(`OK`, "success");
						// Open the gallery on the input tab with the newly uploaded image selected.
						// We set signals directly instead of calling showGallery() because showGallery()
						// has an early-return toggle when configId is empty, which would unreliably
						// open or close the gallery depending on its current state.
						this.galleryTab.set("input");
						this.galleryMode.set("select");
						this.galleryVisible.set(true);
					},
					error: (err) => {
						this.isUploadingToInput.set(false);
						this.stopLoading();
						this.log(
							`<strong>Failed to upload image:</strong> ${this.trimErrorMessage(err)}`,
							"danger",
						);
					},
				});
			},
		});

		menuItems.push({
			label: "Open in Editor",
			run: () => {
				this.openImageInEditor(url);
			},
		});

		menuItems.push({ divider: true });

		const canvasAsset =
			this.generatedAssets().find((a) => a.url === url) ??
			(this.pendingRunApiData ? {
				apiData: JSON.stringify(this.pendingRunApiData.apiData),
				promptPositive: this.pendingRunApiData.promptPositive,
				promptNegative: this.pendingRunApiData.promptNegative,
				seed: this.pendingRunApiData.seed,
			} as StoredImageAsset : undefined);

		const canvasHasMeta = !!(canvasAsset?.promptPositive || canvasAsset?.promptNegative || canvasAsset?.seed);

		menuItems.push({
			label: canvasAsset?.apiData ? "Rerun Flow" : "Rerun Flow (no data)",
			disabled: !canvasAsset?.apiData,
			run: () => {
				if (canvasAsset) this.rerunFlow(canvasAsset);
			},
		});

		menuItems.push({
			label: canvasAsset?.promptPositive ? "Copy Prompt" : "Copy Prompt (no data)",
			disabled: !canvasAsset?.promptPositive,
			run: () => {
				if (canvasAsset?.promptPositive) navigator.clipboard.writeText(canvasAsset.promptPositive);
			},
		});

		menuItems.push({
			label: canvasHasMeta ? "Reload Prompts & Seed" : "Reload Prompts & Seed (no data)",
			disabled: !canvasHasMeta,
			run: () => {
				if (canvasAsset) this.loadPromptsAndSeed(canvasAsset);
			},
		});

		menuItems.push({
			label: "Clear",
			disabled: url.startsWith("data:image/svg+xml"),
			run: () => {
				this.syncPhotoURL();
			},
		});

		menuItems.push({ divider: true });
		menuItems.push({
			label: 'Add Mask',
			disabled: url.startsWith('data:'),
			run: () => this.loadUrlInEditor(url),
		});

		this.contextMenu.open(ev, menuItems, null);
	}

	openEditorCanvasMenu(ev: MouseEvent): void {
		const src = this.editorSourceAsset();
		if (!src) return;
		const menuItems: any[] = [];
		if (!this.layerPanel.maskLayer()) {
			menuItems.push({ label: 'Add Mask Layer', run: () => this.layerPanel.addMaskLayer() });
		} else {
			menuItems.push({ label: 'Clear Mask', run: () => this.layerPanel.clearMask() });
			menuItems.push({ label: 'Invert Mask', run: () => this.layerPanel.invertMask() });
			menuItems.push({ divider: true });
			menuItems.push({ label: 'Remove Mask Layer', run: () => this.layerPanel.removeMaskLayer() });
		}
		this.contextMenu.open(ev, menuItems, null);
	}

	openInputImageMenu(ev: MouseEvent, asset: StoredImageAsset) {
		const url = asset.url;
		const menuItems = [];

		menuItems.push({
			label: "Open in New Tab",
			run: async () => {
				window.open(url, "_blank", "noopener,noreferrer");
			},
		});

		menuItems.push({
			label: "Save Image As",
			run: async () => {
				this.saveImageAs(url);
			},
		});

		menuItems.push({
			label: "Copy Image URL",
			run: () => {
				navigator.clipboard.writeText(url);
			},
		});

		menuItems.push({
			label: 'Load in Editor',
			run: () => this.loadInEditor(asset),
		});

		menuItems.push({
			label: "Open in Canvas Editor",
			run: () => {
				this.openImageInEditor(url);
			},
		});

		menuItems.push({ divider: true });

		menuItems.push({
			label: "Move to Folder",
			children: this.buildMoveToFolderChildren(asset),
		});

		if (this.gallerySelectMode() && this.selectedAssetIds().size > 0) {
			menuItems.push({ divider: true });
			menuItems.push({
				label: `Delete Selected (${this.selectedAssetIds().size})`,
				run: () => {
					this.bulkDeleteSelected();
				},
			});
		}

		this.contextMenu.open(ev, menuItems, null);
	}

	loadUrlInEditor(url: string): void {
		const asset = this.assetService.assets$().find(a => a.url === url) ?? {
			id: '',
			filename: url.split('/').pop()?.split('?')[0] ?? 'image',
			url,
			createdAt: new Date().toISOString(),
		} as StoredImageAsset;
		this.loadInEditor(asset);
	}

	exitEditor(): void {
		this.layerPanel.activeTool.set('none');
		this.layerPanel.cancelPolygon();
		this.layerPanel.layerPanelOpen.set(false);
		this.activePageTab.set('generator');
	}

	loadInEditor(asset: StoredImageAsset): void {
		// If the asset was created by the editor, load its source as the base image.
		// Otherwise load the asset itself.
		let baseAsset: StoredImageAsset;
		let layerData: string | null = null;

		if (asset.sourceAssetId != null) {
			const source = this.assetService.getAssetById(String(asset.sourceAssetId));
			baseAsset = source ?? asset;
			layerData = asset.layerData ?? null;
		} else {
			baseAsset = asset;
			layerData = asset.layerData ?? null;
		}

		// Reset view so the canvas-wrap has no transform when the editor opens —
		// a lingering zoom/pan from the generator shifts the image off-center and
		// misaligns the brush cursor circle relative to the actual pointer position.
		this.resetImageView();
		this.galleryVisible.set(false);

		this.editorSourceAsset.set(baseAsset);
		this.layerPanel.removeMaskLayer();
		if (layerData) {
			// Restore saved mask but do not activate any tool — user starts in view mode
			this.layerPanel.addMaskLayer(layerData);
			this.layerPanel.activeTool.set('none');
		}
		this.layerPanel.layerPanelOpen.set(true);
		this.activePageTab.set('editor');
	}

	async exportEditorResult(): Promise<void> {
		const baseAsset = this.editorSourceAsset();
		if (!baseAsset) return;

		this.isExportingMask.set(true);
		try {
			const result = await this.layerPanel.exportAtNaturalResolution(baseAsset.url);
			if (!result) {
				this.dialog.alert('Export failed. Make sure the image is fully loaded.');
				return;
			}

			const userFolder = this.authService.user() ? String(this.authService.user()!.userId) : undefined;
			const response = await firstValueFrom(
				this.uploadService.uploadImage(this.bookId, result.compositedFile, { subfolder: userFolder }),
			);

			const viewUrl = this.uploadService.buildViewUrl(this.bookId, {
				filename: response.name,
				subfolder: response.subfolder,
				type: 'input',
			});

			await this.assetService.addAsset('input', {
				filename: response.name,
				subfolder: response.subfolder,
				type: 'input',
				url: viewUrl,
				sourceAssetId: Number(baseAsset.id) || null,
				layerData: result.layerDataBase64,
			});

			this.exitEditor();
		} catch (err) {
			this.dialog.alert(`Export failed: ${(err as any)?.message ?? err}`);
		} finally {
			this.isExportingMask.set(false);
		}
	}

	async saveImageAs(url: string | null | undefined) {
		if (!url) return;

		// Inline filename guess from URL path
		const guessName = (() => {
			try {
				const u = new URL(url, window.location.href);
				const last = u.pathname.split("/").pop() || "";
				return last && last.includes(".") ? last : "image";
			} catch {
				return "image";
			}
		})();

		try {
			// Try to fetch the bytes so we can force a download
			const res = await fetch(url, { mode: "cors" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);

			const blob = await res.blob();
			const objectUrl = URL.createObjectURL(blob);

			const a = document.createElement("a");
			a.href = objectUrl;
			a.download = guessName;

			document.body.appendChild(a);
			a.click();
			a.remove();

			URL.revokeObjectURL(objectUrl);
		} catch {
			// CORS blocked or fetch failed: fallback to opening the image
			// (browser may allow "Save image as..." from there)
			window.open(url, "_blank", "noopener,noreferrer");
		}
	}

	async rerunFlow(asset: Pick<StoredImageAsset, "apiData" | "promptPositive" | "promptNegative" | "seed">) {
		if (!asset.apiData) {
			this.log("No flow data stored for this image.", "danger");
			return;
		}
		let apiData: any;
		try {
			apiData = JSON.parse(asset.apiData);
		} catch {
			this.log("Failed to parse stored flow data.", "danger");
			return;
		}

		// Respect the randomize seed toggle
		if (this.randomizeSeed() && asset.seed) {
			const parts = asset.seed.split('/'); // e.g. ["76", "inputs", "noise_seed"]
			const nodeId = parts[0];
			if (nodeId && parts.length > 1 && apiData[nodeId]) {
				const n = Math.floor(Math.random() * 2147483647);
				apiData = structuredClone(apiData);
				let obj = apiData[nodeId];
				for (let i = 1; i < parts.length - 1; i++) {
					obj = obj?.[parts[i]];
				}
				if (obj != null) {
					obj[parts[parts.length - 1]] = n;
					this.log(`Randomized noise seed generated. New noise seed: ${n}.`);
				}
			}
		}

		this.startLoading("Rerunning flow…", true);
		if (!this.isInputImageFlow()) this.syncPhotoURL("Generating...");
		this.log("Rerunning flow from history…", "success");

		try {
			const { promptId } = await firstValueFrom(this.db.submitFlowRaw(this.bookId, apiData));
			this.currentPromptId.set(promptId);
			this.startQueuePoll(this.bookId);
			firstValueFrom(this.db.getQueueStatus(this.bookId)).then((status) => {
				const total = status.queue_running.length + status.queue_pending.length;
				if (total > 1) this.log(`Queue position: ${total} jobs running/pending (${total - 1} ahead).`, 'warn');
			}).catch(() => {});

			const result = await firstValueFrom(this.db.waitFlowResult(this.bookId, promptId));

			const fileURL = this.db.httpEndpoint() + result.viewPath;
			this.log(`Extracted photo URL: <a href="${fileURL}" target="_BLANK">${fileURL}</a>.`);
			this.resultPhotoURL.set(fileURL);

			await this.assetService.addAsset('output', {
				filename: result.filename,
				subfolder: result.subfolder,
				type: 'input',
				url: fileURL,
				apiData: JSON.stringify(apiData),
				promptPositive: asset.promptPositive,
				promptNegative: asset.promptNegative,
				seed: asset.seed,
			});

			this.stopLoading();
		} catch (error) {
			const msg = this.trimErrorMessage(error);
			this.log(`<strong>Failed to rerun flow:</strong> ${msg}`, "danger");
			this.dialog.alert(`Failed to rerun flow: ${msg}`);
			this.stopLoading();
		}
	}

	async loadPromptsAndSeed(asset: Pick<StoredImageAsset, "promptPositive" | "promptNegative" | "seed" | "apiData">) {
		if (!this.activeFlow()) {
			this.log("Reload Prompts & Seed: no flow is currently loaded.", "warn");
			return;
		}
		const applied: string[] = [];
		if (asset.promptPositive != null) {
			await this.setConfigValue("positivePrompt", asset.promptPositive);
			applied.push("positive prompt");
		}
		if (asset.promptNegative != null) {
			await this.setConfigValue("negativePrompt", asset.promptNegative);
			applied.push("negative prompt");
		}
		if (asset.seed != null && asset.apiData != null) {
			try {
				const apiDataObj = JSON.parse(asset.apiData);
				const parts = asset.seed.split('/');
				let value: any = apiDataObj;
				for (const part of parts) {
					value = value?.[part];
				}
				if (value != null) {
					await this.setConfigValue("seed", value);
					applied.push("seed");
				}
			} catch {}
		}
		if (applied.length > 0) {
			this.log(`Reloaded: ${applied.join(", ")}.`, "success");
		} else {
			this.log("Reload Prompts & Seed: nothing matched the current flow's configurables.", "warn");
		}
	}

	openOutputImageMenu(ev: MouseEvent, asset: StoredImageAsset) {
		const url = asset.url;
		const menuItems = [];

		menuItems.push({
			label: "Open in New Tab",
			run: async () => {
				window.open(url, "_blank", "noopener,noreferrer");
			},
		});

		menuItems.push({
			label: "Save Image As",
			run: async () => {
				this.saveImageAs(url);
			},
		});

		menuItems.push({
			label: "Copy Image URL",
			run: () => {
				navigator.clipboard.writeText(url);
			},
		});

		menuItems.push({
			label: "Upload as Input Image",
			run: async () => {
				this.isUploadingToInput.set(true);
				this.startLoading("Uploading image…", false);

				// Resolve which input-image slot to target. Use the currently active slot if one is
				// set (e.g. the user already had the gallery open), otherwise fall back to the first
				// inputImage configurable in the active flow. This must be set before the upload so
				// that handleImageUpload's internal selectAsset() call targets the right config ID.
				const configId =
					this.currentInputImageConfigId() ||
					this.activeFlow()?.configurables.find((c) => c.type === "inputImage")
						?.id ||
					"";
				if (configId) this.currentInputImageConfigId.set(configId);

				const editedFile = await this.urlToFile(url);

				this.handleImageUpload(editedFile).subscribe({
					next: () => {
						this.isUploadingToInput.set(false);
						this.stopLoading();
						this.log(`OK`, "success");
						// Open the gallery on the input tab with the newly uploaded image selected.
						// We set signals directly instead of calling showGallery() because showGallery()
						// has an early-return toggle when configId is empty, which would unreliably
						// open or close the gallery depending on its current state.
						this.galleryTab.set("input");
						this.galleryMode.set("select");
						this.galleryVisible.set(true);
					},
					error: (err) => {
						this.isUploadingToInput.set(false);
						this.stopLoading();
						this.log(
							`<strong>Failed to upload image:</strong> ${this.trimErrorMessage(err)}`,
							"danger",
						);
					},
				});
			},
		});

		menuItems.push({
			label: "Open in Editor",
			run: () => {
				this.openImageInEditor(url);
			},
		});

		menuItems.push({ divider: true });

		menuItems.push({
			label: "Move to Folder",
			children: this.buildMoveToFolderChildren(asset),
		});

		menuItems.push({ divider: true });

		menuItems.push({
			label: asset.apiData ? "Rerun Flow" : "Rerun Flow (no data)",
			disabled: !asset.apiData,
			run: () => {
				if (asset.apiData) this.rerunFlow(asset);
			},
		});

		menuItems.push({
			label: asset.promptPositive ? "Copy Prompt" : "Copy Prompt (no data)",
			disabled: !asset.promptPositive,
			run: () => {
				if (asset.promptPositive) navigator.clipboard.writeText(asset.promptPositive);
			},
		});

		const hasMeta = !!(asset.promptPositive || asset.promptNegative || asset.seed);
		menuItems.push({
			label: hasMeta ? "Reload Prompts & Seed" : "Reload Prompts & Seed (no data)",
			disabled: !hasMeta,
			run: () => {
				this.loadPromptsAndSeed(asset);
			},
		});

		if (this.gallerySelectMode() && this.selectedAssetIds().size > 0) {
			menuItems.push({ divider: true });
			menuItems.push({
				label: `Delete Selected (${this.selectedAssetIds().size})`,
				run: () => {
					this.bulkDeleteSelected();
				},
			});
		}

		this.contextMenu.open(ev, menuItems, null);
	}

	// ── Image viewer ──────────────────────────────────────────────────────────

	startImagePan(event: PointerEvent): void {
		if (event.button !== 0 && event.pointerType !== "touch") return;
		// While a mask tool is active, only allow panning when Space is held
		if (this.layerPanel.activeTool() !== 'none' && !this.layerPanel.spacePanning()) return;
		this.contextMenu.close();
		event.preventDefault();

		this._gesturePointers.set(event.pointerId, event);
		this.imageIsPanning.set(true);
		this._resetGestureBase();

		if (this._gestureActive) return; // window listeners already attached
		this._gestureActive = true;

		const onMove = (e: PointerEvent) => {
			if (!this._gesturePointers.has(e.pointerId)) return;
			this._gesturePointers.set(e.pointerId, e);
			if (this._gesturePointers.size >= 2) {
				const [p1, p2] = [...this._gesturePointers.values()];
				const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
				this.imageZoom.set(
					Math.max(
						0.25,
						Math.min(8, this._pinchBaseZoom * (dist / this._pinchBaseDist)),
					),
				);
			} else {
				const [p] = [...this._gesturePointers.values()];
				this.imagePanX.set(p.clientX - this._panBaseX);
				this.imagePanY.set(p.clientY - this._panBaseY);
			}
		};
		const onUp = (e: PointerEvent) => {
			this._gesturePointers.delete(e.pointerId);
			if (this._gesturePointers.size === 0) {
				this.imageIsPanning.set(false);
				this._gestureActive = false;
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				window.removeEventListener("pointercancel", onUp);
			} else {
				// One finger lifted — re-anchor pan to current position
				this._resetGestureBase();
			}
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	private _resetGestureBase(): void {
		if (this._gesturePointers.size >= 2) {
			const [p1, p2] = [...this._gesturePointers.values()];
			this._pinchBaseDist = Math.hypot(
				p2.clientX - p1.clientX,
				p2.clientY - p1.clientY,
			);
			this._pinchBaseZoom = this.imageZoom();
		} else if (this._gesturePointers.size === 1) {
			const [p] = [...this._gesturePointers.values()];
			this._panBaseX = p.clientX - this.imagePanX();
			this._panBaseY = p.clientY - this.imagePanY();
		}
	}

	onImageWheel(event: WheelEvent): void {
		event.preventDefault();
		const delta = event.deltaY > 0 ? 0.9 : 1.1;
		const newZoom = Math.max(0.25, Math.min(8, this.imageZoom() * delta));
		this.imageZoom.set(newZoom);
		if (newZoom <= 1) {
			this.imagePanX.set(0);
			this.imagePanY.set(0);
		}
	}

	resetImageView(): void {
		this.imageZoom.set(1);
		this.imagePanX.set(0);
		this.imagePanY.set(0);
	}

	zoomIn(): void {
		this.imageZoom.set(Math.min(8, this.imageZoom() * 1.25));
	}

	zoomOut(): void {
		const newZoom = Math.max(0.25, this.imageZoom() / 1.25);
		this.imageZoom.set(newZoom);
		if (newZoom <= 1) {
			this.imagePanX.set(0);
			this.imagePanY.set(0);
		}
	}

	ngAfterViewInit(): void {
		if (this.viewerStageRef?.nativeElement) {
			this.layerPanel.stageEl = this.viewerStageRef.nativeElement;
			this.ngZone.runOutsideAngular(() => {
				this.viewerStageRef.nativeElement.addEventListener(
					"wheel",
					(e: WheelEvent) => {
						e.preventDefault();
						this.ngZone.run(() => this.onImageWheel(e));
					},
					{ passive: false },
				);
			});
		}
		if (this.statusScrollRef?.nativeElement) {
			this.ngZone.runOutsideAngular(() => {
				this.statusScrollRef.nativeElement.addEventListener(
					"wheel",
					(e: WheelEvent) => {
						e.preventDefault();
						this.statusScrollRef.nativeElement.scrollLeft += e.deltaY + e.deltaX;
					},
					{ passive: false },
				);
			});
		}
	}

	openQuickFlowMenu(ev: MouseEvent): void {
		ev.preventDefault();
		ev.stopPropagation();

		const btn = ev.currentTarget as HTMLElement;
		this.buildQuickFlowMenu(btn);
	}

	private buildQuickFlowMenu(btn: HTMLElement): void {
		const rect = btn.getBoundingClientRect();
		const groups = this.quickFlowGroups();

		if (!groups.length) {
			this.contextMenu.openAt(
				rect.left,
				rect.bottom + 4,
				[
					{ label: "No quick flows configured", disabled: true },
					{ divider: true },
					{
						label: "Manage Quick Flows",
						run: () => this.router.navigate(["/quick-flows"]),
					},
				],
				null,
			);
			return;
		}

		const items: any[] = [];
		items.push({
			label: "Prompt on Run",
			checked: this.changePromptBeforeRun(),
			keepOpen: true,
			run: () => {
				this.changePromptBeforeRun.update((v) => !v);
				this.buildQuickFlowMenu(btn);
			},
		});
		items.push({ divider: true });
		items.push({ title: true, label: "Your Quick Flows" });
		items.push(
			...groups.map((group) => ({
				label: group.name,
				children:
					group.flows.length > 0
						? group.flows.map((flow) => this.buildFlowMenuItem(flow))
						: [{ label: "No flows in group", disabled: true }],
			})),
		);

		items.push({ divider: true });
		items.push({
			label: "Manage Quick Flows",
			run: () => this.router.navigate(["/quick-flows"]),
		});

		this.contextMenu.openAt(rect.left, rect.bottom + 4, items, null);
	}

	private parseFlowJson<T>(json: string | null | undefined, fallback: T): T {
		if (!json) return fallback;
		try { return JSON.parse(json) as T; } catch { return fallback; }
	}

	private getFlowPromptTemplate(flow: QuickFlow): string {
		if (!flow.positive_prompt_node_id) return '';
		try {
			const api = JSON.parse(flow.api_data);
			const inputs = api[flow.positive_prompt_node_id]?.inputs ?? {};
			for (const v of Object.values(inputs)) {
				if (typeof v === 'string') return v as string;
			}
		} catch {}
		return '';
	}

	private buildFlowMenuItem(flow: QuickFlow): any {
		const template = this.getFlowPromptTemplate(flow);
		const templateVars = parsePromptTemplate(template);
		const askParams = this.parseFlowJson<AskOnRunParam[]>(flow.ask_on_run, []);

		const needsModal = templateVars.length > 0 || askParams.length > 0;

		return {
			label: flow.name,
			run: () => needsModal
				? this.openRunFlowModal(flow)
				: this.runQuickFlow(flow, null, null),
		};
	}

	private async openRunFlowModal(flow: QuickFlow): Promise<void> {
		const template = this.getFlowPromptTemplate(flow);
		const templateVars = parsePromptTemplate(template);
		const result = await this.dialog.openRunFlow(flow, templateVars, this.changePromptBeforeRun());
		if (result === null) return;
		await this.runQuickFlow(flow, result.promptOverride, result.paramValues, result.selectedLabel);
	}

	async runQuickFlow(
		flow: QuickFlow,
		promptOverride: string | null,
		paramValues: Record<string, string> | null,
		selectedLabel: string | null = null,
	): Promise<void> {
		const canvasUrl = this.resultPhotoURL();

		if (canvasUrl.startsWith("data:")) {
			await this.dialog.alert(
				"No image on canvas. Generate or load an image first.",
			);
			return;
		}

		// When called without a modal result, check the "Prompt on Run" toggle
		let overridePrompt = promptOverride;
		if (overridePrompt === null && this.changePromptBeforeRun()) {
			let currentPrompt = "";
			if (flow.positive_prompt_node_id) {
				try {
					const parsedApiData = JSON.parse(flow.api_data);
					currentPrompt =
						parsedApiData[flow.positive_prompt_node_id]?.inputs?.text ?? "";
				} catch {}
			}
			overridePrompt = await this.dialog.prompt("Positive prompt for this run:", {
				defaultValue: currentPrompt,
				multiline: true,
			});
			if (overridePrompt === null) return;
		}

		// Auto-resolve [template vars] in the prompt using default selections
		if (overridePrompt === null && flow.positive_prompt_node_id) {
			const template = this.getFlowPromptTemplate(flow);
			const vars = parsePromptTemplate(template);
			if (vars.length > 0) {
				const defaults = getDefaultSelections(vars);
				overridePrompt = assemblePrompt(template, defaults);
				if (selectedLabel === null) {
					const firstDropdown = vars.find((v) => v.type === 'dropdown');
					if (firstDropdown) {
						const defVal = defaults[firstDropdown.index];
						selectedLabel = firstDropdown.options?.find((o) => o.value === defVal)?.label ?? null;
					}
				}
			}
		}

		const canvasSize = this.canvasImageNaturalSize();
		const displayName = selectedLabel ? `${flow.name} - ${selectedLabel}` : flow.name;

		this.startLoading("Running quick flow…", true);
		this.quickFlowRunningName.set(displayName);
		this.scrollToConsole();
		this.log(`Quick flow: <span class="warn">${flow.name}</span>`, "success");

		try {
			// Upload the current canvas image as an input file to ComfyUI
			this.log("Uploading canvas image to ComfyUI input…");
			const file = await this.urlToFile(canvasUrl);
			const uploadResp = await firstValueFrom(
				this.uploadService.uploadImage(this.bookId, file),
			);
			const filename = uploadResp.name;
			this.log(`Uploaded as: ${filename}`);

			// Parse and patch api_data
			let apiData: any;
			try {
				apiData = JSON.parse(flow.api_data);
			} catch {
				throw new Error("Quick flow has invalid API data JSON.");
			}

			if (!apiData[flow.image_node_id]) {
				throw new Error(
					`Image node "${flow.image_node_id}" not found in API data.`,
				);
			}

			apiData = structuredClone(apiData);
			apiData[flow.image_node_id].inputs.image = filename;

			// Inject positive prompt if provided (preset or "Prompt on Run" override)
			if (
				overridePrompt !== null &&
				flow.positive_prompt_node_id &&
				apiData[flow.positive_prompt_node_id]?.inputs
			) {
				apiData[flow.positive_prompt_node_id].inputs.text = overridePrompt;
			}

			// Inject Ask On Run param values
			const askParams = this.parseFlowJson<AskOnRunParam[]>(flow.ask_on_run, []);
			if (paramValues && askParams.length > 0) {
				for (const param of askParams) {
					const raw = paramValues[param.id];
					if (raw === undefined) continue;
					const node = apiData[param.node_id];
					if (!node?.inputs) continue;
					node.inputs[param.field] = param.type === 'number'
						? (isNaN(parseFloat(raw)) ? raw : parseFloat(raw))
						: raw;
				}
			}

			// Randomize seed if toggle is on and a seed node is configured
			if (
				this.randomizeSeed() &&
				flow.seed_node_id &&
				apiData[flow.seed_node_id]?.inputs
			) {
				const seedField = apiData[flow.seed_node_id].inputs.noise_seed !== undefined
					? 'noise_seed'
					: 'seed';
				apiData[flow.seed_node_id].inputs[seedField] = Math.floor(
					Math.random() * 2147483647,
				);
			}

			// Prefix filename_prefix with bookId (same as queueFlow)
			for (const node of Object.values(apiData) as any[]) {
				if (node?.inputs?.filename_prefix !== undefined) {
					node.inputs.filename_prefix = `${this.bookId}-${node.inputs.filename_prefix}`;
				}
			}

			const promptPositive = flow.positive_prompt_node_id
				? apiData[flow.positive_prompt_node_id]?.inputs?.text
				: undefined;
			const seedPath = flow.seed_node_id && apiData[flow.seed_node_id]?.inputs
				? ((): string => {
					const seedField = apiData[flow.seed_node_id].inputs.noise_seed !== undefined
						? 'noise_seed'
						: 'seed';
					return `${flow.seed_node_id}/inputs/${seedField}`;
				})()
				: undefined;

			if (!canvasSize && !this.isInputImageFlow()) this.syncPhotoURL("Generating...");

			const { promptId } = await firstValueFrom(this.db.submitFlowRaw(this.bookId, apiData));
			this.currentPromptId.set(promptId);
			this.startQueuePoll(this.bookId);
			firstValueFrom(this.db.getQueueStatus(this.bookId)).then((status) => {
				const total = status.queue_running.length + status.queue_pending.length;
				if (total > 1) this.log(`Queue position: ${total} jobs running/pending (${total - 1} ahead).`, 'warn');
			}).catch(() => {});

			const result = await firstValueFrom(this.db.waitFlowResult(this.bookId, promptId));

			const fileURL = this.db.httpEndpoint() + result.viewPath;
			this.log(`Quick flow complete. URL: <a href="${fileURL}" target="_BLANK">${fileURL}</a>.`);
			this.resultPhotoURL.set(fileURL);

			await this.assetService.addAsset('output', {
				filename: result.filename,
				subfolder: result.subfolder,
				type: 'input',
				url: fileURL,
				apiData: JSON.stringify(apiData),
				promptPositive,
				seed: seedPath,
			});

			this.stopLoading();
		} catch (error) {
			const msg = this.trimErrorMessage(error);
			this.log(`<strong>Quick flow failed:</strong> ${msg}`, "danger");
			this.dialog.alert(`Quick flow failed: ${msg}`);
			this.stopLoading();
		}
	}

	goToBooks() {
		this.router.navigate(["/books"]);
	}

	async logOut() {
		let confirm = await this.dialog.confirm("Are you sure you want to log out?");

		if (confirm) {
			this.authService.logout();
		}
	}

	// ── Bindings ─────────────────────────────────────────────────────────────

	getBindableConfigs(forConfigId: string): Configurable[] {
		return this.numberConfigurables().filter((c) => c.id !== forConfigId);
	}

	getBindingFor(configId: string): BindingTarget | undefined {
		return this.configBindings()[configId];
	}

	getBindingLabel(configId: string): string {
		const binding = this.configBindings()[configId];
		if (!binding) return "";
		if (binding.type === "configurable") {
			const cfg = this.activeFlow()?.configurables.find(
				(c) => c.id === binding.configId,
			);
			return cfg?.name ?? binding.configId;
		}
		const cfg = this.activeFlow()?.configurables.find(
			(c) => c.id === binding.imageConfigId,
		);
		const dim = binding.type === "imageWidth" ? "Width" : "Height";
		return `${cfg?.name ?? binding.imageConfigId} → ${dim}`;
	}

	toggleBindingPopover(configId: string, event: MouseEvent): void {
		event.stopPropagation();
		this.bindingPopoverFor.update((curr) =>
			curr === configId ? null : configId,
		);
	}

	async bindConfig(configId: string, target: BindingTarget): Promise<void> {
		this.configBindings.update((curr) => ({ ...curr, [configId]: target }));
		this.bindingPopoverFor.set(null);
		this.applyBinding(configId, target);

		const cfgName =
			this.activeFlow()?.configurables.find((c) => c.id === configId)?.name ??
			configId;
		this.log(
			`Bound <span class="warn">${cfgName}</span> → <span class="warn">${this.getBindingLabel(configId)}</span>.`,
			"accent",
		);

		const save = await this.dialog.confirm(
			'Save this binding to the workflow?<br><small style="opacity:0.6">It will persist for everyone using this flow.</small>',
		);
		if (save) {
			await this.persistBindingsToServer();
			this.log(
				`Binding for <span class="warn">${cfgName}</span> saved to workflow.`,
				"success",
			);
		}
	}

	async unbindConfig(configId: string): Promise<void> {
		const wasSaved = !!this.activeFlow()?.bindings?.[configId];
		const cfgName =
			this.activeFlow()?.configurables.find((c) => c.id === configId)?.name ??
			configId;
		const sourceLabel = this.getBindingLabel(configId);
		this.configBindings.update((curr) => {
			const next = { ...curr };
			delete next[configId];
			return next;
		});
		this.bindingPopoverFor.set(null);

		this.log(
			`Unbound <span class="warn">${cfgName}</span> from <span class="warn">${sourceLabel}</span>.`,
			"muted",
		);

		if (wasSaved) {
			const save = await this.dialog.confirm(
				"Remove this binding from the saved workflow too?",
			);
			if (save) {
				await this.persistBindingsToServer();
				this.log(
					`Binding for <span class="warn">${cfgName}</span> removed from workflow.`,
					"success",
				);
			}
		}
	}

	private applyBinding(configId: string, target: BindingTarget): void {
		if (target.type === "configurable") {
			const val = this.getConfigValue(target.configId);
			if (val != null) this.setConfigValue(configId, val);
		} else {
			const dims = this.imageDimensionMetaData()[target.imageConfigId];
			if (dims) {
				const val =
					target.type === "imageWidth" ? dims.naturalWidth : dims.naturalHeight;
				this.setConfigValue(configId, val);
			}
		}
	}

	private async persistBindingsToServer(): Promise<void> {
		const flow = this.activeFlow();
		if (!flow?.id) return;

		const updatedFlow: FlowConfig = { ...flow, bindings: this.configBindings() };

		try {
			await firstValueFrom(this.db.updateFlow(this.bookId, flow.id, updatedFlow));
			this.flows.update((list) =>
				list.map((f) => (f.id === flow.id ? updatedFlow : f)),
			);
		} catch (error) {
			await this.dialog.alert(
				`Failed to save binding:<br>${this.trimErrorMessage(error)}`,
			);
		}
	}

	private loadBindings(flowId: string): void {
		const flow = this.flows().find((f) => f.id === flowId);
		this.configBindings.set(flow?.bindings ?? {});
	}

	private async propagateBindings(
		sourceConfigId: string,
		value: string,
	): Promise<void> {
		if (this._propagatingFromSet.has(sourceConfigId)) return;
		this._propagatingFromSet.add(sourceConfigId);

		for (const [configId, binding] of Object.entries(this.configBindings())) {
			if (binding.type === "configurable" && binding.configId === sourceConfigId) {
				await this.setConfigValue(configId, value);
			}
		}

		this._propagatingFromSet.delete(sourceConfigId);
	}

	private propagateImageBindings(
		imageConfigId: string,
		width: number,
		height: number,
	): void {
		for (const [configId, binding] of Object.entries(this.configBindings())) {
			if (
				binding.type === "imageWidth" &&
				binding.imageConfigId === imageConfigId
			) {
				this.setConfigValue(configId, width);
			} else if (
				binding.type === "imageHeight" &&
				binding.imageConfigId === imageConfigId
			) {
				this.setConfigValue(configId, height);
			}
		}
	}

	// ── Folders ───────────────────────────────────────────────────────────────

	enterFolder(folderId: number): void {
		if (this.galleryTab() === "input") {
			this.currentInputFolderId.set(folderId);
		} else {
			this.currentOutputFolderId.set(folderId);
		}
		this.gallerySelectMode.set(false);
		this.selectedAssetIds.set(new Set());
	}

	exitFolder(): void {
		if (this.galleryTab() === "input") {
			this.currentInputFolderId.set(null);
		} else {
			this.currentOutputFolderId.set(null);
		}
		this.gallerySelectMode.set(false);
		this.selectedAssetIds.set(new Set());
	}

	currentFolderId(): number | null {
		return this.galleryTab() === "input"
			? this.currentInputFolderId()
			: this.currentOutputFolderId();
	}

	currentFolderName(): string | null {
		const id = this.currentFolderId();
		if (id === null) return null;
		const folders =
			this.galleryTab() === "input" ? this.inputFolders() : this.outputFolders();
		return folders.find((f) => f.id === id)?.name ?? null;
	}

	async createFolder(): Promise<void> {
		const name = await this.dialog.prompt("New folder name:");
		if (!name?.trim()) return;

		const tab = this.galleryTab();
		const folder = await this.assetService.createFolder(name.trim(), tab);
		if (folder) {
			this.log(`Folder "<span class="warn">${folder.name}</span>" created.`);
		}
	}

	async renameFolder(folder: StoredFolder, event: MouseEvent): Promise<void> {
		event.stopPropagation();
		const name = await this.dialog.prompt("Rename folder:", {
			defaultValue: folder.name,
		});
		if (!name?.trim() || name.trim() === folder.name) return;

		await this.assetService.renameFolder(folder.id, name.trim());
		this.log(`Folder renamed to "<span class="warn">${name.trim()}</span>".`);
	}

	async deleteFolder(folder: StoredFolder, event: MouseEvent): Promise<void> {
		event.stopPropagation();

		const assetCount = this.assetService
			.assets$()
			.filter((a) => a.folderId === folder.id).length;

		const message =
			assetCount > 0
				? `Delete folder "<strong>${folder.name}</strong>" and its ${assetCount} image${assetCount > 1 ? "s" : ""}? This cannot be undone.`
				: `Delete folder "<strong>${folder.name}</strong>"? This cannot be undone.`;

		const confirmed = await this.dialog.confirm(message);
		if (!confirmed) return;

		// If we're currently inside this folder, exit first
		if (this.currentFolderId() === folder.id) this.exitFolder();

		await this.assetService.deleteFolder(folder.id);
		this.log(`Folder "<span class="warn">${folder.name}</span>" deleted.`);
	}

	openFolderContextMenu(ev: MouseEvent, folder: StoredFolder): void {
		ev.preventDefault();
		this.contextMenu.open(
			ev,
			[
				{
					label: "Rename",
					run: () => this.renameFolder(folder, ev),
				},
				{ divider: true },
				{
					label: "Delete Folder",
					run: () => this.deleteFolder(folder, ev),
				},
			],
			null,
		);
	}

	removeFromFolder(assetId: string): void {
		this.assetService.moveAssetToFolder(assetId, null);
	}

	onAssetDragStart(ev: DragEvent, asset: StoredImageAsset): void {
		const ids =
			this.gallerySelectMode() && this.selectedAssetIds().has(asset.id)
				? [...this.selectedAssetIds()]
				: [asset.id];
		ev.dataTransfer!.effectAllowed = "move";
		ev.dataTransfer!.setData("application/json", JSON.stringify(ids));
	}

	onFolderDragOver(ev: DragEvent): void {
		if (!ev.dataTransfer?.types.includes("application/json")) return;
		ev.preventDefault();
		ev.dataTransfer.dropEffect = "move";
	}

	onFolderDragEnter(ev: DragEvent, folder: StoredFolder): void {
		if (!ev.dataTransfer?.types.includes("application/json")) return;
		this.dragOverFolderId.set(folder.id);
	}

	onFolderDragLeave(ev: DragEvent, folder: StoredFolder): void {
		const related = ev.relatedTarget as Node | null;
		if (related && (ev.currentTarget as HTMLElement).contains(related)) return;
		if (this.dragOverFolderId() === folder.id) this.dragOverFolderId.set(null);
	}

	onFolderDrop(ev: DragEvent, folder: StoredFolder): void {
		ev.preventDefault();
		this.dragOverFolderId.set(null);
		const raw = ev.dataTransfer?.getData("application/json");
		if (!raw) return;
		const ids: string[] = JSON.parse(raw);
		for (const id of ids) {
			this.assetService.moveAssetToFolder(id, folder.id);
		}
	}

	buildMoveToFolderChildren(asset: StoredImageAsset): any[] {
		const tab = asset.type === "output" ? "output" : "input";
		const folders = tab === "input" ? this.inputFolders() : this.outputFolders();
		const items: any[] = [];

		if (asset.folderId != null) {
			items.push({
				label: "Remove from folder",
				run: () => this.assetService.moveAssetToFolder(asset.id, null),
			});
			items.push({ divider: true });
		}

		if (!folders.length) {
			items.push({ label: "No folders yet", disabled: true });
		} else {
			for (const folder of folders) {
				if (folder.id === asset.folderId) continue;
				items.push({
					label: folder.name,
					run: () => this.assetService.moveAssetToFolder(asset.id, folder.id),
				});
			}
		}

		return items;
	}

	private startTunnelStatusPoll(): void {
		this.fetchTunnelStatus();
		this.tunnelStatusTimer = setInterval(() => this.fetchTunnelStatus(), 3000);
	}

	private fetchTunnelStatus(): void {
		this.db.getTunnelStatus(this.bookId, this.tunnelEventCursor).subscribe({
			next: ({ connected, os, tunnelVersion, events }) => {
				if (connected && tunnelVersion) this.tunnelVersion.set(tunnelVersion);
				// Log new server-side events
				for (const e of events) {
					console.log(`[Tunnel] ${new Date(e.t).toISOString()} ${e.msg}`);
					this.log(`[Tunnel] ${e.msg}.`, 'muted');
					if (e.t > this.tunnelEventCursor) this.tunnelEventCursor = e.t;
				}

				// Log connection state transitions
				const prev = this.isConnectedToServer();
				if (connected !== prev) {
					this.isConnectedToServer.set(connected);
					if (connected) {
						console.log(`[Tunnel] Book ${this.bookId}: tunnel connected`);
						this.log('[Tunnel] <span class="success">Connected</span>.', 'muted');
						// Reset WS retry state and connect now that the tunnel is up
						this.wsRetryCount = 0;
						if (this.wsRetryTimer) { clearTimeout(this.wsRetryTimer); this.wsRetryTimer = null; }
						this.connectWS();
					} else {
						console.warn(`[Tunnel] Book ${this.bookId}: tunnel disconnected`);
						this.log('[Tunnel] Disconnected.', 'warn');
						// Close the WS so it doesn't keep retrying into a dead tunnel
						if (this.ws) { this.ws.close(); this.ws = null; }
						if (this.wsRetryTimer) { clearTimeout(this.wsRetryTimer); this.wsRetryTimer = null; }
						this.wsRetryCount = 0;
					}
				}
			},
			error: () => {
				/* non-critical — server unreachable */
			},
		});
	}

}
