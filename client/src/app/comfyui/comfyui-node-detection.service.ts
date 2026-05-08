import { Injectable } from "@angular/core";
import { Configurable } from "../types/flow.type";

export interface QuickFlowDetection {
	/** Node ID of the single LoadImage node, or null if 0 or >1 found. */
	imageNodeId: string | null;
	/** Node ID of the seed/noise node, or null if not found. */
	seedNodeId: string | null;
	/** Node ID of the positive-prompt CLIPTextEncode node, or null if not found. */
	positivePromptNodeId: string | null;
	/** Non-null on parse failure, missing SaveImage, or wrong image node count. */
	error: string | null;
}

/**
 * Represents a configurable that was found by traversing the ComfyUI node graph,
 * together with the user's acceptance state and whether the item is mandatory.
 */
export type DetectedConfigurable = {
	/** Unique ID this will get when converted to a real Configurable (e.g. 'positivePrompt'). */
	id: string;
	/** The Configurable.type this item maps to when accepted by the user. */
	type: Configurable["type"];
	/** Human-friendly display name shown in the review panel. */
	name: string;
	/** Slash-path into apiData used as the configurable target, e.g. '/28/inputs/text'. */
	target: string;
	/** Whether the user has checked this item for inclusion. Required items default to true; optional items default to false. */
	accepted: boolean;
	/** When true the review checkbox is disabled — positivePrompt and seed are always required. */
	required: boolean;
	/** The _meta.title of the source node, shown in bold next to the path so users can identify it. */
	nodeTitle?: string;
};

/**
 * Shared ComfyUI node-graph detection helpers.
 * Contains the BFS traversal logic and full configurable detection used by both
 * FlowMaker (full detection) and the Quick Flow maker (simplified wrapper).
 */
@Injectable({ providedIn: "root" })
export class ComfyNodeDetectionService {
	/**
	 * Traverses the ComfyUI node graph starting from the SaveImage node backwards
	 * through all inputs. Returns a pre-populated, pre-accepted list of
	 * DetectedConfigurables, or [] when the workflow layout is non-standard or unsupported.
	 */
	detectConfigurables(apiData: any): DetectedConfigurable[] {
		const allNodeIds = Object.keys(apiData);

		// ── 1. Find SaveImage nodes ───────────────────────────────────────────
		const saveImageNodes = allNodeIds.filter(
			(id) => apiData[id]?.class_type === "SaveImage",
		);
		if (saveImageNodes.length === 0) return [];

		const connectedSaveImages = saveImageNodes.filter((id) => {
			const inputs = apiData[id]?.inputs ?? {};
			return Object.values(inputs).some(
				(v) => Array.isArray(v) && typeof (v as any[])[0] === "string",
			);
		});

		if (connectedSaveImages.length === 0) return [];

		if (connectedSaveImages.length > 1) {
			// Multiple connected SaveImage nodes — cannot reliably determine which output
			// the user cares about, so bail rather than guess wrong.
			return [];
		}

		const saveImageId = connectedSaveImages[0];

		// ── 2. Build reachable set ────────────────────────────────────────────
		const reachable = this.buildReachableSet(apiData, saveImageId);

		// ── 3. Build consumer map ─────────────────────────────────────────────
		const consumers = this.buildConsumerMap(apiData, reachable);

		const result: DetectedConfigurable[] = [];

		// ── 4. Detect SEED ────────────────────────────────────────────────────
		// The noise seed is a very large integer (> 1 000 000) stored on a
		// noise-related node. Prefer a node whose class_type contains 'noise'
		// (e.g. RandomNoise in SDXL / Flux workflows).
		let seedTarget: string | null = null;

		for (const nodeId of reachable) {
			if (seedTarget) break;
			const classType: string = (apiData[nodeId]?.class_type ?? "").toLowerCase();
			if (!classType.includes("noise")) continue;
			const inputs = apiData[nodeId]?.inputs ?? {};
			for (const [field, value] of Object.entries(inputs)) {
				if (
					typeof value === "number" &&
					Number.isInteger(value) &&
					value > 1_000_000
				) {
					seedTarget = `/${nodeId}/inputs/${field}`;
					break;
				}
			}
		}

		if (!seedTarget) {
			for (const nodeId of reachable) {
				if (seedTarget) break;
				const inputs = apiData[nodeId]?.inputs ?? {};
				for (const [field, value] of Object.entries(inputs)) {
					if (
						typeof value === "number" &&
						Number.isInteger(value) &&
						value > 1_000_000
					) {
						seedTarget = `/${nodeId}/inputs/${field}`;
						break;
					}
				}
			}
		}

		if (seedTarget) {
			result.push({
				id: "seed",
				type: "core",
				name: "Noise Seed",
				target: seedTarget,
				accepted: true,
				required: true,
			});
		}

		// ── 5. Find Conditioning Junction ─────────────────────────────────────
		// The first reachable node that has BOTH a 'positive' AND a 'negative' input
		// that are node connections (typically a KSampler or equivalent).
		let positiveStart: string | null = null;
		let negativeStart: string | null = null;

		for (const nodeId of reachable) {
			const inputs = apiData[nodeId]?.inputs ?? {};
			const pos = inputs["positive"];
			const neg = inputs["negative"];
			if (
				Array.isArray(pos) &&
				typeof pos[0] === "string" &&
				Array.isArray(neg) &&
				typeof neg[0] === "string"
			) {
				positiveStart = pos[0] as string;
				negativeStart = neg[0] as string;
				break;
			}
		}

		// ── 6. Detect POSITIVE PROMPT ─────────────────────────────────────────
		let positiveNodeId: string | null = null;
		let positiveTarget: string | null = null;

		if (positiveStart) {
			positiveNodeId = this.findPromptNode(apiData, positiveStart, new Set());
			if (positiveNodeId) {
				const inputs = apiData[positiveNodeId]?.inputs ?? {};
				for (const [field, value] of Object.entries(inputs)) {
					if (typeof value === "string") {
						positiveTarget = `/${positiveNodeId}/inputs/${field}`;
						break;
					}
				}
			}
		}

		if (positiveNodeId && positiveTarget) {
			result.push({
				id: "positivePrompt",
				type: "core",
				name: "Positive Prompt",
				target: positiveTarget,
				accepted: true,
				required: true,
			});
		}

		// ── 7. Detect NEGATIVE PROMPT ─────────────────────────────────────────
		// Skip if the negative encoder is the same node as positive (ConditioningZeroOut pattern).
		let negativeTarget: string | null = null;

		if (negativeStart) {
			const negativeNodeId = this.findPromptNode(
				apiData,
				negativeStart,
				new Set(),
			);
			if (negativeNodeId && negativeNodeId !== positiveNodeId) {
				const inputs = apiData[negativeNodeId]?.inputs ?? {};
				for (const [field, value] of Object.entries(inputs)) {
					if (typeof value === "string") {
						negativeTarget = `/${negativeNodeId}/inputs/${field}`;
						break;
					}
				}
			}
		}

		if (negativeTarget) {
			result.push({
				id: "negativePrompt",
				type: "core",
				name: "Negative Prompt",
				target: negativeTarget,
				accepted: false,
				required: false,
			});
		}

		// ── 8. Detect FINAL IMAGE WIDTH / HEIGHT ──────────────────────────────
		// Find the first reachable node with a 'latent_image' connection, then trace
		// the chain until we reach a node with literal 'width' and 'height' numbers.
		let widthTarget: string | null = null;
		let heightTarget: string | null = null;

		for (const nodeId of reachable) {
			if (widthTarget) break;
			const inputs = apiData[nodeId]?.inputs ?? {};
			const latentConn = inputs["latent_image"];
			if (!Array.isArray(latentConn) || typeof latentConn[0] !== "string")
				continue;

			const visitedLatent = new Set<string>();
			let curId: string = latentConn[0] as string;

			while (curId && !visitedLatent.has(curId)) {
				visitedLatent.add(curId);
				const curInputs = apiData[curId]?.inputs ?? {};

				if (
					typeof curInputs["width"] === "number" &&
					typeof curInputs["height"] === "number"
				) {
					widthTarget = `/${curId}/inputs/width`;
					heightTarget = `/${curId}/inputs/height`;
					break;
				}

				const nextLatent = curInputs["latent_image"];
				curId =
					Array.isArray(nextLatent) && typeof nextLatent[0] === "string"
						? (nextLatent[0] as string)
						: "";
			}
		}

		if (widthTarget) {
			result.push({
				id: "finalImageWidth",
				type: "finalImageWidth",
				name: "Final Image Width",
				target: widthTarget,
				accepted: true,
				required: true,
			});
		}
		if (heightTarget) {
			result.push({
				id: "finalImageHeight",
				type: "finalImageHeight",
				name: "Final Image Height",
				target: heightTarget,
				accepted: true,
				required: true,
			});
		}

		// ── 9. Detect INPUT IMAGES ────────────────────────────────────────────
		// A node qualifies when: (a) its 'image' input is a plain string (not a
		// node connection), AND (b) at least one consumer uses it for 'image' or 'pixels'.
		const inputImageNodes: string[] = [];

		for (const nodeId of reachable) {
			const inputs = apiData[nodeId]?.inputs ?? {};
			if (typeof inputs["image"] !== "string") continue;

			const nodeConsumers = consumers[nodeId] ?? [];
			const hasImageConsumer = nodeConsumers.some(
				(c) => c.fieldName === "image" || c.fieldName === "pixels",
			);

			if (hasImageConsumer) inputImageNodes.push(nodeId);
		}

		if (inputImageNodes.length === 1) {
			result.push({
				id: `inputImage_${inputImageNodes[0]}`,
				type: "inputImage",
				name: "Input Image",
				target: `/${inputImageNodes[0]}/inputs/image`,
				accepted: true,
				required: false,
			});
		} else {
			inputImageNodes.forEach((nodeId, i) => {
				result.push({
					id: `inputImage_${nodeId}`,
					type: "inputImage",
					name: `Input Image ${i + 1}`,
					target: `/${nodeId}/inputs/image`,
					accepted: true,
					required: false,
				});
			});
		}

		// ── 10. Detect LORAS ──────────────────────────────────────────────────
		// LoRA loader nodes: class_type contains 'lora' AND both 'model' and 'clip'
		// inputs are node connections.
		let loraCount = 0;

		for (const nodeId of reachable) {
			const classType: string = (apiData[nodeId]?.class_type ?? "").toLowerCase();
			if (!classType.includes("lora")) continue;

			const inputs = apiData[nodeId]?.inputs ?? {};
			const hasModelConn =
				Array.isArray(inputs["model"]) && typeof inputs["model"][0] === "string";
			const hasClipConn =
				Array.isArray(inputs["clip"]) && typeof inputs["clip"][0] === "string";
			if (!hasModelConn || !hasClipConn) continue;

			const stringFields = Object.entries(inputs).filter(
				([, v]) => typeof v === "string",
			);

			for (const [fieldName] of stringFields) {
				loraCount++;
				const loraLabel = `LoRA ${loraCount}`;

				result.push({
					id: `lora_${nodeId}_${fieldName}`,
					type: "lora",
					name: loraLabel,
					target: `/${nodeId}/inputs/${fieldName}`,
					accepted: false,
					required: false,
				});

				// Stack pattern: lora_<suffix> paired with strength_<suffix>
				const stackMatch = fieldName.match(/^lora_(.+)$/);
				if (stackMatch) {
					const strengthField = `strength_${stackMatch[1]}`;
					if (typeof inputs[strengthField] === "number") {
						result.push({
							id: `lora_${nodeId}_${strengthField}`,
							type: "number",
							name: `${loraLabel} Strength`,
							target: `/${nodeId}/inputs/${strengthField}`,
							accepted: false,
							required: false,
						});
					}
					continue;
				}

				// Standard pattern: lora_name + strength_model
				if (
					fieldName === "lora_name" &&
					typeof inputs["strength_model"] === "number"
				) {
					result.push({
						id: `lora_${nodeId}_strength_model`,
						type: "number",
						name: `${loraLabel} Strength`,
						target: `/${nodeId}/inputs/strength_model`,
						accepted: false,
						required: false,
					});
				}
			}
		}

		// Enrich every item with the _meta.title of its source node.
		return result.map((d) => ({
			...d,
			nodeTitle: (apiData[d.target.split("/")[1]]?._meta?.title as string) ?? "",
		}));
	}

	// ── Public entry point for Quick Flow maker ──────────────────────────────

	/**
	 * Parse raw API JSON and detect the image node, seed node, and positive-prompt
	 * node needed by a Quick Flow. Thin wrapper around detectConfigurables.
	 *
	 * Returns `error` (non-null) on parse failure, no SaveImage, or wrong image count.
	 */
	detectQuickFlowNodes(rawJson: string): QuickFlowDetection {
		let apiData: any;
		try {
			apiData = JSON.parse(rawJson);
		} catch {
			return {
				imageNodeId: null,
				seedNodeId: null,
				positivePromptNodeId: null,
				error: "Invalid JSON.",
			};
		}

		if (typeof apiData !== "object" || apiData === null) {
			return {
				imageNodeId: null,
				seedNodeId: null,
				positivePromptNodeId: null,
				error: "Invalid API data.",
			};
		}

		// Check for SaveImage upfront to give a helpful error message.
		const connectedSaveImages = Object.keys(apiData).filter((id) => {
			if (apiData[id]?.class_type !== "SaveImage") return false;
			return Object.values(apiData[id]?.inputs ?? {}).some(
				(v) => Array.isArray(v) && typeof (v as any[])[0] === "string",
			);
		});

		if (connectedSaveImages.length === 0) {
			return {
				imageNodeId: null,
				seedNodeId: null,
				positivePromptNodeId: null,
				error: "No connected SaveImage node found in the workflow.",
			};
		}

		const detected = this.detectConfigurables(apiData);

		const seedItem = detected.find((d) => d.id === "seed");
		const positiveItem = detected.find((d) => d.id === "positivePrompt");
		const imageItems = detected.filter((d) => d.type === "inputImage");

		const seedNodeId = seedItem ? seedItem.target.split("/")[1] : null;
		const positivePromptNodeId = positiveItem
			? positiveItem.target.split("/")[1]
			: null;

		let imageNodeId: string | null = null;
		let error: string | null = null;

		if (imageItems.length === 0) {
			error =
				"No LoadImage node found. The workflow must have exactly one image input.";
		} else if (imageItems.length > 1) {
			error = `Found ${imageItems.length} image input nodes — select one from the dropdown.`;
		} else {
			imageNodeId = imageItems[0].target.split("/")[1];
		}

		return { imageNodeId, seedNodeId, positivePromptNodeId, error };
	}

	// ── Candidate scanners (simple full-graph scan, no BFS) ──────────────────

	/** All LoadImage-type nodes in the graph, for dropdown population. */
	scanImageNodes(rawJson: string): Array<{ id: string; title: string }> {
		try {
			const api = JSON.parse(rawJson);
			if (typeof api !== "object" || api === null) return [];
			return Object.entries(api as Record<string, any>)
				.filter(
					([, node]) =>
						node?.class_type === "LoadImage" || node?.inputs?.upload === "image",
				)
				.map(([id, node]) => ({
					id,
					title: `${id} – ${node?._meta?.title || node?.class_type || `Node ${id}`}`,
				}));
		} catch {
			return [];
		}
	}

	/** All nodes that contain a large-integer input (seed heuristic), for dropdown population. */
	scanSeedNodes(rawJson: string): Array<{ id: string; title: string }> {
		try {
			const api = JSON.parse(rawJson);
			if (typeof api !== "object" || api === null) return [];
			return Object.entries(api as Record<string, any>)
				.filter(([, node]) =>
					Object.values(node?.inputs ?? {}).some(
						(v) =>
							typeof v === "number" &&
							Number.isInteger(v) &&
							(v as number) > 1_000_000,
					),
				)
				.map(([id, node]) => ({
					id,
					title: `${id} – ${node?._meta?.title || node?.class_type || `Node ${id}`}`,
				}));
		} catch {
			return [];
		}
	}

	/** All scalar (string/number) input fields across all nodes, for Ask On Run param selection. */
	scanNodeFields(rawJson: string): Array<{
		nodeId: string;
		nodeTitle: string;
		field: string;
		value: string | number;
		type: 'text' | 'number';
	}> {
		try {
			const api = JSON.parse(rawJson);
			if (typeof api !== 'object' || api === null) return [];
			const result: Array<{ nodeId: string; nodeTitle: string; field: string; value: string | number; type: 'text' | 'number' }> = [];
			for (const [id, node] of Object.entries(api as Record<string, any>)) {
				const title = (node as any)?._meta?.title || (node as any)?.class_type || `Node ${id}`;
				for (const [field, value] of Object.entries((node as any)?.inputs ?? {})) {
					if (Array.isArray(value)) continue; // node connections are arrays
					if (typeof value === 'string' || typeof value === 'number') {
						result.push({
							nodeId: id,
							nodeTitle: title,
							field,
							value: value as string | number,
							type: typeof value === 'number' ? 'number' : 'text',
						});
					}
				}
			}
			return result;
		} catch {
			return [];
		}
	}

	/** All CLIPTextEncode nodes with a string `text` input, for dropdown population. */
	scanPromptNodes(rawJson: string): Array<{ id: string; title: string }> {
		try {
			const api = JSON.parse(rawJson);
			if (typeof api !== "object" || api === null) return [];
			return Object.entries(api as Record<string, any>)
				.filter(
					([, node]) =>
						node?.class_type === "CLIPTextEncode" &&
						typeof node?.inputs?.text === "string",
				)
				.map(([id, node]) => ({
					id,
					title: `${id} – ${node?._meta?.title || node?.class_type || `Node ${id}`}`,
				}));
		} catch {
			return [];
		}
	}

	// ── BFS helpers ──────────────────────────────────────────────────────────

	/**
	 * BFS from startId backwards through node-connection inputs.
	 * Returns the set of every node ID that feeds into startId.
	 */
	buildReachableSet(apiData: any, startId: string): Set<string> {
		const reachable = new Set<string>();
		const queue: string[] = [startId];
		while (queue.length > 0) {
			const nodeId = queue.shift()!;
			if (reachable.has(nodeId)) continue;
			reachable.add(nodeId);
			const inputs = apiData[nodeId]?.inputs ?? {};
			for (const value of Object.values(inputs)) {
				if (Array.isArray(value) && typeof (value as any[])[0] === "string") {
					const refId = (value as any[])[0] as string;
					if (!reachable.has(refId)) queue.push(refId);
				}
			}
		}
		return reachable;
	}

	/**
	 * For every reachable node's array-valued inputs, record which node consumes
	 * the referenced node's output and through which field name.
	 */
	buildConsumerMap(
		apiData: any,
		reachable: Set<string>,
	): Record<string, { consumerId: string; fieldName: string }[]> {
		const consumers: Record<string, { consumerId: string; fieldName: string }[]> =
			{};
		for (const nodeId of reachable) {
			const inputs = apiData[nodeId]?.inputs ?? {};
			for (const [fieldName, value] of Object.entries(inputs)) {
				if (Array.isArray(value) && typeof (value as any[])[0] === "string") {
					const refId = (value as any[])[0] as string;
					if (!consumers[refId]) consumers[refId] = [];
					consumers[refId].push({ consumerId: nodeId, fieldName });
				}
			}
		}
		return consumers;
	}

	/**
	 * Recursively follows node connections from nodeId to find the first
	 * CLIPTextEncode-like node (identified by having a 'clip' connection input).
	 */
	findPromptNode(
		apiData: any,
		nodeId: string,
		visited: Set<string>,
	): string | null {
		if (visited.has(nodeId) || !apiData[nodeId]) return null;
		visited.add(nodeId);
		const inputs = apiData[nodeId]?.inputs ?? {};
		const hasClipInput = Object.entries(inputs).some(
			([field, value]) =>
				field.toLowerCase().includes("clip") &&
				Array.isArray(value) &&
				typeof (value as any[])[0] === "string",
		);
		if (hasClipInput) return nodeId;
		for (const value of Object.values(inputs)) {
			if (Array.isArray(value) && typeof (value as any[])[0] === "string") {
				const found = this.findPromptNode(
					apiData,
					(value as any[])[0] as string,
					visited,
				);
				if (found) return found;
			}
		}
		return null;
	}
}
