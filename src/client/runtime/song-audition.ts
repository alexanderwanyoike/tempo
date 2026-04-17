export type SongAuditionState =
  | {
      songId: null;
      status: "idle";
      error: null;
    }
  | {
      songId: string;
      status: "loading" | "playing" | "error";
      error: string | null;
    };

export class SongAuditionPlayer {
  onStateChange: ((state: SongAuditionState) => void) | null = null;

  private audio: HTMLAudioElement | null = null;
  private state: SongAuditionState = { songId: null, status: "idle", error: null };
  private playToken = 0;
  private previewEndTime = 0;

  async toggle(songId: string, url: string, startTime = 0, duration = 22): Promise<boolean> {
    if (this.state.songId === songId && this.state.status === "playing") {
      this.stop();
      return false;
    }
    await this.play(songId, url, startTime, duration);
    return true;
  }

  async play(songId: string, url: string, startTime = 0, duration = 22): Promise<void> {
    this.stop();

    const token = ++this.playToken;
    const audio = new Audio(url);
    this.audio = audio;
    this.previewEndTime = Math.max(0, startTime) + Math.max(8, duration);
    audio.preload = "auto";
    audio.setAttribute("playsinline", "true");
    audio.addEventListener("timeupdate", this.handleTimeUpdate);
    audio.addEventListener("ended", this.handleEnded);
    audio.addEventListener("error", this.handleError);
    audio.addEventListener("loadedmetadata", () => {
      if (token !== this.playToken || !this.audio) return;
      try {
        const safeStart = Math.min(Math.max(0, startTime), Math.max(0, audio.duration - 0.5));
        audio.currentTime = safeStart;
      } catch {
        // Preview can still play from the start if seeking is blocked.
      }
    }, { once: true });

    this.setState({ songId, status: "loading", error: null });

    try {
      await audio.play();
      if (token !== this.playToken) {
        this.disposeAudio(audio);
        return;
      }
      this.setState({ songId, status: "playing", error: null });
    } catch {
      if (token !== this.playToken) return;
      this.disposeAudio(audio);
      this.setState({ songId, status: "error", error: "Preview unavailable." });
    }
  }

  stop(): void {
    this.playToken += 1;
    this.disposeAudio(this.audio);
    this.setState({ songId: null, status: "idle", error: null });
  }

  destroy(): void {
    this.stop();
  }

  private readonly handleTimeUpdate = (): void => {
    if (!this.audio) return;
    if (this.audio.currentTime >= this.previewEndTime) {
      this.stop();
    }
  };

  private readonly handleEnded = (): void => {
    this.stop();
  };

  private readonly handleError = (): void => {
    const songId = this.state.songId;
    this.disposeAudio(this.audio);
    if (!songId) {
      this.setState({ songId: null, status: "idle", error: null });
      return;
    }
    this.setState({ songId, status: "error", error: "Preview unavailable." });
  };

  private disposeAudio(audio: HTMLAudioElement | null): void {
    if (!audio) return;
    audio.removeEventListener("timeupdate", this.handleTimeUpdate);
    audio.removeEventListener("ended", this.handleEnded);
    audio.removeEventListener("error", this.handleError);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (this.audio === audio) {
      this.audio = null;
    }
  }

  private setState(state: SongAuditionState): void {
    this.state = state;
    this.onStateChange?.(state);
  }
}
