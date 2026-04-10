export type ClientConfig = {
  websocketUrl: string;
  assetBaseUrl: string;
};

export const clientConfig: ClientConfig = {
  websocketUrl: import.meta.env.VITE_WS_URL ?? "ws://localhost:8080",
  assetBaseUrl: (import.meta.env.VITE_ASSET_BASE_URL ?? "").trim(),
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
