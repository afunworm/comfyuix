import {
  Component,
  signal,
  computed,
  effect,
  HostListener,
  inject,
  ViewChild,
  ElementRef,
  OnInit,
  Input,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, Router } from '@angular/router';
import { HeaderComponent } from '../../header/header.component';
import { Dialog } from '../../dialog';
import {
  ComfyNodeDetectionService,
  DetectedConfigurable,
} from '../../comfyui/comfyui-node-detection.service';
import { ComfyUIDatabaseService } from '../../comfyui/comfyui-database.service';
import { AuthService } from '../../auth/auth.service';
import {
  convertWorkflowWithSubgraphsToApi,
  isWorkflowFormat,
  type WorkflowJsonWithSubgraphs,
} from '../../comfyui/workflow-converter';
import { Configurable, FlowConfig, FlowTemplate } from '../../types/flow.type';

// ── Layout constants (must match SCSS) ────────────────────────────────────────
const NODE_W = 290;
const HEADER_H = 46;
const ROW_H = 34;
const EXPOSED_EXTRA = 38;      // type-select row added below the name row
const LORA_BTN_EXTRA = 30;    // additional lora button row when selectValue === 'lora'
const NODE_PAD_B = 10;
const COL_GAP = 90;
const ROW_GAP = 28;

// ── NODE_TYPES: exact copy of FlowMaker.NODE_TYPES ───────────────────────────
const NODE_TYPES: Record<string, { type: Configurable['type']; stable: boolean }> = {
  positivePrompt: { type: 'core', stable: true },
  negativePrompt: { type: 'core', stable: true },
  seed:           { type: 'core', stable: true },
  number:         { type: 'number', stable: false },
  finalImageWidth:  { type: 'finalImageWidth', stable: true },
  finalImageHeight: { type: 'finalImageHeight', stable: true },
  text:           { type: 'text', stable: false },
  multilineText:  { type: 'multilineText', stable: false },
  preset:         { type: 'preset', stable: false },
  lora:           { type: 'lora', stable: false },
};

export const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'positivePrompt',  label: 'Positive Prompt' },
  { value: 'negativePrompt',  label: 'Negative Prompt' },
  { value: 'seed',            label: 'Seed' },
  { value: 'number',          label: 'Number' },
  { value: 'finalImageWidth',  label: 'Final Image Width' },
  { value: 'finalImageHeight', label: 'Final Image Height' },
  { value: 'text',            label: 'Text' },
  { value: 'multilineText',   label: 'Multiline Text' },
  { value: 'preset',          label: 'Preset' },
  { value: 'lora',            label: 'LoRA' },
  { value: 'inputImage',      label: 'Input Image' },
];

// Maps selectValue → CSS data-type category (for tag coloring)
export const TYPE_CATEGORY: Record<string, string> = {
  positivePrompt: 'core',
  negativePrompt: 'core',
  seed:           'core',
  number:         'number',
  width:          'number',
  height:         'number',
  finalImageWidth:  'number',
  finalImageHeight: 'number',
  text:          'text',
  multilineText: 'text',
  preset:        'preset',
  lora:          'lora',
  inputImage:    'inputImage',
};

// ── Domain types ──────────────────────────────────────────────────────────────
export interface NodeInput {
  name: string;
  isConnection: boolean;
  sourceNodeId?: string;
  value?: any;
}

export interface GraphNode {
  id: string;
  title: string;
  inputs: NodeInput[];
  height: number;
  x: number;
  y: number;
}

export interface ExposedConfig {
  name: string;
  selectValue: string;
  protected: boolean;
  visible: boolean;
  typeLocked: boolean; // true when type was auto-assigned; user must explicitly unlock to change
  presets?: string[];  // selected LoRA names when selectValue === 'lora'
}

export interface TemplateEntry {
  id: string;
  name: string;
  changes: Record<string, string>; // key: `${nodeId}:${inputName}` → value
}

const TEMPLATE_EXCLUDED = new Set(['positivePrompt', 'negativePrompt', 'seed', 'inputImage', 'finalImageWidth', 'finalImageHeight']);

function wireColor(inputName: string): string {
  const n = inputName.toLowerCase();
  if (n === 'model' || n.endsWith('_model')) return '#c084fc';
  if (n.startsWith('clip'))                  return '#fbbf24';
  if (n === 'vae')                            return '#f472b6';
  if (n === 'latent_image' || n === 'samples') return '#818cf8';
  if (n === 'image' || n === 'images')        return '#4ade80';
  if (n === 'positive' || n === 'negative' || n === 'conditioning') return '#fb923c';
  if (n === 'mask')                           return '#2dd4bf';
  if (n === 'control_net')                    return '#22d3ee';
  if (n === 'upscale_model')                  return '#a78bfa';
  return '#4a6a9f';
}

// ── Component ─────────────────────────────────────────────────────────────────
@Component({
  selector: 'app-flow-import',
  standalone: true,
  imports: [FormsModule, RouterLink, HeaderComponent],
  templateUrl: './flowimport.html',
  styleUrl: './flowimport.scss',
})
export class FlowImport implements OnInit {
  private detection = inject(ComfyNodeDetectionService);
  private db = inject(ComfyUIDatabaseService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private dialog = inject(Dialog);

  @Input() bookId!: string;
  @Input() flowId?: string;

  get updateMode() { return !!this.flowId; }

  readonly typeOptions = TYPE_OPTIONS;
  readonly TYPE_CATEGORY = TYPE_CATEGORY;
  readonly NODE_W = NODE_W;

  // ── State ──────────────────────────────────────────────────────────────────
  apiJson = signal('');
  apiData = signal<Record<string, any>>({});
  parseError = signal('');
  converting = signal(false);
  jsonPanelOpen = signal(false);
  flashingNodeId = signal<string | null>(null);

  flowName = signal('');
  flowDescription = signal('');
  saving = signal(false);
  saveError = signal('');

  @ViewChild('canvasEl') canvasEl!: ElementRef<HTMLElement>;

  panX = signal(40);
  panY = signal(40);
  zoom = signal(1);

  nodePositions = signal<Map<string, { x: number; y: number }>>(new Map());

  /** key: `${nodeId}:${inputName}` */
  exposedMap = signal<Map<string, ExposedConfig>>(new Map());

  /** Detected configurables keyed by target path `/nodeId/inputs/inputName` */
  detectedTargets = signal<Map<string, DetectedConfigurable>>(new Map());

  /** Key of the exposed input whose LoRA picker is open (`nodeId:inputName`), or null */
  loraPickerKey = signal<string | null>(null);
  loraPicker = signal<{ items: string[]; selected: Set<string> } | null>(null);
  loraLoading = signal(false);

  /** Key of the exposed input whose preset options editor is open */
  presetOptionsKey = signal<string | null>(null);
  presetOptionsText = signal(''); // one option per line

  /** Inline editing of raw node values on the canvas (`nodeId:inputName`) */
  editingInlineKey = signal<string | null>(null);
  editingInlineValue = signal<string>('');

  outputDimensions = signal<'fixed' | 'derived'>('fixed');

  sidebarStep = signal<1 | 2 | 3>(1);
  templates = signal<TemplateEntry[]>([]);
  renamingTemplateId = signal<string | null>(null);
  renameText = signal('');

  /** Template modal state */
  editingTemplateId = signal<string | null>(null);
  editingName = signal('');
  editingChanges = signal<Record<string, string>>({});
  copyFromMenuOpen = signal(false);

  // ── Search ─────────────────────────────────────────────────────────────────
  @ViewChild('searchInput') searchInputRef?: ElementRef<HTMLInputElement>;

  searchQuery = signal<string>('');
  searchMatchIndex = signal<number>(0);

  // ── Edge hover ─────────────────────────────────────────────────────────────
  hoveredEdge = signal<{ fromNodeId: string; toNodeId: string } | null>(null);
  hoveredEdgeIndex = signal<number | null>(null);

  private readonly _resetSearchIndex = effect(() => {
    this.searchQuery(); // track
    this.searchMatchIndex.set(0);
  });

  searchMatches = computed<string[]>(() => {
    const q = this.searchQuery().trim().toLowerCase();
    if (!q) return [];
    return this.graphNodes()
      .filter((n) => {
        if (n.title.toLowerCase().includes(q)) return true;
        if (n.id.toLowerCase().includes(q)) return true;
        return n.inputs.some(
          (inp) =>
            inp.name.toLowerCase().includes(q) ||
            (inp.value != null && String(inp.value).toLowerCase().includes(q)),
        );
      })
      .map((n) => n.id);
  });

  runSearch(): void {
    const matches = this.searchMatches();
    if (!matches.length) return;
    const idx = this.searchMatchIndex() % matches.length;
    this.focusNode(matches[idx]);
    this.searchMatchIndex.set(idx + 1);
  }

  clearSearch(): void {
    this.searchQuery.set('');
    this.searchMatchIndex.set(0);
  }

  private serverId: string | null = null;
  tunnelConnected = signal<boolean | null>(null); // null = unknown

  models: {
    checkpoints: string[];
    textEncoders: string[];
    diffusionModels: string[];
    clipVisions: string[];
    controlnets: string[];
    modelPatches: string[];
  } = {
    checkpoints: [],
    textEncoders: [],
    diffusionModels: [],
    clipVisions: [],
    controlnets: [],
    modelPatches: [],
  };

  // Pan internal state
  panning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartPanX = 0;
  private panStartPanY = 0;

  hasData = computed(() => Object.keys(this.apiData()).length > 0);

  /** IDs of nodes whose output is consumed by at least one other node */
  referencedNodeIds = computed<Set<string>>(() => {
    const ids = new Set<string>();
    for (const node of this.graphNodes()) {
      for (const inp of node.inputs) {
        if (inp.isConnection && inp.sourceNodeId) ids.add(inp.sourceNodeId);
      }
    }
    return ids;
  });

  // ── Validation ─────────────────────────────────────────────────────────────
  validation = computed(() => {
    const configs = [...this.exposedMap().values()];
    const selectValues = configs.map((c) => c.selectValue);
    const fixed = this.outputDimensions() === 'fixed';

    const hasPositivePrompt = selectValues.includes('positivePrompt');
    const hasSeed = selectValues.includes('seed');
    const widthCount = selectValues.filter((v) => v === 'finalImageWidth').length;
    const heightCount = selectValues.filter((v) => v === 'finalImageHeight').length;

    const requirements: { label: string; ok: boolean; hint: string }[] = [
      {
        label: 'Positive Prompt',
        ok: hasPositivePrompt,
        hint: 'Expose an input and assign type "Positive Prompt".',
      },
      {
        label: 'Noise Seed',
        ok: hasSeed,
        hint: 'Expose an input and assign type "Seed".',
      },
      ...(fixed ? [
        {
          label: 'Final Image Width',
          ok: widthCount === 1,
          hint: widthCount > 1
            ? `Found ${widthCount} — must appear exactly once.`
            : 'Expose an input and assign type "Final Image Width".',
        },
        {
          label: 'Final Image Height',
          ok: heightCount === 1,
          hint: heightCount > 1
            ? `Found ${heightCount} — must appear exactly once.`
            : 'Expose an input and assign type "Final Image Height".',
        },
      ] : []),
    ];

    return {
      requirements,
      ready: requirements.every((r) => r.ok),
    };
  });

  /** All exposed inputs annotated with whether they are required in templates */
  templateInputs = computed(() =>
    [...this.exposedMap().entries()].map(([key, config]) => ({
      key,
      config,
      nodeId: key.split(':')[0],
      inputName: key.split(':')[1],
      required: !TEMPLATE_EXCLUDED.has(config.selectValue),
    }))
  );

  /** Returns true if a required template field counts as filled.
   *  LoRA fields accept "" (None) as a valid value — any key presence is enough.
   *  All other fields require a non-empty string. */
  private isFieldFilled(key: string, changes: Record<string, string>): boolean {
    const cfg = this.exposedMap().get(key);
    if (cfg?.selectValue === 'lora') return true; // None is always acceptable
    return !!changes[key]?.trim();
  }

  /** How many templates have all required fields filled */
  templatesStatus = computed(() => {
    const inputs = this.templateInputs().filter((i) => i.required);
    const complete = this.templates().filter((t) =>
      inputs.every((i) => this.isFieldFilled(i.key, t.changes))
    ).length;
    return { complete, total: this.templates().length };
  });

  /** Per-template completion — used on each card */
  getTemplateStatus(id: string): { filled: number; total: number } {
    const tmpl = this.templates().find((t) => t.id === id);
    if (!tmpl) return { filled: 0, total: 0 };
    const required = this.templateInputs().filter((i) => i.required);
    const filled = required.filter((i) => this.isFieldFilled(i.key, tmpl.changes)).length;
    return { filled, total: required.length };
  }

  // ── Computed ───────────────────────────────────────────────────────────────
  graphNodes = computed<GraphNode[]>(() => {
    const data = this.apiData();
    const positions = this.nodePositions();
    const exposed = this.exposedMap();

    // Build nodes with computed heights but positions from layout (Y is ordering only)
    const nodes = Object.keys(data).map((id) => {
      const raw = data[id];
      const inputs: NodeInput[] = Object.entries(raw.inputs ?? {}).map(
        ([name, val]) => ({
          name,
          isConnection: Array.isArray(val),
          sourceNodeId: Array.isArray(val) ? String((val as any[])[0]) : undefined,
          value: Array.isArray(val) ? undefined : val,
        }),
      );

      let height = HEADER_H + NODE_PAD_B;
      for (const inp of inputs) {
        height += ROW_H;
        if (!inp.isConnection && exposed.has(`${id}:${inp.name}`)) {
          const cfg = exposed.get(`${id}:${inp.name}`);
          height += EXPOSED_EXTRA;
          if (cfg?.selectValue === 'lora') height += LORA_BTN_EXTRA;
        }
      }

      const pos = positions.get(id) ?? { x: 0, y: 0 };
      return { id, title: raw._meta?.title ?? raw.class_type, inputs, height, x: pos.x, y: pos.y };
    });

    // Recompute Y per column using live heights so exposed nodes push siblings down
    const cols = new Map<number, typeof nodes>();
    for (const n of nodes) {
      if (!cols.has(n.x)) cols.set(n.x, []);
      cols.get(n.x)!.push(n);
    }
    for (const col of cols.values()) {
      col.sort((a, b) => a.y - b.y);
      let y = 40;
      for (const n of col) {
        n.y = y;
        y += n.height + ROW_GAP;
      }
    }

    return nodes;
  });

  edgePaths = computed<{ d: string; color: string; fromNodeId: string; toNodeId: string }[]>(() => {
    const nodeMap = new Map(this.graphNodes().map((n) => [n.id, n]));
    const exposed = this.exposedMap();
    const paths: { d: string; color: string; fromNodeId: string; toNodeId: string }[] = [];

    for (const node of this.graphNodes()) {
      let rowY = HEADER_H;
      for (const inp of node.inputs) {
        const portY = node.y + rowY + ROW_H / 2;

        if (inp.isConnection && inp.sourceNodeId) {
          const from = nodeMap.get(inp.sourceNodeId);
          if (from) {
            const ox = from.x + NODE_W;
            const oy = from.y + HEADER_H / 2;
            const cp = Math.max(60, Math.abs(node.x - ox) * 0.45);
            paths.push({
              d: `M ${ox} ${oy} C ${ox + cp} ${oy}, ${node.x - cp} ${portY}, ${node.x} ${portY}`,
              color: wireColor(inp.name),
              fromNodeId: inp.sourceNodeId,
              toNodeId: node.id,
            });
          }
        }

        rowY += ROW_H;
        if (!inp.isConnection && exposed.has(`${node.id}:${inp.name}`)) {
          const cfg = exposed.get(`${node.id}:${inp.name}`);
          rowY += EXPOSED_EXTRA;
          if (cfg?.selectValue === 'lora') rowY += LORA_BTN_EXTRA;
        }
      }
    }
    return paths;
  });

  exposedList = computed(() => {
    const entries: { key: string; nodeId: string; config: ExposedConfig }[] = [];
    for (const [key, config] of this.exposedMap()) {
      entries.push({ key, nodeId: key.split(':')[0], config });
    }
    return entries;
  });

  ngOnInit() {
    if (!this.auth.isLoggedIn()) {
      this.router.navigate(['/login']);
      return;
    }

    this.db.getBookServerId(this.bookId).subscribe({
      next: (sid) => {
        this.serverId = sid;
        if (sid) {
          this.db.getServerTunnelStatus(sid, 0).subscribe({
            next: (s) => this.tunnelConnected.set(s.connected),
            error: () => this.tunnelConnected.set(false),
          });
        }
      },
      error: () => {},
    });

    this.loadModels();

    if (this.flowId) {
      this.db.getFlow(this.bookId, this.flowId).subscribe({
        next: (flow) => { this.populateFromFlow(flow); },
        error: () => {},
      });
    }
  }

  // ── Templates ──────────────────────────────────────────────────────────────
  stepBack() {
    const s = this.sidebarStep();
    if (s > 1) this.goToStep((s - 1) as 1 | 2 | 3);
  }

  goToStep(step: 1 | 2 | 3) {
    if (step === 3 && this.templates().length === 0) {
      const id = 'default';
      this.templates.set([{ id, name: 'Default', changes: {} }]);
      if (this.templateInputs().filter((i) => i.required).length > 0) {
        this.openTemplateModal(id);
      }
    }
    this.sidebarStep.set(step);
  }

  addTemplate() {
    const id = crypto.randomUUID();
    const name = `Template ${this.templates().length + 1}`;
    this.templates.update((ts) => [...ts, { id, name, changes: {} }]);
    if (this.templateInputs().filter((i) => i.required).length > 0) {
      this.openTemplateModal(id);
    }
  }

  deleteTemplate(id: string) {
    this.templates.update((ts) => ts.filter((t) => t.id !== id));
  }

  startRename(id: string, name: string) {
    this.renamingTemplateId.set(id);
    this.renameText.set(name);
  }

  commitRename(id: string) {
    const name = this.renameText().trim() || 'Untitled';
    this.templates.update((ts) => ts.map((t) => (t.id === id ? { ...t, name } : t)));
    this.renamingTemplateId.set(null);
  }

  // ── Template modal ─────────────────────────────────────────────────────────
  openTemplateModal(id: string) {
    const tmpl = this.templates().find((t) => t.id === id);
    if (!tmpl) return;
    this.editingName.set(tmpl.name);
    this.editingChanges.set({ ...tmpl.changes });
    this.editingTemplateId.set(id);
    this.copyFromMenuOpen.set(false);
  }

  saveTemplateModal() {
    const id = this.editingTemplateId();
    if (!id) return;
    const name = this.editingName().trim() || 'Untitled';
    const changes = this.editingChanges();
    this.templates.update((ts) =>
      ts.map((t) => (t.id === id ? { ...t, name, changes: { ...changes } } : t))
    );
    this.editingTemplateId.set(null);
  }

  closeTemplateModal() {
    this.editingTemplateId.set(null);
    this.copyFromMenuOpen.set(false);
  }

  copyFromTemplate(sourceId: string) {
    const source = this.templates().find((t) => t.id === sourceId);
    if (!source) return;
    this.editingChanges.set({ ...source.changes });
    this.copyFromMenuOpen.set(false);
  }

  getEditingValue(key: string): string {
    return this.editingChanges()[key] ?? '';
  }

  setEditingValue(key: string, value: string) {
    this.editingChanges.update((c) => ({ ...c, [key]: value }));
  }

  otherTemplates() {
    const id = this.editingTemplateId();
    return this.templates().filter((t) => t.id !== id);
  }

  setTemplateValue(key: string, value: string) {
    const id = this.editingTemplateId();
    if (id) { this.setEditingValue(key, value); return; }
  }

  getTemplateValue(key: string): string {
    return this.getEditingValue(key);
  }

  getApiPlaceholder(key: string): string {
    const [nodeId, inputName] = key.split(':');
    const val = this.apiData()[nodeId]?.inputs?.[inputName];
    return val !== undefined && !Array.isArray(val) ? String(val) : '';
  }

  isNumberType(selectValue: string): boolean {
    return ['number', 'finalImageWidth', 'finalImageHeight'].includes(selectValue);
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  onJsonFileUpload(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.apiJson.set(reader.result as string);
      this.parseJson();
    };
    reader.readAsText(file);
  }

  parseJson() {
    try {
      const data = JSON.parse(this.apiJson());
      if (isWorkflowFormat(data)) {
        this.convertWorkflow(data);
      } else {
        this.applyApiData(data);
      }
    } catch (e: any) {
      this.parseError.set(e.message);
    }
  }

  private convertWorkflow(workflow: WorkflowJsonWithSubgraphs) {
    this.converting.set(true);
    this.parseError.set('');
    this.db.getObjectInfo(this.bookId).subscribe({
      next: (objectInfo) => {
        try {
          const apiData = convertWorkflowWithSubgraphsToApi(workflow, objectInfo);
          this.applyApiData(apiData);
        } catch (e: any) {
          this.parseError.set(e.message);
        }
        this.converting.set(false);
      },
      error: () => {
        this.converting.set(false);
        this.parseError.set(
          'Could not connect to ComfyUI to fetch node schemas — is the tunnel active? Workflow JSON requires a live ComfyUI connection.',
        );
      },
    });
  }

  private applyApiData(data: Record<string, any>) {
    this.apiData.set(data);
    this.nodePositions.set(this.computeLayout(data));
    this.parseError.set('');
    this.jsonPanelOpen.set(false);
    this.panX.set(40);
    this.panY.set(40);
    this.zoom.set(1);
    // Reset wizard state on every new JSON load
    this.sidebarStep.set(1);
    this.templates.set([]);
    this.editingTemplateId.set(null);
    this.presetOptionsKey.set(null);
    this.loraPickerKey.set(null);
    this.runDetection(data);
  }

  private runDetection(data: Record<string, any>) {
    const detected = this.detection.detectConfigurables(data);

    // Identify LoRA nodes (mirrors detection service criteria: class_type contains 'lora'
    // AND both model+clip inputs are node connections). ALL fields on these nodes are
    // excluded — including strength_XX which the service returns as type:'number'.
    const loraNodeIds = new Set<string>();
    for (const nodeId in data) {
      const classType = (data[nodeId]?.class_type ?? '').toLowerCase();
      if (!classType.includes('lora')) continue;
      const inputs = data[nodeId]?.inputs ?? {};
      const hasModelConn = Array.isArray(inputs['model']) && typeof inputs['model'][0] === 'string';
      const hasClipConn = Array.isArray(inputs['clip']) && typeof inputs['clip'][0] === 'string';
      if (hasModelConn && hasClipConn) loraNodeIds.add(nodeId);
    }

    const derived = this.outputDimensions() === 'derived';
    const filtered = detected.filter((d) => {
      const nodeId = d.target.split('/')[1];
      if (loraNodeIds.has(nodeId)) return false;
      if (derived && (d.type === 'finalImageWidth' || d.type === 'finalImageHeight')) return false;
      return true;
    });

    const detMap = new Map<string, DetectedConfigurable>();
    for (const d of filtered) detMap.set(d.target, d);
    this.detectedTargets.set(detMap);

    // Auto-expose all detected configurables
    const newExposed = new Map<string, ExposedConfig>();
    for (const d of filtered) {
      const [, nodeId, , inputName] = d.target.split('/');
      const key = `${nodeId}:${inputName}`;
      newExposed.set(key, {
        name: d.name,
        selectValue: this.detectedToSelectValue(d),
        protected: false,
        visible: true,
        typeLocked: true,
      });
    }
    this.exposedMap.set(newExposed);
  }

  /** Mirrors FlowMaker.getSelectValue — stable types resolve by id, non-stable by type.
   *  inputImage is handled as a special case because it lives outside NODE_TYPES
   *  (Flowmaker hides those rows in step 2 rather than showing them in the type selector). */
  private detectedToSelectValue(d: DetectedConfigurable): string {
    if (d.type === 'inputImage') return 'inputImage';

    const stableMatch = Object.entries(NODE_TYPES).find(
      ([key, cfg]) => cfg.stable && key === d.id,
    );
    if (stableMatch) return stableMatch[0];

    const nonStableMatch = Object.entries(NODE_TYPES).find(
      ([, cfg]) => !cfg.stable && cfg.type === d.type,
    );
    return nonStableMatch?.[0] ?? 'text';
  }

  private computeLayout(data: Record<string, any>): Map<string, { x: number; y: number }> {
    // Build predecessor sets
    const preds = new Map<string, Set<string>>();
    for (const id in data) preds.set(id, new Set());
    for (const id in data) {
      for (const val of Object.values(data[id].inputs ?? {})) {
        if (Array.isArray(val)) preds.get(id)?.add(String((val as any[])[0]));
      }
    }

    // Compute column depth (longest path from any source)
    const depth = new Map<string, number>();
    const getDepth = (id: string, visiting = new Set<string>()): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let d = 0;
      for (const pred of preds.get(id) ?? []) d = Math.max(d, getDepth(pred, visiting) + 1);
      depth.set(id, d);
      return d;
    };
    for (const id in data) getDepth(id);

    // Group by column
    const cols = new Map<number, string[]>();
    for (const [id, d] of depth) {
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d)!.push(id);
    }

    // Assign positions
    const positions = new Map<string, { x: number; y: number }>();
    for (const [col, ids] of cols) {
      let y = 0;
      for (const id of ids) {
        const inputCount = Object.keys(data[id].inputs ?? {}).length;
        const h = HEADER_H + inputCount * ROW_H + NODE_PAD_B;
        positions.set(id, { x: col * (NODE_W + COL_GAP), y });
        y += h + ROW_GAP;
      }
    }
    return positions;
  }

  // ── Expose / unexpose ──────────────────────────────────────────────────────
  startInlineEdit(nodeId: string, inputName: string, currentValue: unknown) {
    this.editingInlineKey.set(`${nodeId}:${inputName}`);
    this.editingInlineValue.set(currentValue != null ? String(currentValue) : '');
  }

  commitInlineEdit(nodeId: string, inputName: string) {
    const raw = this.editingInlineValue();
    this.editingInlineKey.set(null);
    const data = structuredClone(this.apiData());
    if (!data[nodeId]?.inputs) return;
    const original = data[nodeId].inputs[inputName];
    // Preserve numeric type if the original was a number
    data[nodeId].inputs[inputName] = typeof original === 'number' ? Number(raw) : raw;
    this.apiData.set(data);
    this.apiJson.set(JSON.stringify(data, null, 2));
  }

  cancelInlineEdit() {
    this.editingInlineKey.set(null);
  }

  expose(nodeId: string, inputName: string) {
    const target = `/${nodeId}/inputs/${inputName}`;
    const detected = this.detectedTargets().get(target);
    this.exposedMap.update((m) => {
      const next = new Map(m);
      next.set(`${nodeId}:${inputName}`, {
        name: detected?.name ?? this.toFriendlyName(inputName),
        selectValue: detected ? this.detectedToSelectValue(detected) : 'text',
        protected: false,
        visible: true,
        typeLocked: false,
      });
      return next;
    });
  }

  unexpose(nodeId: string, inputName: string) {
    this.exposedMap.update((m) => {
      const next = new Map(m);
      next.delete(`${nodeId}:${inputName}`);
      return next;
    });
  }

  openLoraPicker(key: string) {
    this.loraPickerKey.set(key);
    const existing = new Set(this.exposedMap().get(key)?.presets ?? []);

    if (!this.serverId) {
      this.loraPicker.set({ items: [], selected: existing });
      return;
    }

    this.loraLoading.set(true);
    this.db.listFiles(this.serverId, 'loras', true).subscribe({
      next: (entries) => {
        const items = entries
          .filter((e) => e.type === 'file' && e.path.includes('.'))
          .map((e) => e.path.replace(/\\/g, '/'));
        const selected = existing.size ? existing : new Set(items);
        this.loraPicker.set({ items, selected });
        this.loraLoading.set(false);
      },
      error: () => {
        this.loraPicker.set({ items: [], selected: existing });
        this.loraLoading.set(false);
      },
    });
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

  setAllLoraSelections(value: boolean) {
    this.loraPicker.update((p) => {
      if (!p) return p;
      return { ...p, selected: value ? new Set(p.items) : new Set() };
    });
  }

  saveLoraPicker() {
    const key = this.loraPickerKey();
    const picker = this.loraPicker();
    if (!key || !picker) return;
    const presets = picker.items.filter((i) => picker.selected.has(i));
    this.exposedMap.update((m) => {
      const next = new Map(m);
      const existing = next.get(key);
      if (existing) next.set(key, { ...existing, presets });
      return next;
    });
    this.loraPickerKey.set(null);
    this.loraPicker.set(null);
  }

  closeLoraPicker() {
    this.loraPickerKey.set(null);
    this.loraPicker.set(null);
  }

  // ── Preset options editor ───────────────────────────────────────────────────
  openPresetOptions(key: string) {
    const existing = this.exposedMap().get(key)?.presets ?? [];
    this.presetOptionsText.set(existing.join('\n'));
    this.presetOptionsKey.set(key);
  }

  savePresetOptions() {
    const key = this.presetOptionsKey();
    if (!key) return;
    const presets = this.presetOptionsText()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    this.exposedMap.update((m) => {
      const next = new Map(m);
      const existing = next.get(key);
      if (existing) next.set(key, { ...existing, presets });
      return next;
    });
    this.presetOptionsKey.set(null);
  }

  closePresetOptions() {
    this.presetOptionsKey.set(null);
  }

  insertPresets(items: string[]) {
    this.presetOptionsText.set(items.join('\n'));
  }

  private loadModels() {
    this.db.getModelList(this.bookId, 'checkpoints').subscribe({ next: (l) => (this.models.checkpoints = l), error: () => {} });
    this.db.getModelList(this.bookId, 'text_encoders').subscribe({ next: (l) => (this.models.textEncoders = l), error: () => {} });
    this.db.getModelList(this.bookId, 'diffusion_models').subscribe({ next: (l) => (this.models.diffusionModels = l), error: () => {} });
    this.db.getModelList(this.bookId, 'clip_vision').subscribe({ next: (l) => (this.models.clipVisions = l), error: () => {} });
    this.db.getModelList(this.bookId, 'controlnet').subscribe({ next: (l) => (this.models.controlnets = l), error: () => {} });
    this.db.getModelList(this.bookId, 'model_patches').subscribe({ next: (l) => (this.models.modelPatches = l), error: () => {} });
  }

  // ── LoRA template selection ─────────────────────────────────────────────────
  /** Parse the template value for a lora input into a Set of selected names */
  getTemplateLoraSet(key: string): Set<string> {
    const raw = this.getTemplateValue(key);
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed);
    } catch {}
    return new Set();
  }

  toggleTemplateLora(key: string, lora: string) {
    const current = this.getTemplateLoraSet(key);
    if (current.has(lora)) current.delete(lora);
    else current.add(lora);
    this.setTemplateValue(key, JSON.stringify([...current]));
  }

  focusNode(nodeId: string) {
    const node = this.graphNodes().find((n) => n.id === nodeId);
    if (!node) return;

    const canvas = this.canvasEl.nativeElement;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const z = this.zoom();

    this.panX.set(cw / 2 - (node.x + NODE_W / 2) * z);
    this.panY.set(ch / 2 - (node.y + node.height / 2) * z);

    this.flashingNodeId.set(nodeId);
    setTimeout(() => this.flashingNodeId.set(null), 1000);
  }

  updateName(nodeId: string, inputName: string, name: string) {
    this.exposedMap.update((m) => {
      const next = new Map(m);
      const existing = next.get(`${nodeId}:${inputName}`);
      if (existing) next.set(`${nodeId}:${inputName}`, { ...existing, name });
      return next;
    });
  }

  updateType(nodeId: string, inputName: string, selectValue: string) {
    this.exposedMap.update((m) => {
      const next = new Map(m);
      const existing = next.get(`${nodeId}:${inputName}`);
      if (existing) next.set(`${nodeId}:${inputName}`, { ...existing, selectValue });
      return next;
    });
  }

  toggleProtected(nodeId: string, inputName: string) {
    this.exposedMap.update((m) => {
      const next = new Map(m);
      const existing = next.get(`${nodeId}:${inputName}`);
      if (existing)
        next.set(`${nodeId}:${inputName}`, { ...existing, protected: !existing.protected });
      return next;
    });
  }

  toggleVisible(nodeId: string, inputName: string) {
    this.exposedMap.update((m) => {
      const next = new Map(m);
      const existing = next.get(`${nodeId}:${inputName}`);
      if (existing)
        next.set(`${nodeId}:${inputName}`, { ...existing, visible: !existing.visible });
      return next;
    });
  }

  toggleTypeLocked(nodeId: string, inputName: string) {
    this.exposedMap.update((m) => {
      const next = new Map(m);
      const existing = next.get(`${nodeId}:${inputName}`);
      if (existing)
        next.set(`${nodeId}:${inputName}`, { ...existing, typeLocked: !existing.typeLocked });
      return next;
    });
  }

  // ── Queries ────────────────────────────────────────────────────────────────
  isExposed(nodeId: string, inputName: string) {
    return this.exposedMap().has(`${nodeId}:${inputName}`);
  }

  getConfig(nodeId: string, inputName: string): ExposedConfig | undefined {
    return this.exposedMap().get(`${nodeId}:${inputName}`);
  }

  /** CSS data-type value for type-tag coloring */
  getTypeCategory(nodeId: string, inputName: string): string {
    const sv = this.exposedMap().get(`${nodeId}:${inputName}`)?.selectValue ?? '';
    return TYPE_CATEGORY[sv] ?? 'text';
  }

  isDetected(nodeId: string, inputName: string): DetectedConfigurable | undefined {
    return this.detectedTargets().get(`/${nodeId}/inputs/${inputName}`);
  }

  hasDetectedInput(node: GraphNode): boolean {
    return node.inputs.some((inp) =>
      this.detectedTargets().has(`/${node.id}/inputs/${inp.name}`),
    );
  }

  hasExposedInput(node: GraphNode): boolean {
    return node.inputs.some((inp) => this.exposedMap().has(`${node.id}:${inp.name}`));
  }

  // ── Canvas interactions ────────────────────────────────────────────────────
  get worldTransform() {
    return `translate(${this.panX()}px, ${this.panY()}px) scale(${this.zoom()})`;
  }

  onWheel(e: WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    this.zoom.update((z) => Math.min(2.5, Math.max(0.15, z * factor)));
  }

  onCanvasMouseDown(e: MouseEvent) {
    this.panning = true;
    this.panStartX = e.clientX;
    this.panStartY = e.clientY;
    this.panStartPanX = this.panX();
    this.panStartPanY = this.panY();
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      this.searchInputRef?.nativeElement.focus();
      this.searchInputRef?.nativeElement.select();
    }
  }

  @HostListener('window:mousemove', ['$event'])
  onMouseMove(e: MouseEvent) {
    if (this.panning) {
      this.panX.set(this.panStartPanX + (e.clientX - this.panStartX));
      this.panY.set(this.panStartPanY + (e.clientY - this.panStartY));
    }
  }

  @HostListener('window:mouseup')
  onMouseUp() {
    this.panning = false;
  }

  trackById(_: number, item: GraphNode) {
    return item.id;
  }

  private toFriendlyName(inputName: string): string {
    return inputName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ── Flow save / load ───────────────────────────────────────────────────────

  /** Convert selectValue to Configurable type */
  private selectValueToType(sv: string): Configurable['type'] {
    const map: Record<string, Configurable['type']> = {
      positivePrompt: 'core', negativePrompt: 'core', seed: 'core',
      number: 'number',
      finalImageWidth: 'finalImageWidth', finalImageHeight: 'finalImageHeight',
      text: 'text', multilineText: 'multilineText',
      preset: 'preset', lora: 'lora', inputImage: 'inputImage',
    };
    return map[sv] ?? 'text';
  }

  /** Matches flowmaker's toIdString exactly */
  toIdString(str: string, stable = false): string {
    const base = str.trim().toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .map((word, index) => index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
    return stable ? base : `${base}_${Math.random().toString(36).slice(2)}`;
  }

  /** Build a FlowConfig from current state */
  buildFlowConfig(): FlowConfig {
    const exposed = this.exposedMap();
    const apiData = this.apiData();
    const keyToId = new Map<string, string>();

    const configurables: Configurable[] = [];
    for (const [key, config] of exposed.entries()) {
      const [nodeId, inputName] = key.split(':');
      const target = `/${nodeId}/inputs/${inputName}`;
      const isStable = ['positivePrompt', 'negativePrompt', 'seed',
        'finalImageWidth', 'finalImageHeight'].includes(config.selectValue);
      const id = isStable
        ? config.selectValue
        : this.toIdString(`${config.selectValue}_${target}`, true);
      keyToId.set(key, id);
      configurables.push({
        id, visible: config.visible ?? true, protected: config.protected ?? false,
        name: config.name, target, type: this.selectValueToType(config.selectValue),
        ...(config.presets?.length ? { presets: config.presets } : {}),
        selectValue: config.selectValue,
      });
    }

    const flowTemplates: FlowTemplate[] = this.templates().map(tmpl => {
      const changes: { configId: string; value?: string }[] = [];
      for (const [key, value] of Object.entries(tmpl.changes)) {
        if (!value?.trim() && exposed.get(key)?.selectValue !== 'lora') continue;
        const id = keyToId.get(key);
        if (id) changes.push({ configId: id, value });
      }
      return {
        id: tmpl.id, name: tmpl.name, description: '',
        protected: false,
        promptTemplates: [],
        changes,
      };
    });

    return {
      name: this.flowName(), description: this.flowDescription(),
      configurables, templates: flowTemplates, apiData,
      outputDimensions: this.outputDimensions(),
    };
  }

  /** Populate state from an existing FlowConfig (edit mode) */
  private populateFromFlow(flow: FlowConfig) {
    this.flowName.set(flow.name);
    this.flowDescription.set(flow.description ?? '');
    this.outputDimensions.set(flow.outputDimensions ?? 'fixed');
    this.apiData.set(flow.apiData);
    this.apiJson.set(JSON.stringify(flow.apiData, null, 2));
    this.nodePositions.set(this.computeLayout(flow.apiData));

    // Run detection first so detectedTargets is populated (used for UI hints),
    // but we'll overwrite exposedMap below with the saved configurables.
    this.runDetection(flow.apiData);

    // Rebuild exposedMap from saved configurables
    const newExposed = new Map<string, ExposedConfig>();
    const idToKey = new Map<string, string>();
    for (const cfg of flow.configurables) {
      if (!cfg.target) continue;
      const parts = cfg.target.split('/').filter(Boolean); // ['7','inputs','inputName']
      if (parts.length < 3) continue;
      const key = `${parts[0]}:${parts[2]}`;
      const sv = (cfg as any).selectValue ?? cfg.type;
      newExposed.set(key, {
        name: cfg.name, selectValue: sv,
        visible: cfg.visible, protected: cfg.protected,
        typeLocked: true, presets: cfg.presets,
      });
      idToKey.set(cfg.id, key);
    }
    this.exposedMap.set(newExposed);

    // Rebuild TemplateEntry[] from FlowTemplate[]
    const tmplEntries: TemplateEntry[] = flow.templates.map(tmpl => {
      const changes: Record<string, string> = {};
      for (const ch of tmpl.changes) {
        if (!ch.value) continue;
        const key = idToKey.get(ch.configId);
        if (key) changes[key] = ch.value;
      }
      return { id: tmpl.id, name: tmpl.name, changes };
    });
    this.templates.set(tmplEntries);
  }

  /** Validate and save */
  finalize() {
    const cfg = this.buildFlowConfig();
    if (!cfg.name.trim()) { this.saveError.set('Flow name is required.'); return; }
    const { complete, total } = this.templatesStatus();
    if (total === 0 || complete < total) {
      this.saveError.set(`All templates must be fully filled in (${complete}/${total} complete).`);
      return;
    }
    this.saveError.set('');
    this.saving.set(true);

    const obs = this.updateMode
      ? this.db.updateFlow(this.bookId, this.flowId!, cfg)
      : this.db.createFlow(this.bookId, cfg);

    obs.subscribe({
      next: () => {
        this.saving.set(false);
        const verb = this.updateMode ? 'updated' : 'created';
        this.dialog.alert(
          `Flow ${verb} successfully!<br><br>` +
          `<a href='/books/${this.bookId}' class='link'>→ Go to Book</a><br>` +
          `<a href='/books' class='link'>← Back to Books</a>`
        );
      },
      error: (err: any) => {
        this.saving.set(false);
        this.saveError.set(err?.error?.message ?? 'Failed to save flow.');
      },
    });
  }
}
