import { Injectable } from "@angular/core";
import { Subject, Observable, take } from "rxjs";
import type {
	CanvasEditorConfig,
	CanvasEditorResult,
} from "./canvas-editor.types";

@Injectable({ providedIn: "root" })
export class CanvasEditorService {
	private _open$ = new Subject<CanvasEditorConfig>();
	private _result$ = new Subject<CanvasEditorResult | null>();
	private _componentRef: any = null; // Reference to the component instance

	/** Listen to this in your host component to trigger the editor overlay */
	readonly open$: Observable<CanvasEditorConfig> = this._open$.asObservable();

	/**
	 * Open the canvas editor and return a one-shot observable of the result.
	 * The observable emits when the user clicks Done (result) or Cancel (null).
	 *
	 * @example
	 * this.canvasEditorService.open({ branding: { name: 'My App' } })
	 *   .subscribe(result => {
	 *     if (result) uploadImage(result.dataUrl);
	 *   });
	 */
	open(config: CanvasEditorConfig = {}): Observable<CanvasEditorResult | null> {
		setTimeout(() => this._open$.next(config), 0);
		return this._result$.pipe(take(1));
	}

	/** @internal Called by the editor component to emit results */
	_emit(result: CanvasEditorResult | null): void {
		this._result$.next(result);
	}

	/** @internal Called by the editor component to register itself */
	_registerComponent(component: any): void {
		this._componentRef = component;
	}

	/**
	 * Update the "Done" button label (useful for showing upload progress).
	 * Only works when autoCloseOnDone is false.
	 */
	setDoneButtonLabel(label: string): void {
		if (this._componentRef) {
			this._componentRef.doneButtonLabel.set(label);
		}
	}

	/**
	 * Enable or disable the "Done" button (useful for preventing clicks during upload).
	 * Only works when autoCloseOnDone is false.
	 */
	setDoneButtonDisabled(disabled: boolean): void {
		if (this._componentRef) {
			this._componentRef.doneButtonDisabled.set(disabled);
		}
	}

	/**
	 * Manually close the editor.
	 * Use this after handling the result when autoCloseOnDone is false.
	 */
	closeEditor(): void {
		if (this._componentRef) {
			this._componentRef.close(true);
		}
	}
}
