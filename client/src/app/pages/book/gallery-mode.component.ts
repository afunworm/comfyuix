import { Component, computed, effect, ElementRef, input, output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoredImageAsset } from '../../comfyui/comfyui-asset-storage.service';

@Component({
  selector: 'app-gallery-mode',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './gallery-mode.component.html',
  styleUrl: './gallery-mode.component.scss',
})
export class GalleryModeComponent {
  active = input<boolean>(false);
  assets = input<StoredImageAsset[]>([]);
  activeIndex = input<number>(0);

  closed = output<void>();
  navigateTo = output<number>();

  @ViewChild('filmstrip') filmstripRef?: ElementRef<HTMLElement>;

  current = computed(() => this.assets()[this.activeIndex()] ?? null);

  constructor() {
    effect(() => {
      const idx = this.activeIndex();
      this.assets(); // read to track
      setTimeout(() => this.centerActiveThumb(idx));
    });
  }

  private centerActiveThumb(idx: number): void {
    const strip = this.filmstripRef?.nativeElement;
    if (!strip) return;
    const thumb = strip.children[idx] as HTMLElement | undefined;
    if (!thumb) return;
    const target = thumb.offsetLeft - (strip.clientWidth - thumb.offsetWidth) / 2;
    strip.scrollTo({ left: target, behavior: 'smooth' });
  }

  navigate(delta: number): void {
    const len = this.assets().length;
    if (len < 2) return;
    this.navigateTo.emit((this.activeIndex() + delta + len) % len);
  }

  goTo(idx: number, el: HTMLElement): void {
    el.blur();
    if (idx !== this.activeIndex()) this.navigateTo.emit(idx);
  }
}
