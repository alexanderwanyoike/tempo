import type { ClientMessage, ServerMessage } from "../../../shared/network-types";

export class RoomClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;

  onMessage: ((message: ServerMessage) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(private readonly url: string) {}

  async ensureConnected(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.addEventListener("open", () => {
        resolve();
      }, { once: true });

      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          this.onMessage?.(message);
        } catch (error) {
          console.error("Failed to parse server message:", error);
        }
      });

      socket.addEventListener("close", () => {
        this.socket = null;
        this.connectPromise = null;
        this.onClose?.();
      });

      socket.addEventListener("error", (error) => {
        reject(error);
      }, { once: true });
    });

    return this.connectPromise;
  }

  send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
    this.connectPromise = null;
  }
}
