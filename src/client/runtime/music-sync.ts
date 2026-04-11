export type ReactiveBands = {
  low: number;
  mid: number;
  high: number;
};

// Shared AudioContext unlocked during a user gesture. iOS Safari requires
// either creating a context OR calling resume() inside the gesture task;
// anything created after an await is stuck in "suspended" and will produce
// silence even if later resumed. See unlockAudioContext() below.
let sharedContext: AudioContext | null = null;

export function unlockAudioContext(): void {
  // Must be called synchronously inside a user gesture handler. Each step
  // is independent and failures do not cascade, so one broken call path
  // (e.g., closed context, unsupported API) cannot leave sharedContext in
  // a poisoned state.

  // If a previous context is closed (teardown, backgrounded tab), discard
  // it here so we create a fresh one in the same gesture.
  if (sharedContext && sharedContext.state === "closed") {
    sharedContext = null;
  }

  if (!sharedContext) {
    try {
      sharedContext = new AudioContext();
    } catch {
      sharedContext = null;
      return;
    }
  }

  // resume() is best-effort. On desktop Chrome it's a no-op. On iOS WebKit
  // inside a gesture it transitions suspended -> running. If it rejects,
  // we keep the context - worst case we fall back to MusicSync's own
  // retry-on-gesture path.
  if (sharedContext.state === "suspended") {
    try {
      void sharedContext.resume().catch(() => {});
    } catch {
      // Fall through.
    }
  }

  // Silent 1-sample buffer primes the output graph on older iOS versions
  // that need an actual source.start() call inside the gesture. Failures
  // here are non-fatal; the context itself is still usable.
  try {
    const buffer = sharedContext.createBuffer(1, 1, 22050);
    const source = sharedContext.createBufferSource();
    source.buffer = buffer;
    source.connect(sharedContext.destination);
    source.start(0);
  } catch {
    // Non-fatal.
  }
}

export class MusicSync {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array<ArrayBuffer> | null = null;
  private readonly smoothedBands: ReactiveBands = { low: 0, mid: 0, high: 0 };
  private startCtxTime = 0;
  private started = false;
  private rawData: ArrayBuffer | null = null;

  async load(url: string): Promise<void> {
    this.primeAudioContext();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load music: ${response.status} ${url}`);
    this.rawData = await response.arrayBuffer();
    if (this.ctx && !this.buffer) {
      this.buffer = await this.ctx.decodeAudioData(this.rawData.slice(0));
    }
  }

  play(): void {
    if (this.started || !this.rawData) return;
    void this.startPlayback();
  }

  getCurrentTime(): number {
    if (!this.ctx) return 0;
    return this.ctx.currentTime - this.startCtxTime;
  }

  getReactiveBands(): ReactiveBands | null {
    if (!this.analyser || !this.analyserData) return null;

    this.analyser.getByteFrequencyData(this.analyserData);
    const low = this.averageBand(0, 12);
    const mid = this.averageBand(12, 68);
    const high = this.averageBand(68, this.analyserData.length);

    this.smoothedBands.low = this.smoothBand(this.smoothedBands.low, low);
    this.smoothedBands.mid = this.smoothBand(this.smoothedBands.mid, mid);
    this.smoothedBands.high = this.smoothBand(this.smoothedBands.high, high);

    return { ...this.smoothedBands };
  }

  pause(): void {
    this.ctx?.suspend();
  }

  resume(): void {
    this.ctx?.resume();
  }

  stop(): void {
    window.removeEventListener("keydown", this.retryOnGesture);
    window.removeEventListener("click", this.retryOnGesture);
    if (this.source) {
      try {
        this.source.stop(0);
      } catch {
        // Source may already be stopped.
      }
      this.source.disconnect();
      this.source = null;
    }
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.ctx) {
      // Don't close the shared unlocked context - it's reused across races
      // and closing it would require another user gesture to unlock.
      if (this.ctx !== sharedContext) {
        void this.ctx.close();
      }
      this.ctx = null;
    }
    this.startCtxTime = 0;
    this.smoothedBands.low = 0;
    this.smoothedBands.mid = 0;
    this.smoothedBands.high = 0;
    this.buffer = null;
    this.rawData = null;
    this.started = false;
  }

  private async startPlayback(): Promise<void> {
    if (this.started || !this.rawData) return;

    try {
      this.started = true;
      if (!this.ctx) {
        this.ctx = new AudioContext();
      }

      if (this.ctx.state === "suspended") {
        await this.ctx.resume();
      }

      if (!this.buffer) {
        this.buffer = await this.ctx.decodeAudioData(this.rawData.slice(0));
      }

      this.source = this.ctx.createBufferSource();
      this.source.buffer = this.buffer;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.82;
      this.analyserData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
      this.source.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.source.start(0);
      this.startCtxTime = this.ctx.currentTime;
    } catch (e) {
      this.started = false;
      console.warn("Music playback failed:", e);
      window.addEventListener("keydown", this.retryOnGesture, { once: true });
      window.addEventListener("click", this.retryOnGesture, { once: true });
    }
  }

  private readonly retryOnGesture = (): void => {
    window.removeEventListener("keydown", this.retryOnGesture);
    window.removeEventListener("click", this.retryOnGesture);
    void this.startPlayback();
  };

  private primeAudioContext(): void {
    if (this.ctx) return;
    if (sharedContext && sharedContext.state !== "closed") {
      this.ctx = sharedContext;
      return;
    }
    // No usable shared context (unlock was never called, creation failed,
    // or a prior teardown closed it). Fall back to the legacy per-instance
    // path so desktop and any non-iOS browser still work.
    try {
      this.ctx = new AudioContext();
    } catch {
      this.ctx = null;
    }
  }

  private averageBand(start: number, end: number): number {
    if (!this.analyserData || end <= start) return 0;

    let sum = 0;
    const clampedEnd = Math.min(end, this.analyserData.length);
    for (let i = start; i < clampedEnd; i++) {
      sum += this.analyserData[i];
    }

    const count = Math.max(1, clampedEnd - start);
    return sum / count / 255;
  }

  private smoothBand(previous: number, next: number): number {
    return previous * 0.74 + next * 0.26;
  }
}
