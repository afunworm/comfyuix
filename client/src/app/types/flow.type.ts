export type BindingTarget =
	| { type: 'configurable'; configId: string }
	| { type: 'imageWidth'; imageConfigId: string }
	| { type: 'imageHeight'; imageConfigId: string };

export type PromptTemplate = {
	protected: boolean;
	positive: string;
	negative: string;
};

export type FlowTemplate = {
	id: string;
	name: string;
	description: string;
	promptTemplates: PromptTemplate[];
	protected: boolean;
	changes: {
		configId: string;
		value?: string;
		visible?: boolean;
	}[];
};

export type Configurable = {
	id: string;
	visible: boolean;
	protected: boolean;
	name: string;
	target: string | null;
	type:
		| "number"
		| "finalImageWidth"
		| "finalImageHeight"
		| "text"
		| "inputImage"
		| "multilineText"
		| "preset"
		| "lora"
		| "core";
	presets?: string[];
	selectValue?: string;
};

export type FlowConfig = {
	id?: string;
	name: string;
	description: string;
	configurables: Configurable[];
	templates: FlowTemplate[];
	apiData: any;
	bindings?: Record<string, BindingTarget>;
	outputDimensions?: 'fixed' | 'derived'; // 'fixed' = finalImageWidth/Height required; 'derived' = from input image
};
