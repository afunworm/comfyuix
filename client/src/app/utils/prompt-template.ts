export interface TemplateVarOption {
	value: string; // processed: nested [...] replaced with {idx} placeholders
	label: string;
}

export interface TemplateVar {
	index: number;
	type: 'dropdown' | 'checkbox';
	label: string;
	options?: TemplateVarOption[];
	promptText?: string;
	defaultOn?: boolean;
	defaultValue?: string;
	/** Shared ID declared with #id in the label. */
	id?: string;
	/**
	 * If set, this is a reference block: it shares the checkbox state of the
	 * primary var at this index and never renders its own UI control.
	 */
	primaryIndex?: number;
	/** Index of the parent dropdown var. Undefined = top-level. */
	parentIndex?: number;
	/** 0-based option index within the parent that must be selected for this var to show. */
	parentOptionIndex?: number;
}

export type TemplateSelections = Record<number, string | boolean>;

// ── Internal helpers ──────────────────────────────────────────────────────────

function findClosingBracket(str: string, openAt: number): number {
	let depth = 0;
	for (let i = openAt; i < str.length; i++) {
		if (str[i] === '[') depth++;
		else if (str[i] === ']') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function splitPipesAtDepth0(str: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < str.length; i++) {
		if (str[i] === '[') depth++;
		else if (str[i] === ']') depth--;
		else if (str[i] === '|' && depth === 0) {
			parts.push(str.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(str.slice(start));
	return parts;
}

function lastColonAtDepth0(str: string): number {
	let depth = 0;
	let last = -1;
	for (let i = 0; i < str.length; i++) {
		if (str[i] === '[') depth++;
		else if (str[i] === ']') depth--;
		else if (str[i] === ':' && depth === 0) last = i;
	}
	return last;
}

/**
 * Strip * (defaultOn) and #id suffixes from a raw label string in any order.
 */
function parseLabelSuffixes(raw: string): { label: string; defaultOn: boolean; id?: string } {
	let s = raw;
	let defaultOn = false;
	let id: string | undefined;

	// Two passes handle both orderings: *#id and #id*
	for (let pass = 0; pass < 2; pass++) {
		if (!defaultOn && s.endsWith('*')) {
			defaultOn = true;
			s = s.slice(0, -1).trimEnd();
		}
		if (id === undefined) {
			const m = s.match(/#(\w+)$/);
			if (m) {
				id = m[1];
				s = s.slice(0, -m[0].length).trimEnd();
			}
		}
	}

	return { label: s.trim(), defaultOn, id };
}

/**
 * Recursively parse a template string into the vars array.
 * Returns the processed string with all [...] replaced by {idx} placeholders.
 * Indices are assigned in depth-first, left-to-right order.
 */
function parseInto(
	str: string,
	vars: TemplateVar[],
	counter: { n: number },
	idMap: Map<string, number>,
	parentIndex: number | undefined,
	parentOptionIndex: number | undefined,
): string {
	const out: string[] = [];
	let i = 0;

	while (i < str.length) {
		if (str[i] !== '[') {
			out.push(str[i++]);
			continue;
		}

		const closeIdx = findClosingBracket(str, i);
		if (closeIdx === -1) {
			out.push(str[i++]);
			continue;
		}

		const inner = str.slice(i + 1, closeIdx);
		const varIndex = counter.n++;

		const parts = splitPipesAtDepth0(inner).map((p) => p.trim());

		if (parts.length === 1) {
			// ── Checkbox ──────────────────────────────────────────────────────
			const colonIdx = lastColonAtDepth0(parts[0]);
			let rawText: string;
			let rawLabel: string;

			if (colonIdx !== -1) {
				rawText = parts[0].slice(0, colonIdx).trim();
				rawLabel = parts[0].slice(colonIdx + 1).trim();
			} else {
				rawText = parts[0];
				rawLabel = parts[0];
			}

			const { label, defaultOn, id } = parseLabelSuffixes(rawLabel);
			const existingPrimary = id !== undefined ? idMap.get(id) : undefined;

			if (existingPrimary !== undefined) {
				// ── Reference block: shares state with the primary var ─────────
				const promptText = parseInto(rawText, vars, counter, idMap, existingPrimary, undefined);
				vars.push({
					index: varIndex,
					type: 'checkbox',
					label,
					promptText,
					defaultOn,
					primaryIndex: existingPrimary,
					parentIndex,
					parentOptionIndex,
				});
			} else {
				// ── Primary checkbox ───────────────────────────────────────────
				if (id !== undefined) idMap.set(id, varIndex);
				const promptText = parseInto(rawText, vars, counter, idMap, varIndex, undefined);
				vars.push({
					index: varIndex,
					type: 'checkbox',
					label,
					promptText,
					defaultOn,
					id,
					parentIndex,
					parentOptionIndex,
				});
			}
		} else {
			// ── Dropdown ──────────────────────────────────────────────────────
			const options: TemplateVarOption[] = [];

			for (let optIdx = 0; optIdx < parts.length; optIdx++) {
				const part = parts[optIdx];
				const colonIdx = lastColonAtDepth0(part);
				let rawVal: string;
				let label: string;

				if (colonIdx !== -1 && colonIdx < part.length - 1) {
					rawVal = part.slice(0, colonIdx).trim();
					label = part.slice(colonIdx + 1).trim();
				} else {
					rawVal = part;
					label = part;
				}

				// Recursively parse nested [...] inside this option's value.
				// Child vars are visible only when this option (optIdx) is selected.
				const processedVal = parseInto(rawVal, vars, counter, idMap, varIndex, optIdx);
				options.push({ value: processedVal, label });
			}

			vars.push({
				index: varIndex,
				type: 'dropdown',
				label: `Option ${varIndex + 1}`,
				options,
				defaultValue: options[0]?.value ?? '',
				parentIndex,
				parentOptionIndex,
			});
		}

		out.push(`{${varIndex}}`);
		i = closeIdx + 1;
	}

	return out.join('');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse inline template syntax from a prompt string.
 *
 * Dropdown:  [opt1 | opt2 | opt3]            — value = label
 *            [val:Label | val:Label]          — custom labels per option
 * Checkbox:  [prompt text:UI Label]           — unchecked by default
 *            [prompt text:UI Label*]          — checked by default
 *            [prompt text]                    — label = promptText
 *
 * Suffixes on checkbox labels (* and #id) are order-independent:
 *   [text:Label*#id]  ≡  [text:Label#id*]
 *
 * Named IDs (#id): bind multiple text segments to one UI control.
 *   First occurrence declares the primary checkbox.
 *   Subsequent occurrences are reference blocks — same checkbox, different content.
 *   Example:
 *     [Keep tattoos.:Has tattoos*#tattoos]
 *     [Do not alter tattoos.:#tattoos]
 *   → one "Has tattoos" checkbox controls both sentences.
 *
 * Nesting: an option value (dropdown) or promptText (checkbox) may itself
 * contain [...], which become child vars visible only when the parent is active.
 */
export function parsePromptTemplate(prompt: string): TemplateVar[] {
	const vars: TemplateVar[] = [];
	const counter = { n: 0 };
	const idMap = new Map<string, number>();
	parseInto(prompt, vars, counter, idMap, undefined, undefined);
	return vars.sort((a, b) => a.index - b.index);
}

/**
 * Substitute template variables with selected values to produce the final prompt.
 */
export function assemblePrompt(template: string, selections: TemplateSelections): string {
	const vars: TemplateVar[] = [];
	const counter = { n: 0 };
	const idMap = new Map<string, number>();
	const processed = parseInto(template, vars, counter, idMap, undefined, undefined);

	function resolveIdx(idx: number): string {
		const v = vars.find((v) => v.index === idx);
		if (!v) return '';

		if (v.type === 'checkbox') {
			// Reference blocks defer to their primary var's selection
			const selKey = v.primaryIndex ?? v.index;
			const sel = selections[selKey];
			const checked = sel !== undefined ? sel === true : (v.defaultOn ?? false);
			if (!checked) return '';
			// Resolve any {childIdx} placeholders in promptText (from nested [...])
			return (v.promptText ?? '').replace(/\{(\d+)\}/g, (_: string, s: string) => resolveIdx(+s));
		}

		// Dropdown: resolve any {childIdx} placeholders in the selected option value
		const sel = selections[idx];
		const selectedVal =
			typeof sel === 'string' ? sel : (v.defaultValue ?? v.options?.[0]?.value ?? '');
		return selectedVal.replace(/\{(\d+)\}/g, (_: string, s: string) => resolveIdx(+s));
	}

	let result = processed.replace(/\{(\d+)\}/g, (_: string, s: string) => resolveIdx(+s));
	result = result.replace(/  +/g, ' ').trim();
	return result;
}

/**
 * Build initial selections from template variable defaults.
 * Reference vars (primaryIndex set) share their primary's selection and are skipped.
 */
export function getDefaultSelections(vars: TemplateVar[]): TemplateSelections {
	const sel: TemplateSelections = {};
	for (const v of vars) {
		if (v.primaryIndex !== undefined) continue;
		sel[v.index] =
			v.type === 'checkbox'
				? (v.defaultOn ?? false)
				: (v.defaultValue ?? v.options?.[0]?.value ?? '');
	}
	return sel;
}
