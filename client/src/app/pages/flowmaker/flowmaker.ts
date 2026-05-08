import {
	Component,
	computed,
	HostListener,
	inject,
	Input,
	signal,
	WritableSignal,
} from "@angular/core";
import { Dialog } from "../../dialog";
import { CommonModule, NgTemplateOutlet } from "@angular/common";
import { AuthService } from "../../auth/auth.service";
import {
	BindingTarget,
	Configurable,
	FlowConfig,
	FlowTemplate,
	PromptTemplate,
} from "../../types/flow.type";
import { Router } from "@angular/router";
import { ComfyUIDatabaseService } from "../../comfyui/comfyui-database.service";
import {
	ComfyNodeDetectionService,
	DetectedConfigurable,
} from "../../comfyui/comfyui-node-detection.service";
import { HeaderComponent } from "../../header/header.component";
import { FooterComponent } from "../../footer/footer.component";

@Component({
	selector: "app-flow",
	imports: [CommonModule, NgTemplateOutlet, HeaderComponent, FooterComponent],
	templateUrl: "./flowmaker.html",
	styleUrl: "./flowmaker.scss",
})
export class FlowMaker {
	private dialog = inject(Dialog);
	private authService = inject(AuthService);
	private db = inject(ComfyUIDatabaseService);
	private detection = inject(ComfyNodeDetectionService);
	@Input("bookId") bookId!: string;
	@Input("flowId") flowId!: string;
	readonly router = inject(Router);

	step: WritableSignal<number> = signal(0);

	get updateMode(): boolean {
		return !!this.flowId;
	}

	static readonly NODE_TYPES: Record<
		string,
		{ type: Configurable["type"]; stable: boolean }
	> = {
		positivePrompt: { type: "core", stable: true },
		negativePrompt: { type: "core", stable: true },
		seed: { type: "core", stable: true },
		number: { type: "number", stable: false },
		finalImageWidth: { type: "finalImageWidth" as const, stable: true },
		finalImageHeight: { type: "finalImageHeight" as const, stable: true },
		text: { type: "text", stable: false },
		multilineText: { type: "multilineText", stable: false },
		preset: { type: "preset", stable: false },
		lora: { type: "lora", stable: false },
	};

	template: WritableSignal<FlowConfig> = signal({
		id: "",
		name: "",
		description: "",
		templates: [
			{
				id: "default",
				name: "Default",
				description: "",
				protected: false,
				promptTemplates: [
					{
						protected: false,
						positive: "",
						negative: "",
					},
				],
				changes: [],
			},
		],
		configurables: [],
		apiData: {},
	});

	selectedTemplateId = signal<string>("default");
	bindingPopoverFor = signal<string | null>(null);
	detectedConfigurables = signal<DetectedConfigurable[]>([]);

	numberConfigurables = computed(() =>
		this.template().configurables.filter((c) => c.type === "number"),
	);

	inputImageConfigurables = computed(() =>
		this.template().configurables.filter((c) => c.type === "inputImage"),
	);

	configurablesFrontEnd = computed(() => {
		const result: { id: string; name: string; configs: Configurable[] }[] = [];
		const apiData = this.template().apiData;
		const inputImageTargets = new Set(
			this.template().configurables.filter((c) => c.type === 'inputImage').map((c) => c.target),
		);

		for (const nodeId in apiData) {
			const data = apiData[nodeId];
			const configs: Configurable[] = [];

			if (!data.inputs) continue;

			for (const input in data.inputs) {
				const component = data.inputs[input];
				if (Array.isArray(component)) continue;

				const target = `/${nodeId}/inputs/${input}`;
				if (inputImageTargets.has(target)) continue;

				configs.push({
					target,
					name: input,
					visible: true,
					protected: false,
					type: "text",
					id: "",
				});
			}

			if (configs.length === 0) continue;

			result.push({
				id: nodeId,
				name: data._meta?.title ?? nodeId,
				configs,
			});
		}

		return result;
	});

	models: {
		loras: string[];
		checkpoints: string[];
		textEncoders: string[];
		diffusionModels: string[];
		clipVisions: string[];
		controlnets: string[];
		modelPatches: string[];
	} = {
		loras: [],
		checkpoints: [],
		textEncoders: [],
		diffusionModels: [],
		clipVisions: [],
		controlnets: [],
		modelPatches: [],
	};

	nonCoreConfigurables = computed(() =>
		this.template().configurables.filter((c) => c.type !== "core" && c.type !== "inputImage" && c.type !== "lora"),
	);

	selectedTemplate = computed(
		() =>
			this.template().templates.find((t) => t.id === this.selectedTemplateId()) ??
			this.template().templates[0],
	);

	ngOnInit(): void {
		if (!this.authService.isLoggedIn()) {
			this.router.navigate(["/login"]);
			return;
		}

		if (!this.bookId) {
			this.dialog.alert("Missing book ID in route.");
			return;
		}

		this.db.getBookServerId(this.bookId).subscribe({
			next: (serverId) => {
				if (serverId) this.loadModelsFromTunnel(serverId);
				else this.loadModelsFromComfyUI();
			},
			error: () => this.loadModelsFromComfyUI(),
		});

		if (this.flowId) {
			this.db.getFlow(this.bookId, this.flowId).subscribe({
				next: (flow) => {
					this.template.set(flow);
					this.completeStep(0);
				},
				error: (err) => {
					console.error("Error loading flow:", err);
					this.dialog.alert("An error occurred while loading the flow.");
				},
			});
		}
	}

	// ── Bindings ─────────────────────────────────────────────────────────────

	getBinding(configId: string): BindingTarget | undefined {
		return this.template().bindings?.[configId];
	}

	getBindingLabel(configId: string): string {
		const binding = this.template().bindings?.[configId];
		if (!binding) return "";
		if (binding.type === "configurable") {
			const cfg = this.template().configurables.find(
				(c) => c.id === binding.configId,
			);
			return cfg?.name ?? binding.configId;
		}
		const cfg = this.template().configurables.find(
			(c) => c.id === binding.imageConfigId,
		);
		const dim = binding.type === "imageWidth" ? "Width" : "Height";
		return `${cfg?.name ?? binding.imageConfigId} → ${dim}`;
	}

	getBindableTargets(excludeConfigId: string): Configurable[] {
		return this.numberConfigurables().filter((c) => c.id !== excludeConfigId);
	}

	setBinding(configId: string, target: BindingTarget): void {
		this.template.update((t) => ({
			...t,
			bindings: { ...(t.bindings ?? {}), [configId]: target },
		}));
		this.bindingPopoverFor.set(null);
	}

	clearBinding(configId: string): void {
		this.template.update((t) => {
			if (!t.bindings?.[configId]) return t;
			const next = { ...t.bindings };
			delete next[configId];
			return { ...t, bindings: next };
		});
	}

	toggleBindingPopover(configId: string, event: MouseEvent): void {
		event.stopPropagation();
		this.bindingPopoverFor.update((curr) =>
			curr === configId ? null : configId,
		);
	}

	@HostListener("document:click", ["$event"])
	onDocumentClick(event: MouseEvent): void {
		if (!(event.target as HTMLElement).closest(".bind-container")) {
			this.bindingPopoverFor.set(null);
		}
	}

	@HostListener("document:keydown.escape")
	onEscape(): void {
		if (this.bindingPopoverFor()) {
			this.bindingPopoverFor.set(null);
		}
	}

	async logOut() {
		let confirm = await this.dialog.confirm("Are you sure you want to log out?");
		if (confirm) {
			this.authService.logout();
		}
	}

	isJSON(str: string): boolean {
		try {
			JSON.parse(str);
			return true;
		} catch {
			return false;
		}
	}

	onJSONInput(event: Event) {
		const target = event.target as HTMLTextAreaElement;
		if (!this.isJSON(target.value)) return;
		this.template.update((t) => ({
			...t,
			apiData: JSON.parse(target.value),
		}));
	}

	completeStep(step: number) {
		if (step === 0) {
			if (this.updateMode) {
				// Existing flow — skip auto-detection entirely because configurables are
				// already defined from the stored flow_data. Jump directly to the manual
				// configuration step (2) so the user can review and adjust existing settings.
				this.step.set(2);
			} else {
				// New flow — run the detection algorithm against the pasted API JSON,
				// populate detectedConfigurables, then advance to the review step (1).
				const detected = this.detection.detectConfigurables(
					this.template().apiData,
				);
				this.detectedConfigurables.set(detected);
				this.step.set(1);
			}
		} else if (step === 1) {
			// Convert every accepted DetectedConfigurable into a full Configurable and
			// write them into the template, replacing any prior content. Then advance to
			// the manual configuration step (2) for fine-tuning and type assignment.
			const newConfigurables: Configurable[] = this.detectedConfigurables()
				.filter((d) => d.accepted)
				.map((d) => ({
					id: d.id,
					name: d.name,
					target: d.target,
					type: d.type,
					visible: true,
					protected: false,
				}));
			this.template.update((t) => ({ ...t, configurables: newConfigurables }));
			this.step.set(2);
		} else if (step === 2) {
			// Validate that all required configurables exist before advancing to
			// template setup.
			const ids = new Set(this.template().configurables.map((c) => c.id));
			const configurables = this.template().configurables;
			const errors: string[] = [];
			if (!ids.has("positivePrompt")) errors.push("<strong>Positive Prompt</strong> is missing.");
			if (!ids.has("seed")) errors.push("<strong>Noise Seed</strong> is missing.");
			const widthCfgs = configurables.filter((c) => c.type === "finalImageWidth");
			const heightCfgs = configurables.filter((c) => c.type === "finalImageHeight");
			if (widthCfgs.length === 0) errors.push("<strong>Final Image Width</strong> is missing.");
			else if (widthCfgs.length > 1) errors.push(`<strong>Final Image Width</strong> must appear exactly once (found ${widthCfgs.length}).`);
			if (heightCfgs.length === 0) errors.push("<strong>Final Image Height</strong> is missing.");
			else if (heightCfgs.length > 1) errors.push(`<strong>Final Image Height</strong> must appear exactly once (found ${heightCfgs.length}).`);
			if (errors.length > 0) {
				this.dialog.alert(errors.join("<br>"));
				return;
			}
			this.step.set(3);
		}
	}

	previousStep(currentStep: number) {
		if (currentStep === 2) {
			// Re-run detection on the current API JSON before showing Step 1,
			// so the list is always populated — even in update mode where
			// detection was bypassed on initial entry.
			const detected = this.detection.detectConfigurables(this.template().apiData);
			// Restore the accepted state for any item whose target is already
			// present in the configurables list (the user exposed it in Step 2).
			const existingTargets = new Set(
				this.template()
					.configurables.map((c) => c.target)
					.filter(Boolean),
			);
			this.detectedConfigurables.set(
				detected.map((d) => ({
					...d,
					accepted: d.required || existingTargets.has(d.target),
				})),
			);
		}
		this.step.set(currentStep - 1);
	}

	updateFlowName(name: string) {
		this.template.update((t) => ({
			...t,
			name,
			id: this.toIdString(name, true),
		}));
	}

	updateFlowDescription(description: string) {
		this.template.update((t) => ({ ...t, description }));
	}

	getConfigurable(target: string): Configurable | undefined {
		return this.template().configurables.find((c) => c.target === target);
	}

	isChecked(target: string): boolean {
		return !!this.getConfigurable(target);
	}

	isVisible(target: string): boolean {
		return this.getConfigurable(target)?.visible ?? true;
	}

	isProtected(target: string): boolean {
		return this.getConfigurable(target)?.protected ?? false;
	}

	getType(target: string): string {
		return this.getConfigurable(target)?.type ?? "text";
	}

	getPresets(target: string): string {
		return (this.getConfigurable(target)?.presets ?? []).join("\n");
	}

	getSelectValue(target: string): string {
		const c = this.getConfigurable(target);
		if (!c) return "text";

		if (c.selectValue) return c.selectValue;

		const stableMatch = Object.entries(FlowMaker.NODE_TYPES).find(
			([key, cfg]) => cfg.stable && key === c.id,
		);
		if (stableMatch) return stableMatch[0];

		const nonStableMatch = Object.entries(FlowMaker.NODE_TYPES).find(
			([_, cfg]) => !cfg.stable && cfg.type === c.type,
		);
		return nonStableMatch?.[0] ?? "text";
	}

	updateConfigurable(target: string, changes: Partial<Configurable> | null) {
		this.template.update((t) => {
			const exists = t.configurables.some((c) => c.target === target);

			if (changes === null) {
				return {
					...t,
					configurables: t.configurables.filter((c) => c.target !== target),
				};
			}

			if (exists) {
				return {
					...t,
					configurables: t.configurables.map((c) =>
						c.target === target ? { ...c, ...changes } : c,
					),
				};
			}

			const newConfigurable: Configurable = {
				id: this.toIdString(changes.name ?? target),
				target,
				name: this.toFriendlyName(changes.name ?? target),
				visible: true,
				type: "text",
				protected: false,
				...changes,
			};
			return { ...t, configurables: [...t.configurables, newConfigurable] };
		});
	}

	onCheckboxChange(node: Configurable, checked: boolean) {
		if (checked) {
			// If this target was auto-detected, seed the new configurable with
			// the detected name, type, and id so the user doesn't have to
			// re-enter information the detection already knows.
			const detected = this.detectedConfigurables().find(
				(d) => d.target === node.target,
			);
			if (detected) {
				this.updateConfigurable(node.target!, {
					name: detected.name,
					type: detected.type,
					id: detected.id,
				});
			} else {
				this.updateConfigurable(node.target!, {
					name: this.toFriendlyName(node.name),
				});
			}
		} else {
			this.updateConfigurable(node.target!, null);
		}
	}

	toggleVisible(target: string) {
		const current = this.getConfigurable(target);
		this.updateConfigurable(target, { visible: !current?.visible });
	}

	toggleProtected(target: string) {
		const current = this.getConfigurable(target);
		this.updateConfigurable(target, { protected: !current?.protected });
	}

	private static readonly REQUIRED_IDS = new Set([
		'positivePrompt', 'seed', 'finalImageWidth', 'finalImageHeight',
	]);

	isRequiredConfigurable(target: string): boolean {
		const id = this.getConfigurable(target)?.id;
		return !!id && FlowMaker.REQUIRED_IDS.has(id);
	}

	/** Targets whose type select has been manually unlocked by the user. */
	unlockedTargets = signal<Set<string>>(new Set());

	isLocked(target: string): boolean {
		if (this.unlockedTargets().has(target)) return false;
		return this.isRequiredConfigurable(target) || this.getType(target) === 'lora';
	}

	isPermanentlyLocked(target: string): boolean {
		const id = this.getConfigurable(target)?.id;
		return id === 'positivePrompt' || id === 'seed';
	}

	toggleUnlock(target: string): void {
		this.unlockedTargets.update((set) => {
			const next = new Set(set);
			if (next.has(target)) next.delete(target);
			else next.add(target);
			return next;
		});
	}

	assignNodeType(node: Configurable, selectValue: string) {
		const config = FlowMaker.NODE_TYPES[selectValue] ?? {
			type: "text" as const,
			stable: false,
		};

		const resolvedId = config.stable
			? selectValue
			: this.toIdString(selectValue + "_" + node.target, true);

		const current = this.getConfigurable(node.target!);

		// Clear stale binding when switching away from a bindable type
		const bindableTypes = ["number", "finalImageWidth", "finalImageHeight"];
		const wasBindable = bindableTypes.includes(this.getType(node.target!));
		const isBindable = bindableTypes.includes(config.type);
		if (wasBindable && !isBindable && current) {
			this.clearBinding(current.id);
		}

		this.updateConfigurable(node.target!, {
			type: config.type,
			id: resolvedId,
			selectValue,
			presets: config.type === "preset" ? (current?.presets ?? []) : undefined,
		});
	}

	onPresetsInput(target: string, value: string) {
		const presets = value
			.split("\n")
			.map((p) => p.trim())
			.filter(Boolean);
		this.updateConfigurable(target, { presets });
	}

	presetDialogTarget = signal<string | null>(null);
	loraPicker = signal<{ items: string[]; selected: Set<string> } | null>(null);
	loraPickerDirect = signal<boolean>(false);

	openPresetDialog(target: string) {
		this.presetDialogTarget.set(target);
		this.loraPicker.set(null);
		this.loraPickerDirect.set(false);
	}

	/** Opens the LoRA picker directly for lora-type configurables in step 2. */
	openLoraPresetPicker(target: string) {
		this.presetDialogTarget.set(target);
		this.loraPickerDirect.set(true);
		const existing = new Set(this.getConfigurable(target)?.presets ?? []);
		const all = this.models.loras.filter((p) => p.includes('.'));
		this.loraPicker.set({ items: all, selected: existing.size ? existing : new Set(all) });
	}

	closePresetDialog() {
		this.presetDialogTarget.set(null);
		this.loraPicker.set(null);
		this.loraPickerDirect.set(false);
	}

	openLoraPicker() {
		const all = this.models.loras.filter((p) => p.includes('.'));
		this.loraPicker.set({ items: all, selected: new Set(all) });
	}

	closeLoraPicker() {
		if (this.loraPickerDirect()) {
			this.closePresetDialog();
		} else {
			this.loraPicker.set(null);
		}
	}

	toggleLoraSelection(item: string) {
		this.loraPicker.update((p) => {
			if (!p) return p;
			const next = new Set(p.selected);
			if (next.has(item)) next.delete(item);
			else next.add(item);
			return { ...p, selected: next };
		});
	}

	setAllLoraSelections(selected: boolean) {
		this.loraPicker.update((p) => {
			if (!p) return p;
			return { ...p, selected: selected ? new Set(p.items) : new Set() };
		});
	}

	insertSelectedLoras() {
		const target = this.presetDialogTarget();
		const picker = this.loraPicker();
		if (!target || !picker) return;
		const items = picker.items.filter((i) => picker.selected.has(i));
		this.updateConfigurable(target, { presets: items });
		this.closePresetDialog();
	}

	insertPresets(items: string[]) {
		const target = this.presetDialogTarget();
		if (!target) return;
		this.updateConfigurable(target, { presets: items });
		this.closePresetDialog();
	}

	updateTemplate(templateId: string, changes: Partial<FlowTemplate>) {
		this.template.update((t) => ({
			...t,
			templates: t.templates.map((tmpl) =>
				tmpl.id === templateId ? { ...tmpl, ...changes } : tmpl,
			),
		}));
	}

	addTemplate() {
		const newTemplate: FlowTemplate = {
			id: this.toIdString("template"),
			name: "New Template",
			description: "",
			protected: false,
			promptTemplates: [{ protected: false, positive: "", negative: "" }],
			changes: [],
		};
		this.template.update((t) => ({
			...t,
			templates: [...t.templates, newTemplate],
		}));
		this.selectedTemplateId.set(newTemplate.id);
	}

	deleteTemplate(templateId: string) {
		this.template.update((t) => ({
			...t,
			templates: t.templates.filter((tmpl) => tmpl.id !== templateId),
		}));
		if (this.selectedTemplateId() === templateId) {
			this.selectedTemplateId.set("default");
		}
	}

	addPromptTemplate(templateId: string) {
		this.template.update((t) => ({
			...t,
			templates: t.templates.map((tmpl) =>
				tmpl.id !== templateId
					? tmpl
					: {
							...tmpl,
							promptTemplates: [
								...tmpl.promptTemplates,
								{ protected: false, positive: "", negative: "" },
							],
						},
			),
		}));
	}

	removePromptTemplate(templateId: string, index: number) {
		this.template.update((t) => ({
			...t,
			templates: t.templates.map((tmpl) =>
				tmpl.id !== templateId
					? tmpl
					: {
							...tmpl,
							promptTemplates: tmpl.promptTemplates.filter((_, i) => i !== index),
						},
			),
		}));
	}

	updatePromptTemplate(
		templateId: string,
		index: number,
		changes: Partial<PromptTemplate>,
	) {
		this.template.update((t) => ({
			...t,
			templates: t.templates.map((tmpl) =>
				tmpl.id !== templateId
					? tmpl
					: {
							...tmpl,
							promptTemplates: tmpl.promptTemplates.map((pt, i) =>
								i === index ? { ...pt, ...changes } : pt,
							),
						},
			),
		}));
	}

	collapsedPrompts = signal<Set<string>>(new Set());

	togglePromptCollapse(templateId: string, index: number) {
		const key = `${templateId}-${index}`;
		this.collapsedPrompts.update((set) => {
			const next = new Set(set);
			next.has(key) ? next.delete(key) : next.add(key);
			return next;
		});
	}

	isPromptCollapsed(templateId: string, index: number): boolean {
		return this.collapsedPrompts().has(`${templateId}-${index}`);
	}

	isTemplateProtected(templateId: string): boolean {
		return (
			this.template().templates.find((t) => t.id === templateId)?.protected ??
			false
		);
	}

	toggleTemplateProtected(templateId: string): void {
		this.updateTemplate(templateId, {
			protected: !this.isTemplateProtected(templateId),
		});
	}

	isPromptProtected(templateId: string, index: number): boolean {
		return (
			this.template().templates.find((t) => t.id === templateId)?.promptTemplates[
				index
			]?.protected ?? false
		);
	}

	togglePromptProtected(templateId: string, index: number): void {
		this.updatePromptTemplate(templateId, index, {
			protected: !this.isPromptProtected(templateId, index),
		});
	}

	getChange(templateId: string, configId: string): string {
		const tmpl = this.template().templates.find((t) => t.id === templateId);
		return tmpl?.changes.find((c) => c.configId === configId)?.value ?? "";
	}

	hasChange(templateId: string, configId: string): boolean {
		const tmpl = this.template().templates.find((t) => t.id === templateId);
		return !!tmpl?.changes.find((c) => c.configId === configId);
	}

	setChange(templateId: string, configId: string, value: string) {
		this.template.update((t) => ({
			...t,
			templates: t.templates.map((tmpl) => {
				if (tmpl.id !== templateId) return tmpl;
				const exists = tmpl.changes.some((c) => c.configId === configId);
				const changes = exists
					? tmpl.changes.map((c) => (c.configId === configId ? { ...c, value } : c))
					: [...tmpl.changes, { configId, value }];
				return { ...tmpl, changes };
			}),
		}));
	}

	removeChange(templateId: string, configId: string) {
		this.template.update((t) => ({
			...t,
			templates: t.templates.map((tmpl) =>
				tmpl.id !== templateId
					? tmpl
					: {
							...tmpl,
							changes: tmpl.changes.filter((c) => c.configId !== configId),
						},
			),
		}));
	}

	toggleChange(templateId: string, configId: string, include: boolean) {
		if (include) {
			const cfg = this.template().configurables.find((c) => c.id === configId);
			const defaultValue = cfg?.type === 'preset' ? (cfg.presets?.[0] ?? '') : '';
			this.setChange(templateId, configId, defaultValue);
		} else {
			this.removeChange(templateId, configId);
		}
	}

	private loadModelsFromTunnel(serverId: string): void {
		const tunnelPaths: { key: keyof FlowMaker['models']; path: string }[] = [
			{ key: 'loras', path: 'loras' },
			{ key: 'checkpoints', path: 'checkpoints' },
			{ key: 'textEncoders', path: 'text_encoders' },
			{ key: 'diffusionModels', path: 'diffusion_models' },
			{ key: 'clipVisions', path: 'clip' },
			{ key: 'controlnets', path: 'controlnet' },
			{ key: 'modelPatches', path: 'model_patches' },
		];
		for (const { key, path } of tunnelPaths) {
			this.db.listFiles(serverId, path, true).subscribe({
				next: (entries) => {
					this.models[key] = entries
						.filter((e) => e.type === 'file')
						.map((e) => e.path.replace(/\\/g, '/'));
				},
				error: () => {},
			});
		}
	}

	private loadModelsFromComfyUI(): void {
		this.db.getModelList(this.bookId, 'loras').subscribe((list) => (this.models.loras = list));
		this.db.getModelList(this.bookId, 'checkpoints').subscribe((list) => (this.models.checkpoints = list));
		this.db.getModelList(this.bookId, 'text_encoders').subscribe((list) => (this.models.textEncoders = list));
		this.db.getModelList(this.bookId, 'diffusion_models').subscribe((list) => (this.models.diffusionModels = list));
		this.db.getModelList(this.bookId, 'clip_vision').subscribe((list) => (this.models.clipVisions = list));
		this.db.getModelList(this.bookId, 'controlnet').subscribe((list) => (this.models.controlnets = list));
		this.db.getModelList(this.bookId, 'model_patches').subscribe((list) => (this.models.modelPatches = list));
	}

	finalize() {
		if (!this.validateDefaultTemplate()) return;
		console.log(this.template());
		if (this.updateMode) {
			console.log("Updating...");
			this.updateFlow();
		} else {
			console.log("Creating...");
			this.createFlow();
		}
	}

	validateDefaultTemplate(): boolean {
		const defaultTmpl = this.template().templates.find((t) => t.id === "default");
		if (!defaultTmpl) return true;

		const missing: string[] = [];

		for (const config of this.nonCoreConfigurables()) {
			if (config.type === "inputImage" || config.type === "lora") continue;

			const change = defaultTmpl.changes.find((c) => c.configId === config.id);
			if (!change || !change.value?.trim()) {
				missing.push(config.name);
			}
		}

		if (missing.length > 0) {
			this.dialog.alert(
				`The following fields in the <strong>Default</strong> template must be filled in before saving:<br><br>` +
					missing.map((n) => `&bull; ${n}`).join("<br>"),
			);
			return false;
		}

		return true;
	}

	private buildConfigSummaryHtml(): string {
		const TYPE_LABELS: Record<string, string> = {
			core: 'Core',
			text: 'Text',
			multilineText: 'Multiline Text',
			number: 'Number',
			width: 'Width',
			height: 'Height',
			finalImageWidth: 'Final Image Width',
			finalImageHeight: 'Final Image Height',
			preset: 'Preset',
			lora: 'LoRA',
			inputImage: 'Input Image',
		};
		const REQUIRED_TYPES = new Set(['finalImageWidth', 'finalImageHeight', 'inputImage', 'core']);
		const headerStyle = 'padding:8px 32px 8px 0;opacity:0.5;font-weight:600;font-size:0.85em;text-align:left;border-bottom:1px solid rgba(128,128,128,0.3)';
		const cellStyle = 'padding:8px 32px 8px 0';
		const header = `<tr>
			<td style="${headerStyle}">Label</td>
			<td style="${headerStyle}">Node Type</td>
			<td style="${headerStyle}">Required</td>
		</tr>`;
		const rows = this.template().configurables
			.map((c) => {
				const label = TYPE_LABELS[c.type] ?? c.type;
				const required = REQUIRED_TYPES.has(c.type) || c.id === 'positivePrompt' || c.id === 'seed'
					? '✓'
					: '✗';
				return `<tr>
					<td style="${cellStyle}">${c.name}</td>
					<td style="${cellStyle};opacity:0.6">${label}</td>
					<td style="${cellStyle}">${required}</td>
				</tr>`;
			})
			.join('');
		return `<table style="margin-top:10px;border-collapse:collapse">${header}${rows}</table>`;
	}

	private cleanedTemplate(): FlowConfig {
		const t = this.template();
		return {
			...t,
			templates: t.templates.map((tmpl) => ({
				...tmpl,
				changes: tmpl.changes.filter((ch) => {
					if (ch.value == null) return false;
					if (ch.value.trim() !== '') return true;
					// Empty string is valid for LoRA — it means "None"
					return t.configurables.find((c) => c.id === ch.configId)?.type === 'lora';
				}),
			})),
		};
	}

	async updateFlow() {
		console.log('[updateFlow] configurables:', JSON.parse(JSON.stringify(this.template().configurables)));
		const confirm = await this.dialog.confirm(
			`Are you sure you want to update this flow?<br><br><strong>Exposed configurations:</strong>${this.buildConfigSummaryHtml()}`,
		);
		if (!confirm) return;

		this.db.updateFlow(this.bookId, this.flowId, this.cleanedTemplate()).subscribe({
			next: () => {
				this.dialog.alert(
					`Flow updated successfully!<br><br><a href='/books/${this.bookId}' class='link'>→ Open Book</a><br><a href='/books' class='link'>← Back to Books</a>`,
				);
			},
			error: (err) => {
				console.error("Error updating flow:", err);
				this.dialog.alert("An error occurred while updating the flow.");
			},
		});
	}

	async createFlow() {
		console.log('[createFlow] configurables:', JSON.parse(JSON.stringify(this.template().configurables)));
		const confirm = await this.dialog.confirm(
			`Are you sure you want to save this flow to this book?<br><br><strong>Exposed configurations:</strong>${this.buildConfigSummaryHtml()}`,
		);
		if (!confirm) return;

		this.db.createFlow(this.bookId, this.cleanedTemplate()).subscribe({
			next: () => {
				this.dialog.alert(
					`Flow created successfully! You can view it here: <a href='/books/${this.bookId}' class='link'>/books/${this.bookId}</a>`,
				);
			},
			error: (err) => {
				console.error("Error creating flow:", err);
				this.dialog.alert("An error occurred while creating the flow.");
			},
		});
	}

	toIdString(str: string, stable = false): string {
		const base = str
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, "")
			.split(/\s+/)
			.map((word, index) =>
				index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1),
			)
			.join("");

		return stable ? base : `${base}_${Math.random().toString(36).slice(2)}`;
	}

	toFriendlyName(str: string): string {
		return str
			.replace(/[_-]/g, " ")
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.replace(/\b\w/g, (c) => c.toUpperCase());
	}

	// ── Auto-detection review (Step 1) ────────────────────────────────────────

	toggleDetected(id: string): void {
		// Flip the accepted flag for the matching DetectedConfigurable. Required
		// items (positivePrompt and seed) may not be toggled — their checkbox is
		// disabled in the template, but we guard here as well for safety.
		this.detectedConfigurables.update((items) =>
			items.map((item) =>
				item.id === id && !item.required
					? { ...item, accepted: !item.accepted }
					: item,
			),
		);
	}

	dismissDetected(id: string): void {
		// Remove a detected item entirely from the review list. The user has
		// indicated the detection is wrong or they prefer to wire this field
		// up themselves in the manual configuration step. Required items are
		// guarded and cannot be dismissed.
		this.detectedConfigurables.update((items) =>
			items.filter((item) => item.id !== id),
		);
	}
}
