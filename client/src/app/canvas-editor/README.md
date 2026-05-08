# CanvasEditorComponent

A fully-featured, embeddable canvas editor for Angular 17+.  
Dark-themed, layer-based, with a minimal context-menu-first UI.

---

## Quick Start

### 1. Copy the `canvas-editor/` folder into your project's `src/app/`

### 2. Add `CanvasEditorComponent` to your root `AppComponent`

```html
<!-- app.component.html -->
<app-canvas-editor></app-canvas-editor>
<button (click)="openEditor()">Open Editor</button>
```

```ts
// app.component.ts
import { Component } from '@angular/core';
import { CanvasEditorComponent, CanvasEditorService } from './canvas-editor';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CanvasEditorComponent],
  templateUrl: './app.component.html',
})
export class AppComponent {
  constructor(private editorSvc: CanvasEditorService) {}

  openEditor() {
    this.editorSvc.open({
      branding: {
        name: 'My App',
        accentColor: '#0ea5e9',
      },
      initialWidth: 1200,
      initialHeight: 800,
    }).subscribe(result => {
      if (result) {
        console.log('Image DataURL:', result.dataUrl);
        console.log('State (for save/resume):', result.state);
        // Upload result.dataUrl to your server
      }
    });
  }
}
```

> **Important**: The `<app-canvas-editor>` tag must be present somewhere in the DOM
> at all times (typically in your root component). It renders as an invisible overlay
> and opens on demand via `CanvasEditorService.open()`.

---

## API Reference

### `CanvasEditorService`

| Method | Signature | Description |
|--------|-----------|-------------|
| `open` | `(config?: CanvasEditorConfig) => Observable<CanvasEditorResult \| null>` | Open the editor. Emits when Done (result) or Cancel (null). |

### `CanvasEditorConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `branding.name` | `string` | `'Canvas Editor'` | Title shown in header |
| `branding.logoUrl` | `string` | — | URL to logo image |
| `branding.accentColor` | `string` | `'#7c3aed'` | CSS color for accent/Done button |
| `initialWidth` | `number` | `1200` | Starting canvas width in px |
| `initialHeight` | `number` | `800` | Starting canvas height in px |
| `initialState` | `CanvasEditorSaveState` | — | Resume a previously saved session |

### `CanvasEditorResult`

| Property | Type | Description |
|----------|------|-------------|
| `dataUrl` | `string` | Base64 PNG of the composited image |
| `width` | `number` | Canvas width |
| `height` | `number` | Canvas height |
| `state` | `CanvasEditorSaveState` | Full serializable state for save/resume |

---

## Features

### Tools (keyboard shortcuts)
| Key | Tool |
|-----|------|
| `V` | Select / Move layer |
| `B` | Brush |
| `E` | Eraser |
| `T` | Text |
| `G` | Flood Fill |
| `I` | Eyedropper |
| `[` / `]` | Decrease / Increase brush size |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Space+Drag` | Pan canvas |
| `Scroll Wheel` | Zoom |

### Layers
- Add empty raster layers, image layers from file upload, or image layers from URL
- Drag-and-drop reorder in the layers panel
- Toggle visibility, lock, opacity, blend mode
- Duplicate, merge down, flatten all
- Non-destructive per-layer masks (white = show, black = hide)
- Rename by double-clicking (or via context menu)

### Context Menus
- **Right-click on canvas**: Add layer, resize canvas, fit to window, flatten
- **Right-click on layer item**: Duplicate, move up/down, add/remove mask, merge down, delete

### Export
```ts
// The result.dataUrl is a PNG you can use directly:
const formData = new FormData();
const blob = await (await fetch(result.dataUrl)).blob();
formData.append('image', blob, 'canvas-export.png');
await fetch('/api/upload', { method: 'POST', body: formData });
```

### Save & Resume
```ts
// On done, persist the state:
localStorage.setItem('canvasState', JSON.stringify(result.state));

// On next open, restore:
const saved = localStorage.getItem('canvasState');
this.editorSvc.open({
  initialState: saved ? JSON.parse(saved) : undefined,
});
```

---

## Styling / Theming

CSS custom property for accent color (alternative to config):

```css
app-canvas-editor {
  --ce-accent: #0ea5e9;
}
```

The editor requires the following peer fonts (loaded via Google Fonts in the component SCSS):
- `DM Sans` (UI text)
- `JetBrains Mono` (labels, dimensions, metadata)

---

## Requirements

- Angular **17+** (standalone components, signals, control flow `@if`/`@for`)
- SCSS support in your Angular build
- No additional npm packages required

---

## Notes

- CORS note: importing images from external URLs requires the image server to allow `crossOrigin = 'anonymous'`.
- The undo stack is per-layer and limited to 20 steps by default (configurable via `MAX_UNDO`).
- All drawing and compositing happens on the main thread using Canvas 2D API.
