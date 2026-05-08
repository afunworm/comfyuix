import { Component, computed, effect, inject, input, OnInit, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FlowConfig, Configurable } from '../../types/flow.type';
import { FsEntry } from '../../comfyui/comfyui-database.service';
import { ComfyUIDatabaseService } from '../../comfyui/comfyui-database.service';
import {
  MultirunEntry,
  MultirunEntryStatus,
  MultirunPreset,
  MultirunRunPayload,
  MultirunSharedField,
} from './multirun.types';

const SKIP_CFG_IDS = new Set(['outputNode']);
const SKIP_CFG_TYPES = new Set(['inputImage']);

/** Auto-links well-known configurable IDs to their matching pre-populated shared field label. */
const AUTO_LINK_MAP: Record<string, string> = {
  positivePrompt: 'Prompt',
  seed: 'Seed',
  finalImageWidth: 'Width',
  finalImageHeight: 'Height',
};

@Component({
  selector: 'app-multirun-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './multirun-panel.component.html',
  styleUrl: './multirun-panel.component.scss',
})
export class MultirunPanelComponent implements OnInit {
  private dbService = inject(ComfyUIDatabaseService);

  bookId = input.required<string>();
  flows = input.required<FlowConfig[]>();
  loraFiles = input<FsEntry[]>([]);
  statuses = input<Record<string, MultirunEntryStatus>>({});
  running = input<boolean>(false);

  run = output<MultirunRunPayload>();
  closed = output<void>();

  sharedFields = signal<MultirunSharedField[]>([
    { id: crypto.randomUUID(), label: 'Prompt', value: '' },
    { id: crypto.randomUUID(), label: 'Seed', value: '' },
    { id: crypto.randomUUID(), label: 'Width', value: '' },
    { id: crypto.randomUUID(), label: 'Height', value: '' },
  ]);
  entries = signal<MultirunEntry[]>([]);
  expandedEntries = signal<Set<string>>(new Set());

  // Presets
  presets = signal<MultirunPreset[]>([]);
  savePresetName = signal<string>('');
  showSaveRow = signal<boolean>(false);
  presetSaving = signal<boolean>(false);

  canRun = computed(() => this.entries().length > 0 && !this.running());

  overallProgress = computed(() => {
    const statuses = this.statuses();
    if (!Object.keys(statuses).length) return null;
    const total = this.entries().length;
    if (!total) return null;
    const done = Object.values(statuses).filter((s) => s.state === 'done' || s.state === 'error').length;
    const running = Object.values(statuses).find((s) => s.state === 'running');
    const runningContrib = running ? running.progress / 100 / total : 0;
    const pct = Math.round((done / total + runningContrib) * 100);
    return { done, total, pct };
  });

  constructor() {
    // While a run is active: collapse all entries, then expand only the currently running one.
    effect(() => {
      if (!this.running()) return;
      const runningId = Object.entries(this.statuses()).find(([, s]) => s.state === 'running')?.[0];
      this.expandedEntries.set(runningId ? new Set([runningId]) : new Set());
    });
  }

  ngOnInit(): void {
    this.loadPresets();
  }

  // ── Presets ───────────────────────────────────────────────────────────

  loadPresets(): void {
    this.dbService.getMultirunPresets(this.bookId()).subscribe({
      next: (presets) => this.presets.set(presets),
      error: () => {},
    });
  }

  applyPreset(presetId: string): void {
    const preset = this.presets().find((p) => p.id === presetId);
    if (!preset) return;
    // Re-mint IDs so there are no stale references
    const fieldIdMap = new Map<string, string>();
    const sharedFields = preset.presetData.sharedFields.map((f) => {
      const newId = crypto.randomUUID();
      fieldIdMap.set(f.id, newId);
      return { ...f, id: newId };
    });
    const entries = preset.presetData.entries.map((e) => ({
      ...e,
      id: crypto.randomUUID(),
      links: Object.fromEntries(
        Object.entries(e.links).map(([cfgId, fieldId]) => [
          cfgId,
          fieldIdMap.get(fieldId) ?? '',
        ])
      ),
    }));
    this.sharedFields.set(sharedFields);
    this.entries.set(entries);
    this.expandedEntries.set(new Set());
  }

  toggleSaveRow(): void {
    this.showSaveRow.update((v) => !v);
    if (this.showSaveRow()) this.savePresetName.set('');
  }

  savePreset(): void {
    const name = this.savePresetName().trim();
    if (!name || this.presetSaving()) return;
    this.presetSaving.set(true);
    const presetData = {
      sharedFields: this.sharedFields(),
      entries: this.entries(),
    };
    this.dbService.createMultirunPreset(this.bookId(), name, presetData).subscribe({
      next: (preset) => {
        this.presets.update((p) => [...p, preset]);
        this.showSaveRow.set(false);
        this.savePresetName.set('');
        this.presetSaving.set(false);
      },
      error: () => { this.presetSaving.set(false); },
    });
  }

  deletePreset(presetId: string): void {
    this.dbService.deleteMultirunPreset(this.bookId(), presetId).subscribe({
      next: () => this.presets.update((p) => p.filter((x) => x.id !== presetId)),
      error: () => {},
    });
  }

  // ── Flow helpers ──────────────────────────────────────────────────────

  getFlow(flowId: string): FlowConfig | undefined {
    return this.flows().find((f) => f.id === flowId);
  }

  getFlowOptionLabel(flow: FlowConfig): string {
    const desc = flow.description?.trim();
    if (!desc) return flow.name;
    const truncated = desc.length > 40 ? desc.slice(0, 40) + '…' : desc;
    return `${flow.name} — ${truncated}`;
  }

  getTemplates(flowId: string) {
    return this.getFlow(flowId)?.templates ?? [];
  }

  getFlowConfigurables(flowId: string): Configurable[] {
    const flow = this.getFlow(flowId);
    if (!flow) return [];
    return flow.configurables.filter(
      (c) => !SKIP_CFG_IDS.has(c.id) && !SKIP_CFG_TYPES.has(c.type)
    );
  }

  getTemplateValue(entry: MultirunEntry, cfgId: string): string {
    const flow = this.getFlow(entry.flowId);
    const template = flow?.templates.find((t) => t.id === entry.templateId);
    return template?.changes.find((c) => c.configId === cfgId)?.value ?? '';
  }

  private buildAutoLinks(flow: FlowConfig): Record<string, string> {
    const links: Record<string, string> = {};
    for (const cfg of flow.configurables) {
      const targetLabel = AUTO_LINK_MAP[cfg.id];
      if (!targetLabel) continue;
      const field = this.sharedFields().find((f) => f.label === targetLabel);
      if (field) links[cfg.id] = field.id;
    }
    return links;
  }

  private buildTemplateOverrides(flow: FlowConfig, templateId: string): Record<string, string> {
    const template = flow.templates.find((t) => t.id === templateId);
    if (!template) return {};
    const overrides: Record<string, string> = {};
    for (const change of template.changes) {
      if (change.value !== undefined) {
        overrides[change.configId] = change.value;
      }
    }
    return overrides;
  }

  getLinkedField(entry: MultirunEntry, cfgId: string): MultirunSharedField | undefined {
    const fieldId = entry.links[cfgId];
    if (!fieldId) return undefined;
    return this.sharedFields().find((f) => f.id === fieldId);
  }

  isExpanded(entryId: string): boolean {
    return this.expandedEntries().has(entryId);
  }

  toggleExpand(entryId: string): void {
    this.expandedEntries.update((s) => {
      const next = new Set(s);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  getLoraOptions(presets: string[] | undefined): FsEntry[] {
    const files = this.loraFiles().filter((f) => f.name.includes('.'));
    if (!presets?.length) return files;
    return files.filter((f) => presets.includes(f.path));
  }

  // ── Shared Fields ─────────────────────────────────────────────────────

  addSharedField(): void {
    const id = crypto.randomUUID();
    this.sharedFields.update((fields) => [
      ...fields,
      { id, label: `Field ${fields.length + 1}`, value: '' },
    ]);
  }

  removeSharedField(fieldId: string): void {
    this.sharedFields.update((fields) => fields.filter((f) => f.id !== fieldId));
    this.entries.update((entries) =>
      entries.map((e) => ({
        ...e,
        links: Object.fromEntries(
          Object.entries(e.links).filter(([, v]) => v !== fieldId)
        ),
      }))
    );
  }

  updateSharedFieldLabel(fieldId: string, label: string): void {
    this.sharedFields.update((fields) =>
      fields.map((f) => (f.id === fieldId ? { ...f, label } : f))
    );
  }

  updateSharedFieldValue(fieldId: string, value: string): void {
    this.sharedFields.update((fields) =>
      fields.map((f) => (f.id === fieldId ? { ...f, value } : f))
    );
  }

  // ── Entries ───────────────────────────────────────────────────────────

  addEntry(): void {
    const firstFlow = this.flows()[0];
    if (!firstFlow?.id) return;
    const firstTemplate = firstFlow.templates[0];
    if (!firstTemplate) return;

    const id = crypto.randomUUID();
    const overrides = this.buildTemplateOverrides(firstFlow, firstTemplate.id);
    const links = this.buildAutoLinks(firstFlow);
    this.entries.update((entries) => [
      ...entries,
      { id, flowId: firstFlow.id!, templateId: firstTemplate.id, links, overrides },
    ]);
    this.expandedEntries.update((s) => new Set([...s, id]));
  }

  removeEntry(entryId: string): void {
    this.entries.update((entries) => entries.filter((e) => e.id !== entryId));
    this.expandedEntries.update((s) => {
      const n = new Set(s);
      n.delete(entryId);
      return n;
    });
  }

  updateEntryFlow(entryId: string, flowId: string): void {
    const flow = this.getFlow(flowId);
    const firstTemplate = flow?.templates[0];
    if (!flow || !firstTemplate) return;
    const overrides = this.buildTemplateOverrides(flow, firstTemplate.id);
    const links = this.buildAutoLinks(flow);
    this.entries.update((entries) =>
      entries.map((e) =>
        e.id === entryId
          ? { ...e, flowId, templateId: firstTemplate.id, links, overrides }
          : e
      )
    );
  }

  updateEntryTemplate(entryId: string, templateId: string): void {
    const entry = this.entries().find((e) => e.id === entryId);
    const flow = entry ? this.getFlow(entry.flowId) : undefined;
    const overrides = flow ? this.buildTemplateOverrides(flow, templateId) : {};
    this.entries.update((entries) =>
      entries.map((e) => (e.id === entryId ? { ...e, templateId, overrides } : e))
    );
  }

  setOverride(entryId: string, cfgId: string, value: string): void {
    this.entries.update((entries) =>
      entries.map((e) =>
        e.id === entryId ? { ...e, overrides: { ...e.overrides, [cfgId]: value } } : e
      )
    );
  }

  // ── Link ──────────────────────────────────────────────────────────────

  getAvailableSharedFields(entry: MultirunEntry, cfgId: string): MultirunSharedField[] {
    const usedElsewhere = new Set(
      Object.entries(entry.links)
        .filter(([id]) => id !== cfgId)
        .map(([, fieldId]) => fieldId)
    );
    return this.sharedFields().filter((f) => !usedElsewhere.has(f.id));
  }

  setLink(entryId: string, cfgId: string, fieldId: string): void {
    this.entries.update((entries) =>
      entries.map((e) => {
        if (e.id !== entryId) return e;
        const links = { ...e.links };
        if (fieldId) links[cfgId] = fieldId;
        else delete links[cfgId];
        return { ...e, links };
      })
    );
  }

  // ── Run ───────────────────────────────────────────────────────────────

  onRun(): void {
    if (!this.canRun()) return;
    this.run.emit({ entries: this.entries(), sharedFields: this.sharedFields() });
  }
}
