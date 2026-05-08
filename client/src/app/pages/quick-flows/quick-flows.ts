import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import {
	ComfyUIDatabaseService,
	QuickFlowGroup,
	QuickFlowGroupWithFlows,
	QuickFlow,
	AskOnRunParam,
} from '../../comfyui/comfyui-database.service';
import { type TemplateVar, parsePromptTemplate } from '../../utils/prompt-template';
import { ComfyNodeDetectionService } from '../../comfyui/comfyui-node-detection.service';
import { HeaderComponent } from '../../header/header.component';
import { FooterComponent } from '../../footer/footer.component';
import { Dialog } from '../../dialog';
import { firstValueFrom } from 'rxjs';
import { ActiveBookService } from '../../active-book.service';
import {
	isWorkflowFormat,
	convertWorkflowWithSubgraphsToApi,
} from '../../comfyui/workflow-converter';

interface NodeFieldEntry {
	nodeId: string;
	nodeTitle: string;
	field: string;
	value: string | number;
	type: 'text' | 'number';
}

interface FlowDraft {
	name: string;
	api_data: string;
	image_node_id: string;
	seed_node_id: string;
	positive_prompt_node_id: string;
	positive_prompt_value: string;
	detectedNodes: Array<{ id: string; title: string }>;
	detectedSeedNodes: Array<{ id: string; title: string }>;
	detectedPromptNodes: Array<{ id: string; title: string }>;
	detectedNodeFields: NodeFieldEntry[];
	ask_on_run: AskOnRunParam[];
	askOnRunExpanded: boolean;
	error: string;
}

const EMPTY_DRAFT: FlowDraft = {
	name: '',
	api_data: '',
	image_node_id: '',
	seed_node_id: '',
	positive_prompt_node_id: '',
	positive_prompt_value: '',
	detectedNodes: [],
	detectedSeedNodes: [],
	detectedPromptNodes: [],
	detectedNodeFields: [],
	ask_on_run: [],
	askOnRunExpanded: false,
	error: '',
};

@Component({
	selector: 'app-quick-flows',
	standalone: true,
	imports: [CommonModule, HeaderComponent, FooterComponent],
	templateUrl: './quick-flows.html',
	styleUrl: './quick-flows.scss',
})
export class QuickFlowsPage implements OnInit {
	private readonly db = inject(ComfyUIDatabaseService);
	private readonly dialog = inject(Dialog);
	private readonly router = inject(Router);
	private readonly detectionSvc = inject(ComfyNodeDetectionService);
	private readonly activeBookSvc = inject(ActiveBookService);

	groups = signal<QuickFlowGroupWithFlows[]>([]);
	loading = signal(true);

	expandedGroupIds = signal<Set<number>>(new Set());
	addFlowDrafts = signal<Record<number, FlowDraft>>({});
	editFlowDraft = signal<{ flowId: number; groupId: number; draft: FlowDraft } | null>(null);
	renamingGroupId = signal<number | null>(null);
	renameGroupName = signal('');

	ngOnInit(): void {
		this.load();
	}

	private async load(): Promise<void> {
		this.loading.set(true);
		try {
			const groups = await firstValueFrom(this.db.getQuickFlows());
			this.groups.set(groups);
			this.expandedGroupIds.set(new Set(groups.map((g) => g.id)));
		} catch {
			await this.dialog.alert('Failed to load quick flows.');
		} finally {
			this.loading.set(false);
		}
	}

	goToBooks(): void {
		this.router.navigate(['/books']);
	}

	// ── JSON helpers ───────────────────────────────────────────────────────────

	private parseJson<T>(json: string | null | undefined, fallback: T): T {
		if (!json) return fallback;
		try { return JSON.parse(json) as T; } catch { return fallback; }
	}

	// ── Prompt text helpers ─────────────────────────────────────────────────────

	private readPromptText(apiDataJson: string, nodeId: string): string {
		try {
			const api = JSON.parse(apiDataJson);
			const inputs = api[nodeId]?.inputs ?? {};
			for (const value of Object.values(inputs)) {
				if (typeof value === 'string') return value as string;
			}
		} catch {}
		return '';
	}

	private writePromptText(apiDataJson: string, nodeId: string, value: string): string {
		try {
			const api = JSON.parse(apiDataJson);
			const inputs = api[nodeId]?.inputs ?? {};
			for (const field of Object.keys(inputs)) {
				if (typeof inputs[field] === 'string') {
					inputs[field] = value;
					return JSON.stringify(api, null, 2);
				}
			}
		} catch {}
		return apiDataJson;
	}

	// ── Group expansion ────────────────────────────────────────────────────────

	toggleGroup(groupId: number): void {
		this.expandedGroupIds.update((set) => {
			const next = new Set(set);
			next.has(groupId) ? next.delete(groupId) : next.add(groupId);
			return next;
		});
	}

	isExpanded(groupId: number): boolean {
		return this.expandedGroupIds().has(groupId);
	}

	// ── Groups CRUD ────────────────────────────────────────────────────────────

	async createGroup(): Promise<void> {
		const name = await this.dialog.prompt('Group name:');
		if (!name?.trim()) return;
		try {
			const group = await firstValueFrom(this.db.createQuickFlowGroup(name.trim()));
			this.groups.update((gs) => [...gs, { ...group, flows: [] }]);
			this.expandedGroupIds.update((set) => new Set([...set, group.id]));
		} catch {
			await this.dialog.alert('Failed to create group.');
		}
	}

	startRenameGroup(group: QuickFlowGroup): void {
		this.renamingGroupId.set(group.id);
		this.renameGroupName.set(group.name);
	}

	cancelRenameGroup(): void {
		this.renamingGroupId.set(null);
	}

	async saveRenameGroup(group: QuickFlowGroup): Promise<void> {
		const name = this.renameGroupName().trim();
		if (!name || name === group.name) {
			this.renamingGroupId.set(null);
			return;
		}
		try {
			const updated = await firstValueFrom(this.db.renameQuickFlowGroup(group.id, name));
			this.groups.update((gs) => gs.map((g) => (g.id === group.id ? { ...g, name: updated.name } : g)));
			this.renamingGroupId.set(null);
		} catch {
			await this.dialog.alert('Failed to rename group.');
		}
	}

	async deleteGroup(group: QuickFlowGroupWithFlows): Promise<void> {
		const count = group.flows.length;
		const msg =
			count > 0
				? `Delete group "<strong>${group.name}</strong>" and ungroup its ${count} flow${count > 1 ? 's' : ''}? The flows will not be deleted.`
				: `Delete group "<strong>${group.name}</strong>"?`;
		const confirmed = await this.dialog.confirm(msg);
		if (!confirmed) return;
		try {
			await firstValueFrom(this.db.deleteQuickFlowGroup(group.id));
			this.groups.update((gs) => gs.filter((g) => g.id !== group.id));
		} catch {
			await this.dialog.alert('Failed to delete group.');
		}
	}

	// ── Add flow ───────────────────────────────────────────────────────────────

	startAddFlow(groupId: number): void {
		this.addFlowDrafts.update((d) => ({ ...d, [groupId]: { ...EMPTY_DRAFT } }));
	}

	cancelAddFlow(groupId: number): void {
		this.addFlowDrafts.update((d) => {
			const next = { ...d };
			delete next[groupId];
			return next;
		});
	}

	getDraft(groupId: number): FlowDraft | null {
		return this.addFlowDrafts()[groupId] ?? null;
	}

	patchDraft(groupId: number, patch: Partial<FlowDraft>): void {
		this.addFlowDrafts.update((d) => ({
			...d,
			[groupId]: { ...(d[groupId] ?? { ...EMPTY_DRAFT }), ...patch },
		}));
	}

	/** Detects workflow vs API format and converts if needed. Returns resolved API JSON string. */
	private async resolveApiData(raw: string): Promise<{ apiRaw: string; error?: string }> {
		try {
			const parsed = JSON.parse(raw);
			if (!isWorkflowFormat(parsed)) return { apiRaw: raw };

			const bookId = this.activeBookSvc.activeBook()?.id;
			if (!bookId) return { apiRaw: raw, error: 'No active book — cannot convert workflow JSON. Open a book first or paste API format JSON.' };

			const objectInfo = await firstValueFrom(this.db.getObjectInfo(bookId));
			const apiData = convertWorkflowWithSubgraphsToApi(parsed, objectInfo);
			return { apiRaw: JSON.stringify(apiData, null, 2) };
		} catch {
			return { apiRaw: raw };
		}
	}

	async onDraftApiDataChange(groupId: number, raw: string): Promise<void> {
		if (!raw.trim()) {
			this.patchDraft(groupId, { ...EMPTY_DRAFT, name: this.getDraft(groupId)?.name ?? '' });
			return;
		}
		const { apiRaw, error } = await this.resolveApiData(raw);
		if (error) { this.patchDraft(groupId, { api_data: raw, error }); return; }

		const imageNodes = this.detectionSvc.scanImageNodes(apiRaw);
		const seedNodes = this.detectionSvc.scanSeedNodes(apiRaw);
		const promptNodes = this.detectionSvc.scanPromptNodes(apiRaw);
		const nodeFields = this.detectionSvc.scanNodeFields(apiRaw);
		const detected = this.detectionSvc.detectQuickFlowNodes(apiRaw);

		const promptNodeId = detected.positivePromptNodeId ?? (promptNodes.length === 1 ? promptNodes[0].id : '');
		this.patchDraft(groupId, {
			api_data: apiRaw,
			detectedNodes: imageNodes,
			detectedSeedNodes: seedNodes,
			detectedPromptNodes: promptNodes,
			detectedNodeFields: nodeFields,
			image_node_id: detected.imageNodeId ?? (imageNodes.length >= 1 ? imageNodes[0].id : ''),
			seed_node_id: detected.seedNodeId ?? (seedNodes.length === 1 ? seedNodes[0].id : ''),
			positive_prompt_node_id: promptNodeId,
			positive_prompt_value: promptNodeId ? this.readPromptText(apiRaw, promptNodeId) : '',
			error: detected.error ?? '',
		});
	}

	onAddJsonFileUpload(groupId: number, file: File): void {
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => this.onDraftApiDataChange(groupId, reader.result as string);
		reader.readAsText(file);
	}

	onDraftPromptNodeChange(groupId: number, nodeId: string): void {
		const draft = this.getDraft(groupId);
		if (!draft) return;
		this.patchDraft(groupId, {
			positive_prompt_node_id: nodeId,
			positive_prompt_value: nodeId ? this.readPromptText(draft.api_data, nodeId) : '',
		});
	}

	onDraftPromptValueChange(groupId: number, value: string): void {
		const draft = this.getDraft(groupId);
		if (!draft) return;
		const newApiData = draft.positive_prompt_node_id
			? this.writePromptText(draft.api_data, draft.positive_prompt_node_id, value)
			: draft.api_data;
		this.patchDraft(groupId, { positive_prompt_value: value, api_data: newApiData });
	}

	async saveAddFlow(groupId: number): Promise<void> {
		const draft = this.getDraft(groupId);
		if (!draft) return;

		if (!draft.name.trim()) {
			this.patchDraft(groupId, { error: 'Name is required.' });
			return;
		}
		if (!draft.api_data.trim()) {
			this.patchDraft(groupId, { error: 'API data is required.' });
			return;
		}
		if (!draft.image_node_id.trim()) {
			this.patchDraft(groupId, { error: 'Select the image node.' });
			return;
		}
		if (!draft.seed_node_id.trim()) {
			this.patchDraft(groupId, { error: 'Select the seed node.' });
			return;
		}

		try {
			const flow = await firstValueFrom(
				this.db.createQuickFlow({
					name: draft.name.trim(),
					group_id: groupId,
					api_data: draft.api_data.trim(),
					image_node_id: draft.image_node_id,
					seed_node_id: draft.seed_node_id || null,
					positive_prompt_node_id: draft.positive_prompt_node_id || null,
					ask_on_run: JSON.stringify(draft.ask_on_run),
				}),
			);
			this.groups.update((gs) =>
				gs.map((g) => (g.id === groupId ? { ...g, flows: [...g.flows, flow] } : g)),
			);
			this.cancelAddFlow(groupId);
		} catch (e: any) {
			this.patchDraft(groupId, { error: e?.error?.message ?? 'Failed to save flow.' });
		}
	}

	// ── Edit flow ──────────────────────────────────────────────────────────────

	startEditFlow(flow: QuickFlow, groupId: number): void {
		if (this.editFlowDraft()?.flowId === flow.id) {
			this.editFlowDraft.set(null);
			return;
		}
		const imageNodes = this.detectionSvc.scanImageNodes(flow.api_data);
		const seedNodes = this.detectionSvc.scanSeedNodes(flow.api_data);
		const promptNodes = this.detectionSvc.scanPromptNodes(flow.api_data);
		const nodeFields = this.detectionSvc.scanNodeFields(flow.api_data);
		const detected = flow.api_data.trim() ? this.detectionSvc.detectQuickFlowNodes(flow.api_data) : null;

		const promptNodeId = detected?.positivePromptNodeId ?? flow.positive_prompt_node_id ?? '';
		this.editFlowDraft.set({
			flowId: flow.id,
			groupId,
			draft: {
				name: flow.name,
				api_data: flow.api_data,
				image_node_id: detected?.imageNodeId ?? flow.image_node_id,
				seed_node_id: detected?.seedNodeId ?? flow.seed_node_id ?? '',
				positive_prompt_node_id: promptNodeId,
				positive_prompt_value: promptNodeId ? this.readPromptText(flow.api_data, promptNodeId) : '',
				detectedNodes: imageNodes,
				detectedSeedNodes: seedNodes,
				detectedPromptNodes: promptNodes,
				detectedNodeFields: nodeFields,
				ask_on_run: this.parseJson<AskOnRunParam[]>(flow.ask_on_run, []),
				askOnRunExpanded: false,
				error: '',
			},
		});
	}

	cancelEditFlow(): void {
		this.editFlowDraft.set(null);
	}

	patchEditDraft(patch: Partial<FlowDraft>): void {
		this.editFlowDraft.update((state) => {
			if (!state) return null;
			return { ...state, draft: { ...state.draft, ...patch } };
		});
	}

	async onEditDraftApiDataChange(raw: string): Promise<void> {
		if (!raw.trim()) {
			this.patchEditDraft({ api_data: raw, image_node_id: '', seed_node_id: '', positive_prompt_node_id: '', positive_prompt_value: '', detectedNodes: [], detectedSeedNodes: [], detectedPromptNodes: [], detectedNodeFields: [], error: '' });
			return;
		}
		const { apiRaw, error } = await this.resolveApiData(raw);
		if (error) { this.patchEditDraft({ api_data: raw, error }); return; }

		const imageNodes = this.detectionSvc.scanImageNodes(apiRaw);
		const seedNodes = this.detectionSvc.scanSeedNodes(apiRaw);
		const promptNodes = this.detectionSvc.scanPromptNodes(apiRaw);
		const nodeFields = this.detectionSvc.scanNodeFields(apiRaw);
		const detected = this.detectionSvc.detectQuickFlowNodes(apiRaw);

		const promptNodeId = detected.positivePromptNodeId ?? (promptNodes.length === 1 ? promptNodes[0].id : '');
		this.patchEditDraft({
			api_data: apiRaw,
			detectedNodes: imageNodes,
			detectedSeedNodes: seedNodes,
			detectedPromptNodes: promptNodes,
			detectedNodeFields: nodeFields,
			image_node_id: detected.imageNodeId ?? (imageNodes.length >= 1 ? imageNodes[0].id : ''),
			seed_node_id: detected.seedNodeId ?? (seedNodes.length === 1 ? seedNodes[0].id : ''),
			positive_prompt_node_id: promptNodeId,
			positive_prompt_value: promptNodeId ? this.readPromptText(apiRaw, promptNodeId) : '',
			error: detected.error ?? '',
		});
	}

	onEditJsonFileUpload(file: File): void {
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => this.onEditDraftApiDataChange(reader.result as string);
		reader.readAsText(file);
	}

	onEditDraftPromptNodeChange(nodeId: string): void {
		const state = this.editFlowDraft();
		if (!state) return;
		this.patchEditDraft({
			positive_prompt_node_id: nodeId,
			positive_prompt_value: nodeId ? this.readPromptText(state.draft.api_data, nodeId) : '',
		});
	}

	onEditDraftPromptValueChange(value: string): void {
		const state = this.editFlowDraft();
		if (!state) return;
		const newApiData = state.draft.positive_prompt_node_id
			? this.writePromptText(state.draft.api_data, state.draft.positive_prompt_node_id, value)
			: state.draft.api_data;
		this.patchEditDraft({ positive_prompt_value: value, api_data: newApiData });
	}

	async saveEditFlow(): Promise<void> {
		const state = this.editFlowDraft();
		if (!state) return;
		const { flowId, groupId, draft } = state;

		if (!draft.name.trim()) {
			this.patchEditDraft({ error: 'Name is required.' });
			return;
		}
		if (!draft.image_node_id.trim()) {
			this.patchEditDraft({ error: 'Select the image node.' });
			return;
		}
		if (!draft.seed_node_id.trim()) {
			this.patchEditDraft({ error: 'Select the seed node.' });
			return;
		}

		try {
			const updated = await firstValueFrom(
				this.db.updateQuickFlow(flowId, {
					name: draft.name.trim(),
					api_data: draft.api_data.trim(),
					image_node_id: draft.image_node_id,
					seed_node_id: draft.seed_node_id || null,
					positive_prompt_node_id: draft.positive_prompt_node_id || null,
					ask_on_run: JSON.stringify(draft.ask_on_run),
				}),
			);
			this.groups.update((gs) =>
				gs.map((g) =>
					g.id === groupId
						? { ...g, flows: g.flows.map((f) => (f.id === flowId ? updated : f)) }
						: g,
				),
			);
			this.editFlowDraft.set(null);
		} catch (e: any) {
			this.patchEditDraft({ error: e?.error?.message ?? 'Failed to update flow.' });
		}
	}

	// ── Template var helpers ───────────────────────────────────────────────────

	getTemplateVars(prompt: string): TemplateVar[] {
		return parsePromptTemplate(prompt);
	}

	/** Node fields available for Ask On Run — excludes nodes already mapped as Image/Seed/Prompt. */
	getAvailableNodeFields(draft: FlowDraft): NodeFieldEntry[] {
		const reserved = new Set(
			[draft.image_node_id, draft.seed_node_id, draft.positive_prompt_node_id].filter(Boolean),
		);
		return draft.detectedNodeFields.filter((f) => !reserved.has(f.nodeId));
	}


	// ── Ask On Run params (add form) ───────────────────────────────────────────

	toggleAskOnRun(groupId: number): void {
		const draft = this.getDraft(groupId);
		if (!draft) return;
		this.patchDraft(groupId, { askOnRunExpanded: !draft.askOnRunExpanded });
	}

	addParam(groupId: number): void {
		const draft = this.getDraft(groupId);
		if (!draft) return;
		const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
		this.patchDraft(groupId, {
			ask_on_run: [...draft.ask_on_run, { id, label: '', type: 'number', node_id: '', field: '', default: '' }],
		});
	}

	removeParam(groupId: number, index: number): void {
		const draft = this.getDraft(groupId);
		if (!draft) return;
		const params = [...draft.ask_on_run];
		params.splice(index, 1);
		this.patchDraft(groupId, { ask_on_run: params });
	}

	updateParam(groupId: number, index: number, key: 'label' | 'type' | 'default', value: string): void {
		const draft = this.getDraft(groupId);
		if (!draft) return;
		this.patchDraft(groupId, {
			ask_on_run: draft.ask_on_run.map((p, i) => i === index ? { ...p, [key]: value } : p),
		});
	}

	updateParamNodeField(groupId: number, index: number, combined: string): void {
		const draft = this.getDraft(groupId);
		if (!draft) return;
		const [node_id, field] = combined.split('|');
		const fieldInfo = draft.detectedNodeFields.find((f) => f.nodeId === node_id && f.field === field);
		this.patchDraft(groupId, {
			ask_on_run: draft.ask_on_run.map((p, i) => i === index ? {
				...p,
				node_id: node_id ?? '',
				field: field ?? '',
				type: fieldInfo?.type ?? p.type,
				default: p.default || (fieldInfo ? String(fieldInfo.value) : ''),
			} : p),
		});
	}


	// ── Ask On Run params (edit form) ──────────────────────────────────────────

	toggleAskOnRunEdit(): void {
		const state = this.editFlowDraft();
		if (!state) return;
		this.patchEditDraft({ askOnRunExpanded: !state.draft.askOnRunExpanded });
	}

	addParamEdit(): void {
		const state = this.editFlowDraft();
		if (!state) return;
		const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
		this.patchEditDraft({
			ask_on_run: [...state.draft.ask_on_run, { id, label: '', type: 'number', node_id: '', field: '', default: '' }],
		});
	}

	removeParamEdit(index: number): void {
		const state = this.editFlowDraft();
		if (!state) return;
		const params = [...state.draft.ask_on_run];
		params.splice(index, 1);
		this.patchEditDraft({ ask_on_run: params });
	}

	updateParamEdit(index: number, key: 'label' | 'type' | 'default', value: string): void {
		const state = this.editFlowDraft();
		if (!state) return;
		this.patchEditDraft({
			ask_on_run: state.draft.ask_on_run.map((p, i) => i === index ? { ...p, [key]: value } : p),
		});
	}

	updateParamNodeFieldEdit(index: number, combined: string): void {
		const state = this.editFlowDraft();
		if (!state) return;
		const [node_id, field] = combined.split('|');
		const fieldInfo = state.draft.detectedNodeFields.find((f) => f.nodeId === node_id && f.field === field);
		this.patchEditDraft({
			ask_on_run: state.draft.ask_on_run.map((p, i) => i === index ? {
				...p,
				node_id: node_id ?? '',
				field: field ?? '',
				type: fieldInfo?.type ?? p.type,
				default: p.default || (fieldInfo ? String(fieldInfo.value) : ''),
			} : p),
		});
	}

	// ── Drag to reorder groups ─────────────────────────────────────────────────

	dragSrcGroupId = signal<number | null>(null);
	dragOverGroupId = signal<number | null>(null);
	private _groupDragFromInput = false;

	onGroupMouseDown(event: MouseEvent): void {
		this._groupDragFromInput = !!(event.target as Element).closest('textarea, input, select');
	}

	onGroupDragStart(event: DragEvent, groupId: number): void {
		if (this._groupDragFromInput) {
			event.preventDefault();
			return;
		}
		this.dragSrcGroupId.set(groupId);
		event.dataTransfer!.effectAllowed = 'move';
		event.dataTransfer!.setData('text/plain', String(groupId));
		event.stopPropagation();
	}

	onGroupDragOver(event: DragEvent, groupId: number): void {
		if (!this.dragSrcGroupId() || this.dragSrcGroupId() === groupId) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer!.dropEffect = 'move';
		this.dragOverGroupId.set(groupId);
	}

	onGroupDrop(event: DragEvent, targetGroupId: number): void {
		event.preventDefault();
		event.stopPropagation();
		const srcId = this.dragSrcGroupId();
		if (srcId !== null && srcId !== targetGroupId) {
			this.applyGroupReorder(srcId, targetGroupId);
		}
		this.dragSrcGroupId.set(null);
		this.dragOverGroupId.set(null);
	}

	onGroupDragEnd(): void {
		this.dragSrcGroupId.set(null);
		this.dragOverGroupId.set(null);
	}

	private applyGroupReorder(srcId: number, beforeId: number): void {
		let newIds: number[] = [];
		this.groups.update((gs) => {
			const arr = [...gs];
			const srcIdx = arr.findIndex((g) => g.id === srcId);
			if (srcIdx === -1) return gs;
			const [moved] = arr.splice(srcIdx, 1);
			const insertIdx = arr.findIndex((g) => g.id === beforeId);
			arr.splice(insertIdx === -1 ? arr.length : insertIdx, 0, moved);
			newIds = arr.map((g) => g.id);
			return arr;
		});
		if (newIds.length) {
			firstValueFrom(this.db.reorderQuickFlowGroups(newIds)).catch(() => {
				this.dialog.alert('Failed to save new group order.');
			});
		}
	}

	// ── Drag to reorder flows ──────────────────────────────────────────────────

	dragSrcFlowId = signal<number | null>(null);
	dragOverFlowId = signal<number | null>(null);

	onFlowDragStart(event: DragEvent, flowId: number): void {
		this.dragSrcFlowId.set(flowId);
		event.dataTransfer!.effectAllowed = 'move';
		event.dataTransfer!.setData('text/plain', String(flowId));
	}

	onFlowDragOver(event: DragEvent, flowId: number): void {
		if (!this.dragSrcFlowId() || this.dragSrcFlowId() === flowId) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer!.dropEffect = 'move';
		this.dragOverFlowId.set(flowId);
	}

	onFlowDrop(event: DragEvent, targetFlowId: number, groupId: number): void {
		event.preventDefault();
		event.stopPropagation();
		const srcId = this.dragSrcFlowId();
		if (srcId !== null && srcId !== targetFlowId) {
			this.applyReorder(srcId, groupId, targetFlowId);
		}
		this.clearDragState();
	}

	onGroupBodyDragOver(event: DragEvent): void {
		if (!this.dragSrcFlowId()) return;
		event.preventDefault();
		event.dataTransfer!.dropEffect = 'move';
		this.dragOverFlowId.set(null);
	}

	onGroupBodyDrop(event: DragEvent, groupId: number): void {
		event.preventDefault();
		const srcId = this.dragSrcFlowId();
		if (srcId !== null) this.applyReorder(srcId, groupId, null);
		this.clearDragState();
	}

	onFlowDragEnd(): void {
		this.clearDragState();
	}

	private clearDragState(): void {
		this.dragSrcFlowId.set(null);
		this.dragOverFlowId.set(null);
	}

	private applyReorder(srcId: number, groupId: number, beforeId: number | null): void {
		let newIds: number[] = [];
		this.groups.update((gs) =>
			gs.map((g) => {
				if (g.id !== groupId) return g;
				const flows = [...g.flows];
				const srcIdx = flows.findIndex((f) => f.id === srcId);
				if (srcIdx === -1) return g;
				const [moved] = flows.splice(srcIdx, 1);
				if (beforeId === null) {
					flows.push(moved);
				} else {
					const insertIdx = flows.findIndex((f) => f.id === beforeId);
					flows.splice(insertIdx === -1 ? flows.length : insertIdx, 0, moved);
				}
				newIds = flows.map((f) => f.id);
				return { ...g, flows };
			}),
		);
		if (newIds.length) {
			firstValueFrom(this.db.reorderQuickFlows(newIds)).catch(() => {
				this.dialog.alert('Failed to save new order.');
			});
		}
	}

	// ── Export / Import ────────────────────────────────────────────────────────

	exportingGroups = signal(false);
	importingGroups = signal(false);

	exportGroups(): void {
		this.exportingGroups.set(true);
		const groups = this.groups();
		const payload = {
			version: 1,
			exportedAt: new Date().toISOString(),
			groups: groups.map((g) => ({
				name: g.name,
				flows: g.flows.map((f) => ({
					name: f.name,
					api_data: f.api_data,
					image_node_id: f.image_node_id,
					seed_node_id: f.seed_node_id ?? null,
					positive_prompt_node_id: f.positive_prompt_node_id ?? null,
					ask_on_run: f.ask_on_run ?? '[]',
				})),
			})),
		};
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `quick-flows.comfyuix.json`;
		a.click();
		URL.revokeObjectURL(url);
		this.exportingGroups.set(false);
	}

	triggerImportGroups(): void {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.onchange = (e) => this.importGroupsFromFile(e);
		input.click();
	}

	async importGroupsFromFile(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		let data: any;
		try {
			data = JSON.parse(await file.text());
		} catch {
			await this.dialog.alert('Invalid file: could not parse JSON.');
			return;
		}

		if (data.version !== 1 || !Array.isArray(data.groups)) {
			await this.dialog.alert('Invalid export file format.');
			return;
		}

		const confirmed = await this.dialog.confirm(
			`Import ${data.groups.length} group(s) from this file? New groups will be added to your existing list.`,
		);
		if (!confirmed) return;

		this.importingGroups.set(true);
		let groupsFailed = 0;
		let flowsFailed = 0;
		let flowsTotal = 0;

		for (const groupData of data.groups) {
			try {
				const group = await firstValueFrom(this.db.createQuickFlowGroup(groupData.name ?? 'Imported Group'));
				const newGroup = { ...group, flows: [] as typeof group[] };
				this.groups.update((gs) => [...gs, newGroup as any]);
				this.expandedGroupIds.update((set) => new Set([...set, group.id]));

				const flows: any[] = Array.isArray(groupData.flows) ? groupData.flows : [];
				flowsTotal += flows.length;
				const flowIds: number[] = [];
				for (const flowData of flows) {
					try {
						const flow = await firstValueFrom(
							this.db.createQuickFlow({
								name: flowData.name ?? 'Imported Flow',
								group_id: group.id,
								api_data: flowData.api_data ?? '',
								image_node_id: flowData.image_node_id ?? '',
								seed_node_id: flowData.seed_node_id ?? null,
								positive_prompt_node_id: flowData.positive_prompt_node_id ?? null,
								ask_on_run: flowData.ask_on_run ?? '[]',
							}),
						);
						flowIds.push(flow.id);
						this.groups.update((gs) =>
							gs.map((g) => (g.id === group.id ? { ...g, flows: [...g.flows, flow] } : g)),
						);
					} catch {
						flowsFailed++;
					}
				}
			} catch {
				groupsFailed++;
				flowsFailed += (groupData.flows?.length ?? 0);
				flowsTotal += (groupData.flows?.length ?? 0);
			}
		}

		this.importingGroups.set(false);

		if (groupsFailed > 0 || flowsFailed > 0) {
			await this.dialog.alert(
				`Import completed with errors: ${groupsFailed} group(s) and ${flowsFailed}/${flowsTotal} flow(s) failed.`,
			);
		} else {
			await this.dialog.alert(
				`Imported ${data.groups.length} group(s) with ${flowsTotal} flow(s) successfully.`,
			);
		}
	}

	// ── Duplicate / Delete ─────────────────────────────────────────────────────

	async duplicateFlow(flow: QuickFlow, groupId: number): Promise<void> {
		try {
			const copy = await firstValueFrom(
				this.db.createQuickFlow({
					name: `${flow.name} (copy)`,
					group_id: groupId,
					api_data: flow.api_data,
					image_node_id: flow.image_node_id,
					seed_node_id: flow.seed_node_id,
					positive_prompt_node_id: flow.positive_prompt_node_id,
					ask_on_run: flow.ask_on_run ?? '[]',
				}),
			);
			// Insert the copy immediately after the original, then persist the order.
			let newIds: number[] = [];
			this.groups.update((gs) =>
				gs.map((g) => {
					if (g.id !== groupId) return g;
					const flows = [...g.flows];
					const srcIdx = flows.findIndex((f) => f.id === flow.id);
					flows.splice(srcIdx === -1 ? flows.length : srcIdx + 1, 0, copy);
					newIds = flows.map((f) => f.id);
					return { ...g, flows };
				}),
			);
			if (newIds.length > 1) {
				firstValueFrom(this.db.reorderQuickFlows(newIds)).catch(() => {});
			}
			this.expandedGroupIds.set(new Set([groupId]));
			this.startEditFlow(copy, groupId);
		} catch {
			await this.dialog.alert('Failed to duplicate flow.');
		}
	}

	async deleteFlow(flow: QuickFlow, groupId: number): Promise<void> {
		const confirmed = await this.dialog.confirm(
			`Delete quick flow "<strong>${flow.name}</strong>"? This cannot be undone.`,
		);
		if (!confirmed) return;
		try {
			await firstValueFrom(this.db.deleteQuickFlow(flow.id));
			this.groups.update((gs) =>
				gs.map((g) =>
					g.id === groupId ? { ...g, flows: g.flows.filter((f) => f.id !== flow.id) } : g,
				),
			);
		} catch {
			await this.dialog.alert('Failed to delete flow.');
		}
	}
}
