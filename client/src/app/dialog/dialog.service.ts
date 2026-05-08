import {
	Injectable,
	ApplicationRef,
	createComponent,
	EnvironmentInjector,
	Injector,
	inject,
} from "@angular/core";
import { DialogComponent } from "./dialog.component";
import { DimCalcModalComponent, type DimCalcResult } from "./dim-calc-modal.component";
import { RunFlowModalComponent, type RunFlowResult } from "./run-flow-modal.component";
import type { QuickFlow } from "../comfyui/comfyui-database.service";
import type { TemplateVar } from "../utils/prompt-template";

export type DialogType = "alert" | "confirm" | "prompt";
export type FocusButton = "ok" | "cancel";

export interface DialogConfig {
	type: DialogType;
	title: string;
	message: string;
	okLabel: string;
	cancelLabel: string;
	placeholder: string;
	focusButton: FocusButton;
	defaultValue?: string;
	multiline?: boolean;
}

export interface AlertOptions {
	title?: string;
	okLabel?: string;
}

export interface ConfirmOptions {
	title?: string;
	okLabel?: string;
	cancelLabel?: string;
	focusButton?: FocusButton;
}

export interface PromptOptions {
	title?: string;
	okLabel?: string;
	cancelLabel?: string;
	placeholder?: string;
	defaultValue?: string;
	multiline?: boolean;
}

export class DialogRef<T = any> {
	private resolvePromise!: (value: T) => void;
	readonly result: Promise<T>;

	constructor(public config: DialogConfig) {
		this.result = new Promise<T>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	close(value?: T): void {
		this.resolvePromise(value as T);
	}
}

@Injectable({ providedIn: "root" })
export class Dialog {
	private appRef = inject(ApplicationRef);
	private injector = inject(EnvironmentInjector);
	private elementInjector = inject(Injector);

	alert(message: unknown, options: AlertOptions = {}): Promise<void> {
		const config: DialogConfig = {
			type: "alert",
			title: options.title ?? "Alert",
			message: String(message),
			okLabel: options.okLabel ?? "OK",
			cancelLabel: "",
			placeholder: "",
			focusButton: "ok",
		};
		return this.open<void>(config);
	}

	confirm(
		message: string | null,
		options: ConfirmOptions = {},
	): Promise<boolean> {
		const config: DialogConfig = {
			type: "confirm",
			title: options.title ?? "Confirm",
			message: message ?? "",
			okLabel: options.okLabel ?? "OK",
			cancelLabel: options.cancelLabel ?? "Cancel",
			placeholder: "",
			focusButton: options.focusButton ?? "ok",
		};
		return this.open<boolean>(config);
	}

	prompt(
		message: string | null,
		options: PromptOptions = {},
	): Promise<string | null> {
		const config: DialogConfig = {
			type: "prompt",
			title: options.title ?? "Prompt",
			message: message ?? "",
			okLabel: options.okLabel ?? "OK",
			cancelLabel: options.cancelLabel ?? "Cancel",
			placeholder: options.placeholder ?? "",
			focusButton: "ok",
			defaultValue: options.defaultValue ?? "",
			multiline: options.multiline ?? false,
		};
		return this.open<string | null>(config);
	}

	openRunFlow(flow: QuickFlow, templateVars: TemplateVar[], showPromptEditor: boolean): Promise<RunFlowResult | null> {
		const ref = new DialogRef<RunFlowResult | null>({} as DialogConfig);

		const injector = Injector.create({
			providers: [{ provide: DialogRef, useValue: ref }],
			parent: this.elementInjector,
		});

		const componentRef = createComponent(RunFlowModalComponent, {
			environmentInjector: this.injector,
			elementInjector: injector,
		});
		componentRef.instance.flow = flow;
		componentRef.instance.templateVars = templateVars;
		componentRef.instance.showPromptEditor = showPromptEditor;

		document.body.appendChild(componentRef.location.nativeElement);
		this.appRef.attachView(componentRef.hostView);

		ref.result.then(() => {
			this.appRef.detachView(componentRef.hostView);
			componentRef.destroy();
		});

		return ref.result;
	}

	openDimCalc(canApplyToFlow: boolean, initialW = 0, initialH = 0): Promise<DimCalcResult | null> {
		const ref = new DialogRef<DimCalcResult | null>({} as DialogConfig);

		const injector = Injector.create({
			providers: [{ provide: DialogRef, useValue: ref }],
			parent: this.elementInjector,
		});

		const componentRef = createComponent(DimCalcModalComponent, {
			environmentInjector: this.injector,
			elementInjector: injector,
		});
		componentRef.instance.canApplyToFlow = canApplyToFlow;
		componentRef.instance.initialW = initialW;
		componentRef.instance.initialH = initialH;

		document.body.appendChild(componentRef.location.nativeElement);
		this.appRef.attachView(componentRef.hostView);

		ref.result.then(() => {
			this.appRef.detachView(componentRef.hostView);
			componentRef.destroy();
		});

		return ref.result;
	}

	private open<T>(config: DialogConfig): Promise<T> {
		const dialogRef = new DialogRef<T>(config);

		const dialogInjector = Injector.create({
			providers: [{ provide: DialogRef, useValue: dialogRef }],
			parent: this.elementInjector,
		});

		const componentRef = createComponent(DialogComponent, {
			environmentInjector: this.injector,
			elementInjector: dialogInjector,
		});

		document.body.appendChild(componentRef.location.nativeElement);
		this.appRef.attachView(componentRef.hostView);

		dialogRef.result.then(() => {
			this.appRef.detachView(componentRef.hostView);
			componentRef.destroy();
		});

		return dialogRef.result;
	}
}
