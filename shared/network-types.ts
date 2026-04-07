export type ClientMessage =
  | {
      type: "input";
      throttle: number;
      steering: number;
      boost: boolean;
      fire: boolean;
      shield: boolean;
      tick: number;
    }
  | {
      type: "ping";
      sentAt: number;
    };

export type ServerMessage =
  | {
      type: "server.ready";
      message: string;
    }
  | {
      type: "echo";
      payload: string;
    };
