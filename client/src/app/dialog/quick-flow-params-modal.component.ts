import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DialogRef } from './dialog.service';

export interface QuickFlowParamInput {
	id: string;
	label: string;
	type: 'text' | 'number';
	default: string;
}

@Component({
	selector: 'app-quick-flow-params-modal',
	standalone: true,
	imports: [CommonModule],
	template: `
		<div class="qfp-overlay">
			<div class="qfp-dialog" role="dialog">
				<div class="qfp-head">
					<h3 class="qfp-title">Run Options</h3>
					<span class="qfp-close" (click)="cancel()">✕</span>
				</div>
				<div class="qfp-body">
					@for (param of params; track param.id) {
						<div class="qfp-field">
							<label class="qfp-label">{{ param.label || 'Value' }}</label>
							@if (param.type === 'number') {
								<input
									class="control"
									type="number"
									[value]="values[param.id]"
									(input)="values[param.id] = $any($event.target).value"
								/>
							} @else {
								<input
									class="control"
									type="text"
									[value]="values[param.id]"
									(input)="values[param.id] = $any($event.target).value"
									(keydown.enter)="confirm()"
								/>
							}
						</div>
					}
				</div>
				<div class="qfp-foot">
					<button class="btn" type="button" (click)="cancel()">Cancel</button>
					<button class="btn btn--primary" type="button" (click)="confirm()">Run</button>
				</div>
			</div>
		</div>
	`,
	styles: [`
		.qfp-overlay {
			width: 100%;
			height: 100%;
			z-index: 1000;
			position: fixed;
			top: 0;
			left: 0;
			display: flex;
			justify-content: center;
			align-items: center;
			background: rgba(0, 0, 0, 0.75);
		}
		.qfp-dialog {
			background: var(--surface, #1e1e2e);
			border: 1px solid var(--border, rgba(255,255,255,0.1));
			border-radius: var(--radius, 8px);
			min-width: 320px;
			max-width: 440px;
			width: 100%;
			padding: 20px;
			display: grid;
			gap: 16px;
		}
		.qfp-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
		}
		.qfp-title {
			margin: 0;
			font-size: 1rem;
			font-weight: 600;
		}
		.qfp-close {
			cursor: pointer;
			opacity: 0.5;
			font-size: 0.85rem;
			&:hover { opacity: 1; }
		}
		.qfp-body {
			display: grid;
			gap: 12px;
		}
		.qfp-field {
			display: grid;
			gap: 4px;
		}
		.qfp-label {
			font-size: 0.82rem;
			opacity: 0.6;
		}
		.qfp-foot {
			display: flex;
			justify-content: flex-end;
			gap: 8px;
		}
	`],
})
export class QuickFlowParamsModalComponent implements OnInit {
	private ref = inject(DialogRef);

	params: QuickFlowParamInput[] = [];
	values: Record<string, string> = {};

	ngOnInit(): void {
		for (const p of this.params) {
			this.values[p.id] = p.default ?? '';
		}
	}

	confirm(): void {
		this.ref.close(this.values);
	}

	cancel(): void {
		this.ref.close(null);
	}
}
