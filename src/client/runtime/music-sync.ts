export class MusicSync {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private startCtxTime = 0;

  async load(url: string): Promise<void> {
    this.ctx = new AudioContext();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load music: ${response.status} ${url}`);
    const arrayBuffer = await response.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
  }

  play(): void {
    if (!this.ctx || !this.buffer) return;
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.ctx.destination);
    this.source.start(0);
    this.startCtxTime = this.ctx.currentTime;
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
