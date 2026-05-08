import { Component, HostListener, inject, signal, computed, OnInit } from '@angular/core';
import { DialogRef } from './dialog.service';

export interface DimCalcResult {
  w: number | null;
  h: number | null;
}

const MP_PRESETS = [1, 1.5, 2, 4] as const;

@Component({
  selector: 'app-dim-calc-modal',
  standalone: true,
  template: `
    <div class="dialog-overlay" (click)="close()">
      <div class="dim-calc" role="dialog" aria-modal="true" aria-label="Dimension Calculator" (click)="$event.stopPropagation()">

        <div class="dim-calc__head">
          <h3 class="dim-calc__title">Dimension Calculator</h3>
          <button class="btn-icon" type="button" aria-label="Close" (click)="close()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div class="dim-calc__body">

          <!-- Mode toggle -->
          <div class="dim-calc__mode-toggle">
            <button class="dim-calc__mode-btn" type="button"
              [class.is-active]="mode() === 'fix'"
              (click)="setMode('fix')">
              Fix + MP
            </button>
            <button class="dim-calc__mode-btn" type="button"
              [class.is-active]="mode() === 'ratio'"
              (click)="setMode('ratio')">
              Ratio + MP
            </button>
          </div>

          <p class="dim-calc__mode-desc">
            @if (mode() === 'fix') {
              Fix one dimension, pick a target MP — the other dimension is calculated.
            } @else {
              Enter both dimensions to define an aspect ratio, then pick a target MP to scale both.
            }
          </p>

          <!-- Width × Height -->
          <div class="dim-calc__fields">
            <div class="dim-calc__field">
              <label class="dim-calc__label">
                Width
                @if (mode() === 'fix' && lastChanged === 'w') {
                  <span class="dim-calc__anchor-badge">anchor</span>
                }
              </label>
              <div class="dim-calc__input-row">
                <input class="control dim-calc__input" type="number" min="8" step="8" placeholder="e.g. 1024"
                  [value]="w()" (input)="onWChange($any($event.target).value)" />
                <button class="btn-icon dim-calc__copy" type="button" title="Copy width"
                  [disabled]="+w() <= 0" (click)="copy(w())">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                </button>
              </div>
            </div>

            <div class="dim-calc__sep">×</div>

            <div class="dim-calc__field">
              <label class="dim-calc__label">
                Height
                @if (mode() === 'fix' && lastChanged === 'h') {
                  <span class="dim-calc__anchor-badge">anchor</span>
                }
              </label>
              <div class="dim-calc__input-row">
                <input class="control dim-calc__input" type="number" min="8" step="8" placeholder="e.g. 1024"
                  [value]="h()" (input)="onHChange($any($event.target).value)" />
                <button class="btn-icon dim-calc__copy" type="button" title="Copy height"
                  [disabled]="+h() <= 0" (click)="copy(h())">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>

          @if (currentMpLabel()) {
            <p class="dim-calc__current-mp">
              Current: <strong>{{ currentMpLabel() }} MP</strong>
            </p>
          }

          <!-- MP preset badges -->
          <div class="dim-calc__mp-row">
            <span class="dim-calc__mp-label">Calculate to:</span>
            @for (mp of presets; track mp) {
              <button class="dim-calc__mp-badge" type="button"
                [class.dim-calc__mp-badge--active]="selectedMp() === mp"
                [disabled]="mpDisabled()"
                (click)="applyMp(mp)">
                {{ mp }} MP
              </button>
            }
            <button class="dim-calc__mp-badge dim-calc__mp-badge--reset" type="button" (click)="reset()">Reset</button>
          </div>

          @if (canApplyToFlow) {
            <div class="dim-calc__apply-row">
              <button class="btn btn--primary" type="button"
                [disabled]="+w() <= 0 && +h() <= 0"
                (click)="applyToFlow()">
                Apply to Image Width &amp; Height
              </button>
            </div>
          }

        </div>
      </div>
    </div>
  `,
  styles: [`
    .dialog-overlay {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.75);
    }

    .dim-calc {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius, 10px);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
      width: min(480px, 94vw);
      display: flex;
      flex-direction: column;

      &__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid var(--border);
      }

      &__title {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
      }

      &__body {
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 20px;
      }

      &__mode-toggle {
        display: flex;
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
      }

      &__mode-btn {
        flex: 1;
        padding: 8px 12px;
        border: none;
        background: transparent;
        color: var(--muted);
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;

        &.is-active {
          background: var(--accent);
          color: #fff;
        }

        &:not(.is-active):hover {
          background: rgba(255,255,255,0.05);
          color: var(--text);
        }
      }

      &__mode-desc {
        margin: 0;
        font-size: 0.8rem;
        color: var(--muted);
        line-height: 1.4;
      }

      &__fields {
        display: flex;
        align-items: flex-end;
        gap: 12px;
      }

      &__field {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }

      &__label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      &__anchor-badge {
        font-size: 0.68rem;
        font-weight: 500;
        text-transform: none;
        letter-spacing: 0;
        padding: 1px 6px;
        border-radius: 10px;
        background: rgba(var(--accent-rgb, 100,100,220), 0.18);
        color: var(--accent);
        border: 1px solid rgba(var(--accent-rgb, 100,100,220), 0.3);
      }

      &__input-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      &__input { flex: 1; min-width: 0; }

      &__copy {
        flex-shrink: 0;
        opacity: 0.6;
        &:hover { opacity: 1; }
        &:disabled { opacity: 0.25; cursor: default; }
      }

      &__sep {
        font-size: 1.2rem;
        color: var(--muted);
        padding-bottom: 6px;
        flex-shrink: 0;
      }

      &__current-mp {
        margin: 0;
        font-size: 0.85rem;
        color: var(--muted);
        strong { color: var(--text); }
      }

      &__mp-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      &__mp-label {
        font-size: 0.82rem;
        color: var(--muted);
        flex-shrink: 0;
      }

      &__mp-badge {
        padding: 5px 14px;
        border-radius: 20px;
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text);
        font-size: 0.82rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;

        &:hover:not(:disabled) {
          background: var(--accent);
          border-color: var(--accent);
          color: #fff;
        }

        &:disabled { opacity: 0.3; cursor: default; }

        &--active {
          background: var(--accent);
          border-color: var(--accent);
          color: #fff;
        }

        &--reset {
          margin-left: auto;
          color: var(--muted);
          font-weight: 400;
          &:hover { background: rgba(255,255,255,0.06); border-color: var(--border); color: var(--text); }
        }
      }

      &__apply-row {
        border-top: 1px solid var(--border);
        padding-top: 16px;
        display: flex;
        justify-content: flex-end;
      }
    }
  `],
})
export class DimCalcModalComponent implements OnInit {
  private ref = inject(DialogRef) as DialogRef<DimCalcResult | null>;

  canApplyToFlow: boolean = false;
  initialW: number = 0;
  initialH: number = 0;

  readonly presets = MP_PRESETS;

  mode = signal<'fix' | 'ratio'>('fix');
  w = signal('0');
  h = signal('0');
  selectedMp = signal<number | null>(null);
  lastChanged: 'w' | 'h' = 'w';

  ngOnInit() {
    this.w.set(String(this.initialW));
    this.h.set(String(this.initialH));
  }

  setMode(m: 'fix' | 'ratio') {
    this.mode.set(m);
    this.selectedMp.set(null);
  }

  reset() {
    this.w.set('0');
    this.h.set('0');
    this.selectedMp.set(null);
    this.lastChanged = 'w';
  }

  onWChange(raw: string) {
    this.w.set(raw);
    this.lastChanged = 'w';
    const mp = this.selectedMp();
    if (mp !== null) this.calculate(mp);
  }

  onHChange(raw: string) {
    this.h.set(raw);
    this.lastChanged = 'h';
    const mp = this.selectedMp();
    if (mp !== null) this.calculate(mp);
  }

  currentMp = computed(() => {
    const wv = parseInt(this.w(), 10);
    const hv = parseInt(this.h(), 10);
    return wv > 0 && hv > 0 ? (wv * hv) / 1_000_000 : null;
  });

  currentMpLabel = computed(() => {
    const mp = this.currentMp();
    return mp !== null ? mp.toFixed(2).replace(/\.?0+$/, '') : null;
  });

  mpDisabled = computed(() => {
    const wv = parseInt(this.w(), 10);
    const hv = parseInt(this.h(), 10);
    if (this.mode() === 'fix') return wv <= 0 && hv <= 0;
    return wv <= 0 || hv <= 0; // ratio needs both
  });

  applyMp(mp: number) {
    this.selectedMp.set(mp);
    this.calculate(mp);
  }

  private calculate(mp: number) {
    const pixels = mp * 1_000_000;
    const wv = parseInt(this.w(), 10);
    const hv = parseInt(this.h(), 10);

    if (this.mode() === 'fix') {
      // Keep the anchor dimension, calculate the other
      if (this.lastChanged === 'w' && wv > 0) {
        this.h.set(String(this.snap(Math.round(pixels / wv))));
      } else if (this.lastChanged === 'h' && hv > 0) {
        this.w.set(String(this.snap(Math.round(pixels / hv))));
      }
    } else {
      // Ratio mode: both must be set; scale to target MP preserving aspect ratio
      if (wv > 0 && hv > 0) {
        const ratio = wv / hv;
        const newH = this.snap(Math.round(Math.sqrt(pixels / ratio)));
        const newW = this.snap(Math.round(newH * ratio));
        this.w.set(String(newW));
        this.h.set(String(newH));
      }
    }
  }

  private snap(n: number) { return Math.round(n / 8) * 8; }

  async copy(value: string) {
    try { await navigator.clipboard.writeText(value); } catch {}
  }

  applyToFlow() {
    const wv = parseInt(this.w(), 10);
    const hv = parseInt(this.h(), 10);
    this.ref.close({ w: wv > 0 ? wv : null, h: hv > 0 ? hv : null });
  }

  @HostListener('document:keydown.escape')
  close() { this.ref.close(null); }
}
