export type ReactiveBands = {
  low: number;
  mid: number;
  high: number;
};

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
    // Fetch the audio data but don't create AudioContext yet (needs user gesture)
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load music: ${response.status} ${url}`);
    this.rawData = await response.arrayBuffer();
  }

  play(): void {
    if (this.started || !this.rawData) return;
    // Defer actual playback to the first user interaction
    const startOnGesture = async () => {
      if (this.started) return;
      this.started = true;
      try {
        this.ctx = new AudioContext();
        this.buffer = await this.ctx.decodeAudioData(this.rawData!);
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
        console.warn("Music playback failed:", e);
      }
      window.removeEventListener("keydown", startOnGesture);
      window.removeEventListener("click", startOnGesture);
    };
    window.addEventListener("keydown", startOnGesture, { once: true });
    window.addEventListener("click", startOnGesture, { once: true });
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
      void this.ctx.close();
      this.ctx = null;
    }
    this.startCtxTime = 0;
    this.smoothedBands.low = 0;
    this.smoothedBands.mid = 0;
    this.smoothedBands.high = 0;
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
