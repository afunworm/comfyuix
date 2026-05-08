export type Tool =
	| "select"
	| "brush"
	| "eraser"
	| "text"
	| "fill"
	| "eyedropper";
export type ResizeHandle =
	| "tl"
	| "tc"
	| "tr"
	| "ml"
	| "mr"
	| "bl"
	| "bc"
	| "br";

export type BlendMode =
	| "source-over"
	| "multiply"
	| "screen"
	| "overlay"
	| "darken"
	| "lighten"
	| "color-dodge"
	| "color-burn"
	| "soft-light"
	| "hard-light"
	| "difference"
	| "exclusion";

export interface TextStyle {
	fontSize: number;
	fontFamily: string;
	color: string;
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strikethrough: boolean;
	align: CanvasTextAlign;
	letterSpacing: number;
	lineHeight: number;
}

export interface Layer {
	id: string;
	name: string;
	type: "raster" | "image" | "text";
	canvas: HTMLCanvasElement;
	maskCanvas?: HTMLCanvasElement;
	visible: boolean;
	opacity: number;
	blendMode: GlobalCompositeOperation;
	locked: boolean;
	x: number;
	y: number;
	w: number;
	h: number;
	rotation: number; // in degrees
	srcDataUrl?: string;
	text?: string;
	textStyle?: TextStyle;
}

export interface CanvasEditorBranding {
	name?: string;
	logoUrl?: string;
	accentColor?: string;
}

export interface CanvasEditorConfig {
	branding?: CanvasEditorBranding;
	initialWidth?: number;
	initialHeight?: number;
	initialState?: CanvasEditorSaveState;
	autoCloseOnDone?: boolean; // default true - set false to keep editor open after Done
}

export interface LayerSave {
	id: string;
	name: string;
	type: "raster" | "image" | "text";
	imageData: string;
	maskData?: string;
	visible: boolean;
	opacity: number;
	blendMode: string;
	locked: boolean;
	x: number;
	y: number;
	w: number;
	h: number;
	rotation?: number; // in degrees
	srcDataUrl?: string;
	text?: string;
	textStyle?: TextStyle;
}

export interface CanvasEditorSaveState {
	version: number;
	width: number;
	height: number;
	backgroundColor: string;
	layers: LayerSave[];
}

export interface CanvasEditorResult {
	dataUrl: string;
	width: number;
	height: number;
	state: CanvasEditorSaveState;
}

export interface ContextMenuDef {
	x: number;
	y: number;
	items: ContextMenuItemDef[];
}

export interface ContextMenuItemDef {
	label?: string;
	icon?: string;
	action?: () => void;
	separator?: boolean;
	disabled?: boolean;
}
