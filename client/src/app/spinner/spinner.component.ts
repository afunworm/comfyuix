import { Component, Input, OnDestroy, OnInit, signal } from "@angular/core";

const PRESETS: Record<string, string[]> = {
	classic: ["|", "/", "-", "\\"],
	bounce: [
		"●··········",
		"·●·········",
		"··●········",
		"···●·······",
		"····●······",
		"·····●·····",
		"······●····",
		"·······●···",
		"········●··",
		"·········●·",
		"··········●",
		"·········●·",
		"········●··",
		"·······●···",
		"······●····",
		"·····●·····",
		"····●······",
		"···●·······",
		"··●········",
		"·●·········",
	],
	bar: [
		"█░░░░░░░░",
		"██░░░░░░░",
		"███░░░░░░",
		"████░░░░░",
		"█████░░░░",
		"██████░░░",
		"███████░░",
		"████████░",
		"█████████",
	],
	arrow: [
		">----",
		"->---",
		"-->--",
		"--->-",
		"---->",
		"--->-",
		"-->--",
		"->---",
	],
	train: [
		"🚂····",
		"·🚂···",
		"··🚂··",
		"···🚂·",
		"····🚂",
		"···🚂·",
		"··🚂··",
		"·🚂···",
	],
};

@Component({
	selector: "spinner",
	standalone: true,
	template: `
		@if (overlay) {
			<div
				class="spinner-overlay"
				role="status"
				aria-label="Loading"
				[style.bottom.px]="bottomOffset"
			>
				<div class="spinner-overlay__content">
					<span class="spinner">{{ frame() }}</span>
					@if (label) {
						<span class="spinner-overlay__label">{{ label }}</span>
					}
				</div>
			</div>
		} @else {
			<span class="spinner" aria-label="Loading" role="status">{{ frame() }}</span>
		}
	`,
	styles: [
		`
			.spinner {
				font-family:
					ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
					"Courier New", monospace;
				display: inline-block;
				white-space: pre;
			}
			.spinner-overlay {
				position: fixed;
				inset: 0;
				z-index: 9999;
				display: flex;
				justify-content: center;
				align-items: center;
				background: rgba(0, 0, 0, 0.75);
				backdrop-filter: blur(4px);
			}
			.spinner-overlay__content {
				display: flex;
				flex-direction: column;
				align-items: center;
				gap: 12px;
			}
			.spinner-overlay__label {
				font-family:
					ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
					"Courier New", monospace;
				font-size: 0.85rem;
				color: rgba(255, 255, 255, 0.75);
			}
		`,
	],
})
export class SpinnerComponent implements OnInit, OnDestroy {
	@Input() preset: keyof typeof PRESETS = "bounce";
	@Input() speedMs = 90;
	@Input() overlay = false;
	@Input() label = "";
	@Input() bottomOffset = 0;

	frame = signal("");
	private i = 0;
	private intervalId!: number;

	ngOnInit() {
		const frames = PRESETS[this.preset] ?? PRESETS["classic"];
		this.frame.set(frames[0]);

		this.intervalId = window.setInterval(() => {
			this.frame.set(frames[this.i++ % frames.length]);
		}, this.speedMs);
	}

	ngOnDestroy() {
		clearInterval(this.intervalId);
	}
}
