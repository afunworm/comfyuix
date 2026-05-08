import {
	Component,
	HostListener,
	inject,
	AfterViewInit,
	ElementRef,
	ViewChild,
} from "@angular/core";
import { DialogRef } from "./dialog.service";

@Component({
	selector: "app-dialog",
	standalone: true,
	template: `
		<div class="dialog-overlay">
			<div class="dialog" role="dialog">
				<div class="dialog__head">
					<h3 class="dialog__title">{{ config.title }}</h3>
					<span class="badge" (click)="close()">x</span>
				</div>
				<div class="dialog__body">
					<p class="dialog__msg" [innerHTML]="config.message"></p>
					@if (config.type === "prompt") {
						@if (config.multiline) {
							<textarea
								#inputEl
								class="control"
								rows="6"
								[placeholder]="config.placeholder"
								(input)="inputValue = $any($event.target).value"
							>{{ inputValue }}</textarea>
						} @else {
							<input
								#inputEl
								class="control"
								type="text"
								[placeholder]="config.placeholder"
								[(value)]="inputValue"
								(input)="inputValue = $any($event.target).value"
								(keydown.enter)="confirm()"
							/>
						}
					}
				</div>
				<div class="dialog__foot">
					@if (config.type !== "alert") {
						<button #cancelBtn class="btn" type="button" (click)="close()">
							{{ config.cancelLabel }}
						</button>
					}
					<button #okBtn class="btn btn--primary" type="button" (click)="confirm()">
						{{ config.okLabel }}
					</button>
				</div>
			</div>
		</div>
	`,
	styles: [
		`
			.dialog-overlay {
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
			.badge {
				cursor: pointer;
			}
		`,
	],
})
export class DialogComponent implements AfterViewInit {
	private dialogRef = inject(DialogRef);
	private el = inject(ElementRef);

	@ViewChild("okBtn") okBtn!: ElementRef<HTMLButtonElement>;
	@ViewChild("cancelBtn") cancelBtn?: ElementRef<HTMLButtonElement>;

	config = this.dialogRef.config;
	inputValue = this.config.defaultValue ?? "";

	ngAfterViewInit(): void {
		setTimeout(() => this.setFocus());
	}

	private setFocus(): void {
		if (this.config.type === "prompt") {
			const input = this.el.nativeElement.querySelector("input, textarea");
			input?.focus();
		} else if (this.config.focusButton === "cancel" && this.cancelBtn) {
			this.cancelBtn.nativeElement.focus();
		} else {
			this.okBtn.nativeElement.focus();
		}
	}

	@HostListener("document:keydown.escape")
	close(): void {
		if (this.config.type === "confirm") {
			this.dialogRef.close(false);
		} else if (this.config.type === "prompt") {
			this.dialogRef.close(null);
		} else {
			this.dialogRef.close();
		}
	}

	confirm(): void {
		if (this.config.type === "confirm") {
			this.dialogRef.close(true);
		} else if (this.config.type === "prompt") {
			this.dialogRef.close(this.inputValue);
		} else {
			this.dialogRef.close();
		}
	}
}
