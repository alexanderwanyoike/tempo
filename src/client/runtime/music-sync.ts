export class MusicSync {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
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
        this.source.connect(this.ctx.destination);
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

  pause(): void {
    this.ctx?.suspend();
  }

  resume(): void {
    this.ctx?.resume();
  }
}
