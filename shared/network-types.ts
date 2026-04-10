export type ClientMessage =
  | {
      type: "input";
      throttle: number;
      steering: number;
      airbrakeLeft: boolean;
      airbrakeRight: boolean;
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
