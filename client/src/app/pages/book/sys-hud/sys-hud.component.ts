import {
  Component,
  OnDestroy,
  OnInit,
  effect,
  input,
  signal,
} from '@angular/core';

@Component({
  selector: 'app-sys-hud',
  standalone: true,
  templateUrl: './sys-hud.component.html',
  styleUrl: './sys-hud.component.scss',
})
export class SysHudComponent implements OnInit, OnDestroy {
  proxiedEndpoint = input.required<string>();
  tunnelVersion = input<string>('');
  tunnelVersionMismatch = input<boolean>(false);
  jobRunning = input<boolean>(false);
  /** When true, collapse the HUD */
  forceCollapse = input<boolean>(false);

  systemStats = signal<{
    os: string;
    ram_total: number;
    ram_free: number;
    comfyui_version: string;
    devices: Array<{
      name: string;
      vram_total: number;
      vram_free: number;
      torch_vram_total: number;
      torch_vram_free: number;
    }>;
  } | null>(null);

  open = signal<boolean>(true);
  freeBusy = signal<boolean>(false);

  private sysStatsTimer: ReturnType<typeof setInterval> | null = null;
  private sysStatsActivityTimer: ReturnType<typeof setTimeout> | null = null;
  private sysStatsUserActive = true;
  private sysStatsLastThrottle = 0;
  private readonly sysStatsActivityHandler = () => this.onSysStatsActivity();
  private readonly sysStatsVisibilityHandler = () => this.rescheduleSysStatsPoll();

  constructor() {
    effect(() => {
      if (this.forceCollapse()) this.open.set(false);
    });
  }

  ngOnInit(): void {
    this.startSysStatsPoll();
  }

  ngOnDestroy(): void {
    if (this.sysStatsTimer) {
      clearInterval(this.sysStatsTimer);
      this.sysStatsTimer = null;
    }
    if (this.sysStatsActivityTimer) {
      clearTimeout(this.sysStatsActivityTimer);
      this.sysStatsActivityTimer = null;
    }
    const events = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll'];
    events.forEach((e) => document.removeEventListener(e, this.sysStatsActivityHandler));
    document.removeEventListener('visibilitychange', this.sysStatsVisibilityHandler);
  }

  private startSysStatsPoll(): void {
    this.fetchSystemStats();
    this.sysStatsUserActive = true;
    this.rescheduleSysStatsPoll();
    const events = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll'];
    events.forEach((e) =>
      document.addEventListener(e, this.sysStatsActivityHandler, { passive: true }),
    );
    document.addEventListener('visibilitychange', this.sysStatsVisibilityHandler);
  }

  private onSysStatsActivity(): void {
    const now = Date.now();
    const wasActive = this.sysStatsUserActive;
    this.sysStatsUserActive = true;
    if (now - this.sysStatsLastThrottle > 1000) {
      this.sysStatsLastThrottle = now;
      if (this.sysStatsActivityTimer) clearTimeout(this.sysStatsActivityTimer);
      this.sysStatsActivityTimer = setTimeout(() => {
        this.sysStatsUserActive = false;
        this.rescheduleSysStatsPoll();
      }, 30_000);
    }
    if (!wasActive) this.rescheduleSysStatsPoll();
  }

  private rescheduleSysStatsPoll(): void {
    if (this.sysStatsTimer) {
      clearInterval(this.sysStatsTimer);
      this.sysStatsTimer = null;
    }
    if (document.hidden || !this.sysStatsUserActive) return;
    const ms = this.jobRunning() ? 1000 : 2000;
    this.sysStatsTimer = setInterval(() => this.fetchSystemStats(), ms);
  }

  private async fetchSystemStats(): Promise<void> {
    try {
      const res = await fetch(`${this.proxiedEndpoint()}/system_stats`);
      if (!res.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();
      this.systemStats.set({
        os: data.system?.os ?? '',
        ram_total: data.system?.ram_total ?? 0,
        ram_free: data.system?.ram_free ?? 0,
        comfyui_version: data.system?.comfyui_version ?? '',
        devices: (data.devices ?? []).map((d: any) => ({
          name: d.name ?? '',
          vram_total: d.vram_total ?? 0,
          vram_free: d.vram_free ?? 0,
          torch_vram_total: d.torch_vram_total ?? 0,
          torch_vram_free: d.torch_vram_free ?? 0,
        })),
      });
    } catch {
      /* non-critical */
    }
  }

  sysGb(bytes: number): string {
    return (bytes / 1_073_741_824).toFixed(1);
  }

  sysPctUsed(total: number, free: number): number {
    if (!total) return 0;
    return Math.round(((total - free) / total) * 100);
  }

  sysBarColor(pctUsed: number): string {
    if (pctUsed >= 85) return '#f87171';
    if (pctUsed >= 65) return '#fbbf24';
    return '#4ade80';
  }

  sysDeviceShortName(name: string): string {
    const m = name.match(/RTX\s+\S+|GTX\s+\S+|RX\s+\S+|Arc\s+\S+/i);
    return m ? m[0] : name.split(':')[0].trim();
  }

  async sysUnloadAndFree(): Promise<void> {
    if (this.freeBusy()) return;
    this.freeBusy.set(true);
    try {
      await fetch(`${this.proxiedEndpoint()}/free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      });
    } catch {
      /* non-critical */
    }
    setTimeout(() => this.freeBusy.set(false), 3000);
  }
}
