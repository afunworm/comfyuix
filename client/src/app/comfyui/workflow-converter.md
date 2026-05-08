# ComfyUI Workflow → API JSON Conversion

## Background: Two JSON Formats

ComfyUI has two distinct JSON formats for the same workflow.

**Workflow JSON** — what the ComfyUI frontend saves to disk. Human-readable-ish. Nodes carry an anonymous array of widget values (`widgets_values`) in the order the UI rendered them. Connections are stored in a separate flat `links` table rather than inline on each node.

**API JSON** — what ComfyUI's `/prompt` endpoint actually executes. Each node is keyed by its ID, widget values are named (`{ "steps": 20, "cfg": 7 }`), and connections are represented inline as `[sourceNodeId, outputSlotIndex]` tuples.

ComfyUIX only stores the API format (`flow_data`). When a user imports a workflow JSON, it must be converted first.

---

## Scenario 1: Plain API JSON

The user pastes or uploads a file that is already in API format (no `nodes` or `links` arrays at the top level). `isWorkflowFormat()` returns `false` and the data is used as-is — no conversion needed.

---

## Scenario 2: Workflow JSON (no subgraphs)

The file has a top-level `nodes` array and a top-level `links` array. `isWorkflowFormat()` returns `true`. `convertWorkflowWithSubgraphsToApi()` is called, which delegates straight to `convertWorkflowToApi()` because there are no subgraph definitions.

### How `convertWorkflowToApi` works

**Step 1 — Build a link map.**
The `links` array contains tuples of the form `[linkId, srcNodeId, srcOutputSlot, dstNodeId, dstInputSlot, type]`. We index these by `linkId` so we can later look up "what is connected to this input?" in O(1).

```
links: [[10, 4, 0, 7, 0, "LATENT"], ...]
→ linkMap: { 10 → ["4", 0], ... }
```

**Step 2 — Process each node.**
For each node, the converter needs to produce a named-input object. This requires the node's schema from ComfyUI's `/object_info` endpoint (fetched live), which lists every input in order and whether it is a "widget" (holds a literal value) or a "connection" (receives a link from another node).

For each input defined in the schema (required first, then optional):

- **Connected input** — the node's `inputs[]` array has an entry for this name with a non-null `link` ID. Look that link ID up in the link map → emit `[srcNodeId, srcOutputSlot]`.
- **Widget input** — no link; consume the next value from `widgets_values` by advancing an index (`wIdx`).
- **Unconnected optional connection** — no link, not a widget type; skip it entirely (it simply won't appear in the API output).

**Step 3 — Handle hidden companion widgets.**
Two special hidden values can follow a widget value in `widgets_values` without appearing in the schema's visible inputs:

- **`control_after_generate`** — follows every `INT` seed widget. Values are `"fixed"`, `"randomize"`, `"increment"`, or `"decrement"`. The converter detects this either from the schema flag or heuristically (if the next `widgets_values` slot is one of those strings). The value is consumed but not emitted in the API output.
- **`image_upload`** — follows image-type inputs on nodes like `LoadImage`. Same: consumed but not emitted.

These hidden slots must be consumed to keep `wIdx` aligned with the remaining widget values.

**Step 4 — Unknown node types.**
If a node's `type` has no entry in `objectInfo` (e.g. a custom node not installed, or a subgraph UUID that wasn't flattened), the node is emitted with an empty `inputs: {}`. It won't crash the conversion but it also won't be wired up correctly.

---

## Scenario 3: Workflow JSON with Subgraphs

Newer ComfyUI versions (renderer version "LG") support **subgraphs** — reusable node groups that appear as a single collapsed node in the outer graph. The JSON looks like this:

```
{
  "nodes": [ ... ],   ← outer graph nodes, some have UUID types
  "links": [ ... ],   ← outer graph connections
  "definitions": {
    "subgraphs": [    ← one entry per unique subgraph type
      { "id": "uuid-A", "nodes": [...], "links": [...], "inputs": [...], "outputs": [...] },
      { "id": "uuid-B", ... }
    ]
  }
}
```

A subgraph **instance** is an outer-graph node whose `type` field is a UUID matching a subgraph definition. It has real inputs and outputs just like any other node, but its internal logic is hidden inside the definition.

`convertWorkflowWithSubgraphsToApi()` calls `flattenSubgraphs()` first, which expands all subgraph instances into ordinary nodes and links, producing a plain `WorkflowJson` that `convertWorkflowToApi()` can handle normally.

### How `flattenSubgraphs` works

The core idea: replace each subgraph instance node with the nodes inside its definition, and rewire the links that crossed the subgraph boundary.

Each subgraph definition has two invisible **boundary nodes**:
- **Input boundary** (`id: -10`) — represents the subgraph's input ports. Internal links originate here.
- **Output boundary** (`id: -20`) — represents the subgraph's output ports. Internal links terminate here.

The algorithm runs in a `while` loop to handle arbitrary nesting depth. Each iteration processes all subgraph instances currently visible in `resultNodes`. If newly inlined nodes are themselves subgraph instances, the next iteration picks them up.

#### Per-iteration steps

**Remove subgraph instances from `resultNodes`.**
They will be replaced by their internal nodes.

**Phase 1 — Rewire outputs (for all instances, before touching any inputs).**

For each output slot of each subgraph instance:
1. Find the internal link that flows *into* the output boundary at that slot (e.g. `VAEDecode → -20[slot 0]`).
2. Find all outer links whose *source* is the subgraph instance at that slot.
3. Redirect those outer links to use the internal node as their source instead.

```
Before: outer link [437, sgNode=288, slot=0] → SaveImage
After:  outer link [437, VAEDecode=282, slot=0] → SaveImage
```

This phase runs for **all instances** before Phase 2 starts. This matters when two subgraph instances are wired together (one's output feeds another's input): by the time Phase 2 runs, the source links from the producer subgraph have already been redirected to real nodes.

**Phase 2 — Rewire inputs and inline nodes/links.**

For each input slot of each subgraph instance:
1. Find the outer link whose *destination* is the subgraph instance at that slot — this tells us the external source (`srcNodeId`, `srcSlot`).
2. Find **all** internal links that originate from the input boundary at that slot (one input can fan out to multiple internal nodes — e.g. a MODEL input going to both CFGGuider and BasicScheduler).
3. For each such internal link, add a new entry to `resultLinks` with the external source substituted in, keeping the **original internal link ID** intact.

Preserving the internal link IDs is critical: internal nodes reference them in their own `inputs[].link` fields. The converter builds a link map keyed by link ID, so these IDs must match what the internal nodes expect.

```
Internal link 422: -10[slot 0] → CFGGuider[slot 0]
Internal link 425: -10[slot 0] → BasicScheduler[slot 0]
Outer link 441: UNETLoader[0] → sgNode[slot 0]

→ Add to resultLinks:
    [422, UNETLoader=283, slot=0, CFGGuider=278,      slot=0]
    [425, UNETLoader=283, slot=0, BasicScheduler=280, slot=0]
```

Then inline all internal nodes (skipping boundary nodes with negative IDs) and all internal links that don't touch a boundary node. The boundary-touching internal links are not added because they've been superseded by the injected entries above.

#### After the while loop

`resultNodes` and `resultLinks` contain only real nodes and links with no subgraph instances remaining. This is passed directly to `convertWorkflowToApi()`.

---

## Summary Table

| Input format | Subgraphs | Path taken |
|---|---|---|
| API JSON | — | Used as-is |
| Workflow JSON | None | `convertWorkflowToApi` directly |
| Workflow JSON | Flat (1 level) | `flattenSubgraphs` (1 iteration) → `convertWorkflowToApi` |
| Workflow JSON | Nested (N levels) | `flattenSubgraphs` (N iterations) → `convertWorkflowToApi` |

---

## Why a live ComfyUI connection is required

`convertWorkflowToApi` needs `/object_info` to know which inputs are widgets vs connections, and in what order. Without it, the `widgets_values` array can't be mapped to named fields. This is why importing a workflow JSON fails when the tunnel is disconnected.

API JSON does not have this limitation — it already has named inputs and doesn't need schema lookup.
