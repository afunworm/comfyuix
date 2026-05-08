import { Injectable, inject, signal } from '@angular/core';
import { Dialog } from '../../../dialog';
import { ContextMenuService } from '../../../context-menu/context-menu.service';

// CRC32 lookup table for PNG chunk checksums
const PNG_CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

@Injectable()
export class LayerPanelService {
  private dialog = inject(Dialog);
  private contextMenu = inject(ContextMenuService);

  maskLayer = signal<{ visible: boolean } | null>(null);
  layerPanelOpen = signal<boolean>(false);
  layerPanelPos = signal<{ x: number; y: number }>({ x: 12, y: 12 });
  layerPanelDragging = signal<boolean>(false);
  activeTool = signal<'none' | 'brush' | 'eraser' | 'polygon'>('none');
  brushCursorPos = signal<{ x: number; y: number } | null>(null);
  brushCursorRadius = signal<number>(24);
  brushSize = signal<number>(24);
  brushHardness = signal<number>(100);
  brushShape = signal<'circle' | 'square'>('circle');
  spacePanning = signal<boolean>(false);

  /** Each point stores stage coords (for SVG display) and canvas buffer coords (for fill, recorded at click time). */
  polygonPoints = signal<{ sx: number; sy: number; cx: number; cy: number }[]>([]);
  polygonPreviewPos = signal<{ x: number; y: number } | null>(null);

  /** Set by Book after canvas renders */
  canvas: HTMLCanvasElement | null = null;
  /** Set by Book in ngAfterViewInit */
  stageEl: HTMLElement | null = null;
  /** Updated by Book via effect */
  canvasNaturalSize: { w: number; h: number } | null = null;
  /** Updated by Book via effect */
  resultPhotoURL: string = '';
  /** Tracks whether any pixels have been drawn since the mask was created */
  private maskHasContent = false;

  addMaskLayer(restoreLayerData?: string): void {
    if (this.maskLayer()) return;
    const size = this.canvasNaturalSize;
    if (!size) {
      this.dialog.alert('Generate or load an image first before adding a mask layer.');
      return;
    }
    this.maskLayer.set({ visible: true });
    this.activeTool.set('brush');
    this.layerPanelOpen.set(true);
    this.maskHasContent = false;
    const trySize = (attempts: number) => {
      const canvas = this.canvas;
      if (canvas) {
        // Use offsetWidth/offsetHeight: layout dimensions pre-CSS-transform.
        // Matches the actual display aspect ratio (handles EXIF-rotated images)
        // and stays stable regardless of zoom level.
        const w = canvas.offsetWidth;
        const h = canvas.offsetHeight;
        if (w > 0 && h > 0) {
          canvas.width = w;
          canvas.height = h;
          if (restoreLayerData) {
            const img = new Image();
            img.onload = () => {
              canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
              this.maskHasContent = true;
            };
            img.src = `data:image/png;base64,${restoreLayerData}`;
          }
        }
      } else if (attempts > 0) {
        requestAnimationFrame(() => trySize(attempts - 1));
      }
    };
    requestAnimationFrame(() => trySize(5));
  }

  removeMaskLayer(): void {
    this.maskLayer.set(null);
    this.activeTool.set('none');
    this.polygonPoints.set([]);
    this.polygonPreviewPos.set(null);
    this.maskHasContent = false;
  }

  toggleMaskVisibility(): void {
    const layer = this.maskLayer();
    if (!layer) return;
    this.maskLayer.set({ ...layer, visible: !layer.visible });
  }

  clearMask(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.maskHasContent = false;
  }

  invertMask(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.data.length; i += 4) {
      const a = data.data[i + 3];
      // invert: painted → unpainted, unpainted → painted (full red)
      data.data[i] = 255;
      data.data[i + 1] = 0;
      data.data[i + 2] = 0;
      data.data[i + 3] = 255 - a;
    }
    ctx.putImageData(data, 0, 0);
  }

  setBrushSize(val: string): void {
    this.brushSize.set(Math.max(2, Math.min(200, +val)));
  }

  setBrushHardness(val: string): void {
    this.brushHardness.set(Math.max(0, Math.min(100, +val)));
  }

  updateBrushCursor(e: PointerEvent): void {
    if (this.activeTool() === 'none' || this.spacePanning()) return;
    const stage = this.stageEl;
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const x = e.clientX - stageRect.left;
    const y = e.clientY - stageRect.top;

    if (this.activeTool() === 'polygon') {
      this.polygonPreviewPos.set({ x, y });
      return;
    }

    const canvas = this.canvas;
    let radius = this.brushSize();
    if (canvas) {
      const canvasRect = canvas.getBoundingClientRect();
      radius = this.brushSize() * (canvasRect.width / canvas.width);
    }
    this.brushCursorPos.set({ x, y });
    this.brushCursorRadius.set(radius);
  }

  clearCursor(): void {
    this.brushCursorPos.set(null);
    this.polygonPreviewPos.set(null);
  }

  startBrushStroke(event: PointerEvent): void {
    event.stopPropagation();
    event.preventDefault();
    const canvas = this.canvas;
    if (!canvas) return;
    // Sync buffer to current CSS layout dimensions if no content has been drawn yet.
    // Handles the case where the image finished loading after addMaskLayer ran.
    const cssW = canvas.offsetWidth;
    const cssH = canvas.offsetHeight;
    if (cssW > 0 && cssH > 0 && !this.maskHasContent &&
        (canvas.width !== cssW || canvas.height !== cssH)) {
      canvas.width = cssW;
      canvas.height = cssH;
    }
    const ctx = canvas.getContext('2d')!;
    let { x, y } = this.pointerToCanvasCoords(event, canvas);
    this.drawBrushDot(ctx, x, y);
    const onMove = (e: PointerEvent) => {
      const next = this.pointerToCanvasCoords(e, canvas);
      this.interpolateBrush(ctx, x, y, next.x, next.y);
      x = next.x;
      y = next.y;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  private pointerToCanvasCoords(
    e: PointerEvent,
    canvas: HTMLCanvasElement,
  ): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  private drawBrushDot(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    this.maskHasContent = true;
    const size = this.brushSize();
    const hardness = this.brushHardness() / 100;
    const isEraser = this.activeTool() === 'eraser';
    ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';

    if (this.brushShape() === 'square') {
      const blur = hardness >= 1 ? 0 : Math.round((1 - hardness) * size * 0.6);
      if (blur > 0) ctx.filter = `blur(${blur}px)`;
      ctx.fillStyle = isEraser ? 'rgba(0,0,0,1)' : 'rgba(255,0,0,1)';
      ctx.fillRect(x - size, y - size, size * 2, size * 2);
      if (blur > 0) ctx.filter = 'none';
    } else {
      const g = ctx.createRadialGradient(x, y, 0, x, y, size);
      const inner = Math.min(hardness, 0.999);
      if (isEraser) {
        g.addColorStop(inner, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
      } else {
        g.addColorStop(inner, 'rgba(255,0,0,1)');
        g.addColorStop(1, 'rgba(255,0,0,0)');
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private interpolateBrush(
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): void {
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const step = Math.max(1, this.brushSize() * 0.3);
    const steps = Math.ceil(dist / step);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.drawBrushDot(ctx, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
    }
  }

  openMaskLayerMenu(ev: MouseEvent): void {
    ev.stopPropagation();
    ev.preventDefault();
    this.contextMenu.open(
      ev,
      [
        { label: 'Clear Mask', run: () => this.clearMask() },
        { label: 'Invert Mask', run: () => this.invertMask() },
        { divider: true },
        { label: 'Remove Mask Layer', run: () => this.removeMaskLayer() },
      ],
      null,
    );
  }

  addPolygonPoint(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const stage = this.stageEl;
    const canvas = this.canvas;
    if (!stage) return;

    const stageRect = stage.getBoundingClientRect();
    const sx = e.clientX - stageRect.left;
    const sy = e.clientY - stageRect.top;

    // Convert to canvas buffer coords NOW (zoom-invariant once recorded)
    let cx = sx, cy = sy;
    if (canvas) {
      const cr = canvas.getBoundingClientRect();
      cx = (sx - (cr.left - stageRect.left)) * (canvas.width / cr.width);
      cy = (sy - (cr.top  - stageRect.top )) * (canvas.height / cr.height);
    }

    // Double-click (detail ≥ 2) closes the polygon
    if (e.detail >= 2) {
      if (this.polygonPoints().length >= 3) this.fillPolygon();
      return;
    }

    const points = this.polygonPoints();
    // Click near first point also closes (snap zone = 12px stage pixels)
    if (points.length >= 3) {
      const first = points[0];
      if (Math.hypot(sx - first.sx, sy - first.sy) < 12) {
        this.fillPolygon();
        return;
      }
    }
    this.polygonPoints.update(pts => [...pts, { sx, sy, cx, cy }]);
  }

  fillPolygon(): void {
    const canvas = this.canvas;
    const points = this.polygonPoints();
    if (!canvas || points.length < 3) return;

    const ctx = canvas.getContext('2d')!;
    const isEraser = this.activeTool() === 'eraser';
    ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
    ctx.fillStyle = isEraser ? 'rgba(0,0,0,1)' : 'rgba(255,0,0,1)';

    // Use canvas buffer coords recorded at click time — zoom-invariant
    ctx.beginPath();
    ctx.moveTo(points[0].cx, points[0].cy);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].cx, points[i].cy);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    this.polygonPoints.set([]);
    this.polygonPreviewPos.set(null);
  }

  cancelPolygon(): void {
    this.polygonPoints.set([]);
    this.polygonPreviewPos.set(null);
  }

  openLayerRowMenu(ev: MouseEvent, isBackground: boolean): void {
    ev.preventDefault();
    if (isBackground) {
      const items: any[] = [];
      if (!this.maskLayer()) items.push({ label: 'Add Mask Layer', run: () => this.addMaskLayer() });
      if (items.length) this.contextMenu.open(ev, items, null);
    } else {
      this.openMaskLayerMenu(ev);
    }
  }

  startLayerPanelDrag(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const stage = this.stageEl;
    const startPos = this.layerPanelPos();
    const startX = e.clientX;
    const startY = e.clientY;
    this.layerPanelDragging.set(true);
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // x is distance from RIGHT edge; moving right (dx > 0) decreases it.
      let x = startPos.x - dx;
      let y = startPos.y + dy;
      if (stage) {
        const rect = stage.getBoundingClientRect();
        x = Math.max(0, Math.min(rect.width - 192, x));
        y = Math.max(0, Math.min(rect.height - 60, y));
      }
      this.layerPanelPos.set({ x, y });
    };
    const onUp = () => {
      this.layerPanelDragging.set(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  /**
   * Exports the mask and composite at natural image resolution (zoom-independent).
   * Returns the composited PNG file (for upload) and the mask-only base64 PNG (for layer_data storage).
   */
  async exportAtNaturalResolution(imageUrl: string): Promise<{
    compositedFile: File;
    layerDataBase64: string;
  } | null> {
    const canvas = this.canvas;
    if (!canvas || !imageUrl || imageUrl.startsWith('data:')) return null;

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = imageUrl;
    });

    const nw = img.naturalWidth;
    const nh = img.naturalHeight;

    // Scale mask canvas up to natural resolution
    const maskNatural = document.createElement('canvas');
    maskNatural.width = nw;
    maskNatural.height = nh;
    maskNatural.getContext('2d')!.drawImage(canvas, 0, 0, nw, nh);

    // Draw image at natural resolution to read its raw pixel values
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = nw;
    srcCanvas.height = nh;
    const srcCtx = srcCanvas.getContext('2d')!;
    srcCtx.drawImage(img, 0, 0, nw, nh);

    const imgData = srcCtx.getImageData(0, 0, nw, nh);
    const maskData = maskNatural.getContext('2d')!.getImageData(0, 0, nw, nh);

    // Set alpha directly in the raw pixel buffer WITHOUT going back through canvas,
    // so premultiplied-alpha does not zero out the RGB channels in masked areas.
    // The original R/G/B values are preserved — only alpha changes.
    for (let i = 0; i < imgData.data.length / 4; i++) {
      imgData.data[i * 4 + 3] = 255 - maskData.data[i * 4]; // painted → alpha 0, rest → opaque
    }

    // Encode directly to PNG bytes — bypasses canvas putImageData/toBlob so the
    // premultiplied-alpha round-trip cannot zero out RGB channels for alpha=0 pixels.
    const pngBlob = await this._encodePng(imgData.data, nw, nh);
    const compositedFile = new File([pngBlob], `edited_${Date.now()}.png`, { type: 'image/png' });

    // Mask-only at natural res as base64 (strip data URL prefix)
    const layerDataBase64 = maskNatural.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');

    return { compositedFile, layerDataBase64 };
  }

  /** Encode raw RGBA pixels as a valid PNG, preserving RGB even when alpha=0. */
  private async _encodePng(pixels: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
    // Filter scanlines: prepend filter-type byte 0 (None) before each row
    const rowBytes = width * 4;
    const filtered = new Uint8Array((rowBytes + 1) * height);
    for (let y = 0; y < height; y++) {
      filtered[y * (rowBytes + 1)] = 0; // filter type None
      filtered.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
    }

    // Compress with zlib (CompressionStream('deflate') = RFC 1950, required by PNG)
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(filtered);
    writer.close();
    const parts: Uint8Array[] = [];
    const reader = cs.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const compressedLen = parts.reduce((s, p) => s + p.length, 0);
    const compressed = new Uint8Array(compressedLen);
    let off = 0;
    for (const p of parts) { compressed.set(p, off); off += p.length; }

    // IHDR payload: width, height, bit-depth=8, color-type=6 (RGBA)
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, width);
    new DataView(ihdr.buffer).setUint32(4, height);
    ihdr[8] = 8; ihdr[9] = 6; // bit depth, RGBA

    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrChunk = this._pngChunk('IHDR', ihdr);
    const idatChunk = this._pngChunk('IDAT', compressed);
    const iendChunk = this._pngChunk('IEND', new Uint8Array(0));

    return new Blob([sig, ihdrChunk, idatChunk, iendChunk] as BlobPart[], { type: 'image/png' });
  }

  private _pngChunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new TextEncoder().encode(type);
    const combined = new Uint8Array(4 + data.length);
    combined.set(typeBytes);
    combined.set(data, 4);
    let crc = 0xffffffff;
    for (let i = 0; i < combined.length; i++) crc = PNG_CRC_TABLE[(crc ^ combined[i]) & 0xff] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    view.setUint32(8 + data.length, crc);
    return chunk;
  }

  async compositeCanvasWithMask(): Promise<File | null> {
    const canvas = this.canvas;
    const url = this.resultPhotoURL;
    if (!canvas || !url || url.startsWith('data:')) return null;
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(img, 0, 0, out.width, out.height);
    const imgData = ctx.getImageData(0, 0, out.width, out.height);
    const maskData = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < imgData.data.length / 4; i++) {
      imgData.data[i * 4 + 3] = maskData.data[i * 4]; // red channel → alpha
    }
    ctx.putImageData(imgData, 0, 0);
    return new Promise((resolve) => {
      out.toBlob(
        (blob) => {
          resolve(
            blob ? new File([blob], `masked_${Date.now()}.png`, { type: 'image/png' }) : null,
          );
        },
        'image/png',
      );
    });
  }
}
