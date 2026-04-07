export type ServerConfig = {
  port: number;
};

export const serverConfig: ServerConfig = {
  port: Number.parseInt(process.env.PORT ?? "8080", 10),
};
