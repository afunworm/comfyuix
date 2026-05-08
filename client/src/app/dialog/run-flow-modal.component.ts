import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DialogRef } from './dialog.service';
import type { QuickFlow, AskOnRunParam } from '../comfyui/comfyui-database.service';
import {
	type TemplateVar,
	type TemplateSelections,
	assemblePrompt,
	getDefaultSelections,
} from '../utils/prompt-template';

export interface RunFlowResult {
	promptOverride: string | null;
	paramValues: Record<string, string> | null;
	selectedLabel: string | null;
}

@Component({
	selector: 'app-run-flow-modal',
	standalone: true,
	imports: [CommonModule],
	template: `
		<div class="rfm-overlay" (mousedown)="cancel()">
			<div
				class="rfm-dialog"
				role="dialog"
				aria-modal="true"
				(mousedown)="$event.stopPropagation()"
			>
				<div class="rfm-head">
					<span class="rfm-title">Run "{{ flow.name }}"</span>
					<button class="btn-icon rfm-close" type="button" title="Close" (click)="cancel()">
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				</div>

				<div class="rfm-body">
					@for (v of templateVars; track v.index) {
						@if (isVarVisible(v)) {
							<div class="rfm-field">
								@if (uiVarCount > 1) {
									<label class="rfm-label">{{ v.label }}</label>
								}
								@if (v.type === 'dropdown') {
									<select
										class="select"
										[value]="getDropdownValue(v.index, v.defaultValue)"
										(change)="setSelection(v.index, $any($event.target).value)"
									>
										@for (opt of v.options; track opt.value) {
											<option [value]="opt.value">{{ opt.label }}</option>
										}
									</select>
								} @else {
									<label class="rfm-checkbox-row">
										<input
											type="checkbox"
											[checked]="getCheckboxValue(v.index, v.defaultOn)"
											(change)="setSelection(v.index, $any($event.target).checked)"
										/>
										<span class="rfm-checkbox-text">{{ v.label }}</span>
									</label>
								}
							</div>
						}
					}

					@if (hasAskParams) {
						@if (hasTemplateVars) {
							<hr class="rfm-divider" />
						}
						@for (param of askParams; track param.id) {
							<div class="rfm-field">
								<label class="rfm-label">{{ param.label || param.id }}</label>
								@if (param.type === 'number') {
									<input
										class="control"
										type="number"
										[value]="paramValues[param.id]"
										(input)="paramValues[param.id] = $any($event.target).value"
									/>
								} @else {
									<input
										class="control"
										type="text"
										[value]="paramValues[param.id]"
										(input)="paramValues[param.id] = $any($event.target).value"
										(keydown.enter)="confirm()"
									/>
								}
							</div>
						}
					}

					@if (showPromptEditor) {
						<div class="rfm-field">
							<label class="rfm-label">Prompt</label>
							<textarea
								class="control rfm-prompt-textarea"
								[value]="promptDraft"
								(input)="promptDraft = $any($event.target).value"
							></textarea>
						</div>
					}
				</div>

				<div class="rfm-foot">
					<button class="btn" type="button" (click)="cancel()">Cancel</button>
					<button class="btn btn--primary" type="button" (click)="confirm()">Run</button>
				</div>
			</div>
		</div>
	`,
	styles: [
		`
			.rfm-overlay {
				position: fixed;
				inset: 0;
				z-index: 1100;
				display: flex;
				align-items: center;
				justify-content: center;
				background: rgba(0, 0, 0, 0.7);
				backdrop-filter: blur(4px);
			}

			.rfm-dialog {
				display: grid;
				grid-template-rows: auto 1fr auto;
				background: var(--surface, #1a1f2e);
				border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
				border-radius: var(--radius, 8px);
				box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
				width: min(480px, 92vw);
				max-height: min(560px, 90vh);
				overflow: hidden;
			}

			/* ── Head ─────────────────────────────────────────── */

			.rfm-head {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 12px;
				padding: 14px 16px 14px 20px;
				border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
			}

			.rfm-title {
				font-size: 0.95rem;
				font-weight: 600;
			}

			.rfm-close svg {
				width: 16px;
				height: 16px;
			}

			/* ── Body ─────────────────────────────────────────── */

			.rfm-body {
				display: flex;
				flex-direction: column;
				gap: 14px;
				padding: 18px 20px;
				overflow-y: auto;
				min-height: 0;
			}

			.rfm-field {
				display: grid;
				gap: 6px;
			}

			.rfm-label {
				font-size: 0.78rem;
				font-weight: 600;
				color: rgba(255, 255, 255, 0.5);
				user-select: none;
			}

			.rfm-checkbox-row {
				display: flex;
				align-items: center;
				gap: 8px;
				cursor: pointer;
				font-size: 0.88rem;
			}

			.rfm-checkbox-row input[type='checkbox'] {
				width: 15px;
				height: 15px;
				cursor: pointer;
				flex-shrink: 0;
			}

			.rfm-checkbox-text {
				color: var(--text);
			}

			.rfm-divider {
				margin: 2px 0;
				border: 0;
				height: 1px;
				background: var(--border, rgba(255, 255, 255, 0.08));
			}

			.rfm-prompt-textarea {
				min-height: 100px;
				font-size: 0.82rem;
				line-height: 1.5;
				resize: vertical;
			}

			/* ── Foot ──────────────────────────────────────────── */

			.rfm-foot {
				display: flex;
				justify-content: flex-end;
				gap: 8px;
				padding: 12px 16px;
				border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
			}
		`,
	],
})
export class RunFlowModalComponent implements OnInit {
	private readonly ref = inject(DialogRef);

	flow!: QuickFlow;
	templateVars: TemplateVar[] = [];

	askParams: AskOnRunParam[] = [];
	selections: TemplateSelections = {};
	paramValues: Record<string, string> = {};
	promptDraft = '';
	showPromptEditor = false;

	get hasTemplateVars(): boolean {
		return this.templateVars.some((v) => v.primaryIndex === undefined);
	}

	get uiVarCount(): number {
		return this.templateVars.filter((v) => v.primaryIndex === undefined).length;
	}

	get hasPromptNode(): boolean {
		return !!this.flow?.positive_prompt_node_id;
	}

	get hasAskParams(): boolean {
		return this.askParams.length > 0;
	}

	private getPromptTemplate(): string {
		if (!this.flow?.positive_prompt_node_id) return '';
		try {
			const api = JSON.parse(this.flow.api_data);
			const inputs = api[this.flow.positive_prompt_node_id]?.inputs ?? {};
			for (const v of Object.values(inputs)) {
				if (typeof v === 'string') return v as string;
			}
		} catch {}
		return '';
	}

	ngOnInit(): void {
		try {
			this.askParams = JSON.parse(this.flow?.ask_on_run || '[]');
		} catch {
			this.askParams = [];
		}

		this.selections = getDefaultSelections(this.templateVars);
		this.promptDraft = assemblePrompt(this.getPromptTemplate(), this.selections);

		for (const p of this.askParams) {
			this.paramValues[p.id] = p.default ?? '';
		}
	}

	getDropdownValue(varIndex: number, defaultValue?: string): string {
		const sel = this.selections[varIndex];
		return typeof sel === 'string' ? sel : (defaultValue ?? '');
	}

	getCheckboxValue(varIndex: number, defaultOn?: boolean): boolean {
		const sel = this.selections[varIndex];
		return sel !== undefined ? sel === true : (defaultOn ?? false);
	}

	isVarVisible(v: TemplateVar): boolean {
		// Reference blocks never render their own UI control
		if (v.primaryIndex !== undefined) return false;

		if (v.parentIndex === undefined) return true;
		const parent = this.templateVars.find((p) => p.index === v.parentIndex);
		if (!parent) return true;

		if (parent.type === 'checkbox') {
			// Visible only when the parent checkbox is checked
			const selKey = parent.primaryIndex ?? parent.index;
			return this.selections[selKey] === true;
		}

		// Dropdown: visible only when the specific parent option is selected
		const selectedVal = this.selections[v.parentIndex];
		const selectedOptIdx = parent.options?.findIndex((o) => o.value === selectedVal) ?? -1;
		return selectedOptIdx === v.parentOptionIndex;
	}

	setSelection(varIndex: number, value: string | boolean): void {
		const newSel = { ...this.selections, [varIndex]: value };
		// Reset direct children so stale values don't bleed through when re-selecting a parent option
		for (const v of this.templateVars) {
			if (v.parentIndex === varIndex) {
				newSel[v.index] =
					v.type === 'checkbox'
						? (v.defaultOn ?? false)
						: (v.defaultValue ?? v.options?.[0]?.value ?? '');
			}
		}
		this.selections = newSel;
		this.promptDraft = assemblePrompt(this.getPromptTemplate(), this.selections);
	}

	getSelectedLabel(): string | null {
		const firstDropdown = this.templateVars.find((v) => v.type === 'dropdown');
		if (!firstDropdown) return null;
		const sel = this.selections[firstDropdown.index];
		const opt = firstDropdown.options?.find((o) => o.value === sel);
		return opt?.label ?? null;
	}

	confirm(): void {
		this.ref.close({
			promptOverride: this.hasTemplateVars ? this.promptDraft : null,
			paramValues: this.hasAskParams ? { ...this.paramValues } : null,
			selectedLabel: this.getSelectedLabel(),
		} satisfies RunFlowResult);
	}

	cancel(): void {
		this.ref.close(null);
	}
}
