import { Component, ElementRef, ViewChild, input, signal } from '@angular/core';

@Component({
  selector: 'app-image-compare',
  standalone: true,
  templateUrl: './image-compare.component.html',
  styleUrl: './image-compare.component.scss',
})
export class ImageCompareComponent {
  afterURL = input.required<string>();
  beforeURL = input.required<string>();
  altText = input<string>('');
  panX = input<number>(0);
  panY = input<number>(0);
  zoom = input<number>(1);

  @ViewChild('compareWrap') compareWrapRef?: ElementRef<HTMLElement>;
  split = signal<number>(50);

  startCompareDrag(event: PointerEvent): void {
    event.stopPropagation();
    event.preventDefault();

    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);

    const onMove = (e: PointerEvent) => {
      const wrap = this.compareWrapRef?.nativeElement;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      this.split.set(x);
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }
}
