export type ServerConfig = {
  port: number;
  stagingReadyDelayMs: number;
};

const DEFAULT_STAGING_READY_DELAY_MS = process.env.NODE_ENV === "production" ? 0 : 12000;

export const serverConfig: ServerConfig = {
  port: Number.parseInt(process.env.PORT ?? "8080", 10),
  stagingReadyDelayMs: Math.max(
    0,
    Number.parseInt(
      process.env.TEMPO_STAGING_READY_DELAY_MS ?? `${DEFAULT_STAGING_READY_DELAY_MS}`,
      10,
    ) || 0,
  ),
};
