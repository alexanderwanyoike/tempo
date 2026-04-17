export type ClientConfig = {
  websocketUrl: string;
  assetBaseUrl: string;
  stagingReadyDelayMs: number;
};

const DEFAULT_STAGING_READY_DELAY_MS = import.meta.env.DEV ? 5000 : 0;

export const clientConfig: ClientConfig = {
  websocketUrl: import.meta.env.VITE_WS_URL ?? "ws://localhost:8080",
  assetBaseUrl: (import.meta.env.VITE_ASSET_BASE_URL ?? "").trim(),
  stagingReadyDelayMs: Math.max(
    0,
    Number.parseInt(
      import.meta.env.VITE_STAGING_READY_DELAY_MS ?? `${DEFAULT_STAGING_READY_DELAY_MS}`,
      10,
    ) || 0,
  ),
};

export function resolveAssetUrl(config: ClientConfig, path: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!config.assetBaseUrl) {
    return normalizedPath;
  }

  const normalizedBase = config.assetBaseUrl.endsWith("/")
    ? config.assetBaseUrl
    : `${config.assetBaseUrl}/`;

  return new URL(normalizedPath.slice(1), normalizedBase).toString();
}
