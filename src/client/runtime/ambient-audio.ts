// Looping background audio for menu and lobby screens.
//
// Uses HTMLAudioElement rather than AudioContext decoding because we only
// need a single looping source with volume control - no FFT, no beat sync.
// That keeps this cheap and decouples it from the race's MusicSync pipeline.
//
// iOS WebKit still gesture-locks HTMLAudioElement.play(), so play() is
// best-effort and installs a one-shot click/keydown listener to retry on
// the next user interaction if the browser rejects the initial call.

export class AmbientAudio {
  private readonly audio: HTMLAudioElement;
  private wantPlaying = false;
  private gestureListenerAttached = false;

  constructor(url: string) {
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.loop = true;
    audio.volume = 0.4;
    audio.src = url;
    this.audio = audio;
  }

  play(): void {
    this.wantPlaying = true;
    this.tryPlay();
  }

  pause(): void {
    this.wantPlaying = false;
    this.removeGestureListener();
    try {
      this.audio.pause();
    } catch {
      // Non-fatal.
    }
  }

  setVolume(value: number): void {
    this.audio.volume = Math.max(0, Math.min(1, value));
  }

  private tryPlay(): void {
    if (!this.wantPlaying) return;
    const result = this.audio.play();
    if (result && typeof result.catch === "function") {
      result.catch(() => {
        if (this.wantPlaying) this.attachGestureListener();
      });
    }
  }

  private attachGestureListener(): void {
    if (this.gestureListenerAttached) return;
    this.gestureListenerAttached = true;
    window.addEventListener("click", this.handleGesture, { once: true });
    window.addEventListener("keydown", this.handleGesture, { once: true });
    window.addEventListener("touchstart", this.handleGesture, { once: true });
  }

  private removeGestureListener(): void {
    if (!this.gestureListenerAttached) return;
    this.gestureListenerAttached = false;
    window.removeEventListener("click", this.handleGesture);
    window.removeEventListener("keydown", this.handleGesture);
    window.removeEventListener("touchstart", this.handleGesture);
  }

  private readonly handleGesture = (): void => {
    this.gestureListenerAttached = false;
    window.removeEventListener("click", this.handleGesture);
    window.removeEventListener("keydown", this.handleGesture);
    window.removeEventListener("touchstart", this.handleGesture);
    this.tryPlay();
  };
}
