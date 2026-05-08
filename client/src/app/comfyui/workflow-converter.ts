/** Converts a ComfyUI non-API (workflow) JSON to the API JSON format.
 *
 * The non-API format stores widget values as an anonymous ordered array
 * (`widgets_values`) and uses a `links` table for connections. The API format
 * uses named keys and represents connections as `[sourceNodeId, outputIndex]`.
 *
 * Converting requires the node schemas from ComfyUI's `/object_info` endpoint
 * so that widget values can be matched to their field names.
 */

// ── Workflow (non-API) types ─────────────────────────────────────────────────

export interface WorkflowJson {
  nodes: WorkflowNode[];
  /** [linkId, srcNodeId, srcOutIdx, dstNodeId, dstInIdx, type] */
  links: [number, number, number, number, number, string][];
}

export interface WorkflowNode {
  id: number;
  type: string;
  title?: string;
  inputs?: { name: string; type: string; link: number | null; widget?: { name: string } }[];
  widgets_values?: unknown[];
}

// ── Subgraph types ───────────────────────────────────────────────────────────

/** Object-format link used inside subgraph definitions (unlike the outer tuple format). */
interface SubgraphLink {
  id: number;
  origin_id: number;
  origin_slot: number;
  target_id: number;
  target_slot: number;
  type: string;
}

interface SubgraphBoundaryNode {
  id: number; // -10 = input boundary, -20 = output boundary
}

interface SubgraphPortDef {
  id: string;
  name: string;
  type: string;
  linkIds: number[];
}

interface SubgraphDef {
  id: string; // UUID — matches the type field on subgraph instance nodes
  name: string;
  inputNode: SubgraphBoundaryNode;
  outputNode: SubgraphBoundaryNode;
  inputs: SubgraphPortDef[];
  outputs: SubgraphPortDef[];
  nodes: WorkflowNode[];
  links: SubgraphLink[];
}

/** WorkflowJson extended with optional subgraph definitions block. */
export interface WorkflowJsonWithSubgraphs extends WorkflowJson {
  definitions?: { subgraphs?: SubgraphDef[] };
}

// ── object_info schema types ─────────────────────────────────────────────────

export interface NodeSchema {
  input: {
    required?: Record<string, InputDef>;
    optional?: Record<string, InputDef>;
  };
}

/** [typeOrEnum, metadata?] — typeOrEnum is a string or an array (enum options) */
export type InputDef = [string | string[], Record<string, unknown>?];

export type ObjectInfo = Record<string, NodeSchema>;

// ── Widget-type detection ────────────────────────────────────────────────────

/** Primitive types that always consume a value from widgets_values */
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);

/** Values the ComfyUI frontend emits for the control_after_generate dropdown */
const CONTROL_AFTER_GENERATE_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize']);

function isWidgetType(def: InputDef): boolean {
  const type = def[0];
  if (Array.isArray(type)) return true; // inline enum list
  return WIDGET_TYPES.has(type);
}

/**
 * Returns true if the slot following an INT widget's value looks like a
 * control_after_generate dropdown. Some custom nodes omit the flag from their
 * object_info schema but the ComfyUI frontend still writes the control value
 * into widgets_values, so we detect it heuristically.
 */
function peekIsControlAfterGenerate(def: InputDef, widgetValues: unknown[], nextIdx: number): boolean {
  // Only INT inputs can have a control_after_generate companion
  if (Array.isArray(def[0]) || def[0] !== 'INT') return false;
  const next = widgetValues[nextIdx];
  return typeof next === 'string' && CONTROL_AFTER_GENERATE_VALUES.has(next);
}

// ── Converter ────────────────────────────────────────────────────────────────

export function convertWorkflowToApi(
  workflow: WorkflowJson,
  objectInfo: ObjectInfo,
): Record<string, unknown> {
  // Build link map: linkId → [sourceNodeId (string), sourceOutputIndex]
  const linkMap = new Map<number, [string, number]>();
  for (const [linkId, srcNodeId, srcOutIdx] of workflow.links) {
    linkMap.set(linkId, [String(srcNodeId), srcOutIdx]);
  }

  const result: Record<string, unknown> = {};

  for (const node of workflow.nodes) {
    const schema = objectInfo[node.type];

    if (!schema) {
      // Unknown node type — include as-is with no inputs
      result[String(node.id)] = {
        inputs: {},
        class_type: node.type,
        _meta: { title: node.title ?? node.type },
      };
      continue;
    }

    // Map input slot names to their link references for this node.
    // Also track which linked inputs are connectable widgets — they still occupy
    // a slot in widgets_values even when connected and must advance wIdx.
    const linkedInputs = new Map<string, [string, number]>();
    const connectedWidgetNames = new Set<string>();
    for (const slot of node.inputs ?? []) {
      if (slot.link != null) {
        const ref = linkMap.get(slot.link);
        if (ref) linkedInputs.set(slot.name, ref);
        if (slot.widget) connectedWidgetNames.add(slot.name);
      }
    }

    const allInputDefs: [string, InputDef][] = [
      ...Object.entries(schema.input.required ?? {}),
      ...Object.entries(schema.input.optional ?? {}),
    ];

    const widgetValues = [...(node.widgets_values ?? [])];
    let wIdx = 0;
    const apiInputs: Record<string, unknown> = {};

    for (const [inputName, inputDef] of allInputDefs) {
      if (linkedInputs.has(inputName)) {
        apiInputs[inputName] = linkedInputs.get(inputName);
        // Connected widgets still occupy a slot in widgets_values — advance past it
        if (connectedWidgetNames.has(inputName) && isWidgetType(inputDef)) {
          wIdx++;
          const meta = inputDef[1];
          const schemaControl = meta && typeof meta === 'object' && meta['control_after_generate'];
          if (schemaControl || peekIsControlAfterGenerate(inputDef, widgetValues, wIdx)) wIdx++;
          if (meta && typeof meta === 'object' && meta['image_upload']) wIdx++;
        }
        continue;
      }

      if (isWidgetType(inputDef)) {
        apiInputs[inputName] = widgetValues[wIdx++];

        const meta = inputDef[1];
        const schemaControl = meta && typeof meta === 'object' && meta['control_after_generate'];
        // "randomize" / "increment" etc. control widget — consume but omit.
        // Also detect heuristically for custom nodes that omit the flag from their schema.
        if (schemaControl || peekIsControlAfterGenerate(inputDef, widgetValues, wIdx)) wIdx++;
        // Upload-type hidden widget after image file selectors — consume but omit
        if (meta && typeof meta === 'object' && meta['image_upload']) wIdx++;
      }
      // Unconnected connection-type input (optional, not wired up) → skip
    }

    result[String(node.id)] = {
      inputs: apiInputs,
      class_type: node.type,
      _meta: { title: node.title ?? node.type },
    };
  }

  return result;
}

// ── Subgraph flattening ───────────────────────────────────────────────────────

/**
 * Expands all subgraph instance nodes in a workflow into their constituent
 * nodes and links, rewiring the boundary connections so the result is a flat
 * WorkflowJson that `convertWorkflowToApi` can process directly.
 *
 * Node and link IDs in ComfyUI subgraph workflows share a single global
 * numbering space, so no ID offsetting is required.
 *
 * Handles one level of nesting per call; call repeatedly (or use
 * `convertWorkflowWithSubgraphsToApi`) for deeply nested subgraphs.
 */
export function flattenSubgraphs(workflow: WorkflowJsonWithSubgraphs): WorkflowJson {
  const defs = workflow.definitions?.subgraphs;
  if (!defs?.length) return workflow;

  const defMap = new Map(defs.map((d) => [d.id, d]));

  let resultNodes: WorkflowNode[] = [...workflow.nodes];
  const resultLinks: [number, number, number, number, number, string][] = workflow.links.map(
    (l) => [l[0], l[1], l[2], l[3], l[4], l[5]],
  );

  // Loop until no subgraph instances remain. Each iteration handles one depth
  // level, so nested subgraphs (a subgraph whose nodes contain another subgraph
  // instance) are resolved naturally in subsequent passes.
  while (true) {
    const sgInstances = resultNodes.filter((n) => defMap.has(n.type));
    if (sgInstances.length === 0) break;

    // Remove this batch of subgraph instances; their inlined nodes are added
    // below and will be picked up by the next iteration if they are themselves
    // subgraph instances.
    resultNodes = resultNodes.filter((n) => !defMap.has(n.type));

    // Phase 1 — Rewire outputs for all instances in this batch before touching
    // inputs. This ensures that when multiple subgraph instances are wired
    // together (one's output feeds another's input), the source links have
    // already been redirected to real nodes before Phase 2 reads them.
    for (const sgNode of sgInstances) {
      const def = defMap.get(sgNode.type)!;
      for (let slotIdx = 0; slotIdx < def.outputs.length; slotIdx++) {
        const feed = def.links.find(
          (l) => l.target_id === def.outputNode.id && l.target_slot === slotIdx,
        );
        if (!feed) continue;
        for (const lnk of resultLinks) {
          if (lnk[1] === sgNode.id && lnk[2] === slotIdx) {
            lnk[1] = feed.origin_id;
            lnk[2] = feed.origin_slot;
          }
        }
      }
    }

    // Phase 2 — Rewire inputs and inline nodes/links.
    //
    // Input rewiring: preserve the internal link IDs (which internal nodes
    // reference in their `inputs[].link` fields) and inject them into
    // resultLinks with the external source substituted in. A single input slot
    // can fan out to multiple internal targets, so use `.filter()` not `.find()`.
    for (const sgNode of sgInstances) {
      const def = defMap.get(sgNode.type)!;

      for (let slotIdx = 0; slotIdx < def.inputs.length; slotIdx++) {
        const outerLink = resultLinks.find((l) => l[3] === sgNode.id && l[4] === slotIdx);
        if (!outerLink) continue;
        const [, srcNodeId, srcSlot] = outerLink;

        const internalFeeds = def.links.filter(
          (l) => l.origin_id === def.inputNode.id && l.origin_slot === slotIdx,
        );
        for (const feed of internalFeeds) {
          resultLinks.push([feed.id, srcNodeId, srcSlot, feed.target_id, feed.target_slot, feed.type]);
        }
      }

      for (const node of def.nodes) {
        if (node.id >= 0) resultNodes.push(node);
      }

      for (const lnk of def.links) {
        if (lnk.origin_id < 0 || lnk.target_id < 0) continue;
        resultLinks.push([lnk.id, lnk.origin_id, lnk.origin_slot, lnk.target_id, lnk.target_slot, lnk.type]);
      }
    }
  }

  return { nodes: resultNodes, links: resultLinks };
}

/**
 * Convenience wrapper: flattens any subgraphs in the workflow first, then
 * delegates to `convertWorkflowToApi`. Safe to call on workflows that have no
 * subgraphs — `flattenSubgraphs` is a no-op in that case.
 */
export function convertWorkflowWithSubgraphsToApi(
  workflow: WorkflowJsonWithSubgraphs,
  objectInfo: ObjectInfo,
): Record<string, unknown> {
  return convertWorkflowToApi(flattenSubgraphs(workflow), objectInfo);
}

// ── Format detection ─────────────────────────────────────────────────────────

/** Returns true if the value looks like a ComfyUI workflow (non-API) JSON. */
export function isWorkflowFormat(json: unknown): json is WorkflowJsonWithSubgraphs {
  if (!json || typeof json !== 'object') return false;
  const obj = json as Record<string, unknown>;
  return Array.isArray(obj['nodes']) && Array.isArray(obj['links']);
}
