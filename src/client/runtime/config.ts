export type ClientConfig = {
  websocketUrl: string;
};

export const clientConfig: ClientConfig = {
  websocketUrl: import.meta.env.VITE_WS_URL ?? "ws://localhost:8080",
};
