import { Component, HostListener, inject } from '@angular/core';
import { LayerPanelService } from './layer-panel.service';

@Component({
  selector: 'app-layer-panel',
  standalone: true,
  imports: [],
  templateUrl: './layer-panel.component.html',
  styleUrl: './layer-panel.component.scss',
})
export class LayerPanelComponent {
  readonly lp = inject(LayerPanelService);

  @HostListener('document:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent) {
    const tool = this.lp.activeTool();
    if (tool === 'none') return;

    // Space → temporary pan mode (skip when focus is inside a text input)
    if (e.code === 'Space' && !e.repeat) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      this.lp.spacePanning.set(true);
      this.lp.clearCursor();
      return;
    }

    // Escape
    if (e.key === 'Escape') {
      if (tool === 'polygon' && this.lp.polygonPoints().length > 0) {
        this.lp.cancelPolygon(); // cancel in-progress path, stay in polygon mode
      } else {
        this.lp.activeTool.set('none'); // exit mask editing, preserve mask
        this.lp.cancelPolygon();
      }
    }
  }

  @HostListener('document:keyup', ['$event'])
  onKeyUp(e: KeyboardEvent) {
    if (e.code === 'Space') this.lp.spacePanning.set(false); // always release on keyup
  }

  polygonPointsAttr(): string {
    return this.lp.polygonPoints().map(p => `${p.sx},${p.sy}`).join(' ');
  }
}
