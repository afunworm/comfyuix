export interface MultirunSharedField {
  id: string;
  label: string;
  value: string;
}

export interface MultirunEntry {
  id: string;
  flowId: string;
  templateId: string;
  /** configurableId → sharedFieldId. Empty string means not linked. */
  links: Record<string, string>;
  /** configurableId → override value. Empty string means fall back to template default. */
  overrides: Record<string, string>;
}

export interface MultirunEntryStatus {
  state: 'pending' | 'running' | 'done' | 'error';
  progress: number;
  resultUrl?: string;
  error?: string;
}

export interface MultirunRunPayload {
  entries: MultirunEntry[];
  sharedFields: MultirunSharedField[];
}

export interface MultirunPreset {
  id: string;
  book_id: string;
  name: string;
  presetData: {
    sharedFields: MultirunSharedField[];
    entries: MultirunEntry[];
  };
  created_at: string;
}
