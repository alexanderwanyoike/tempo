import { z } from "zod";
import type { ClientConfig } from "./config";
import { resolveAssetUrl } from "./config";
import type { EnvironmentFictionId } from "./fiction-id";

const fictionIdSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const songCatalogEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().min(1),
  genre: z.string().min(1).default("Breaks"),
  bpm: z.number().positive(),
  duration: z.number().positive(),
  baseSeed: z.number().int().nonnegative(),
  songPath: z.string().min(1),
  musicPath: z.string().min(1),
  albumArtPath: z.string().default(""),
  previewStartTime: z.number().nonnegative().default(0),
  searchTerms: z.array(z.string().min(1)).default([]),
  fictionIds: z.array(fictionIdSchema).min(1).default([1, 2, 3]),
});

export const songCatalogSchema = z.object({
  defaultSongId: z.string().min(1),
  songs: z.array(songCatalogEntrySchema).min(1),
});

export type SongCatalogEntry = z.infer<typeof songCatalogEntrySchema>;
export type SongCatalog = z.infer<typeof songCatalogSchema>;

export type ResolvedSongLaunch = {
  songUrl: string;
  musicUrl: string;
};

export async function loadSongCatalog(config: ClientConfig): Promise<SongCatalog> {
  const catalogUrl = resolveAssetUrl(config, "/song-catalog.json");
  const response = await fetch(catalogUrl);
  if (!response.ok) {
    throw new Error(`Failed to load song catalog: ${response.status} ${catalogUrl}`);
  }

  const json = await response.json();
  return songCatalogSchema.parse(json);
}

export function resolveSongLaunchUrls(
  config: ClientConfig,
  entry: Pick<SongCatalogEntry, "songPath" | "musicPath">,
): ResolvedSongLaunch {
  return {
    songUrl: resolveAssetUrl(config, entry.songPath),
    musicUrl: resolveAssetUrl(config, entry.musicPath),
  };
}

export function resolveSongAlbumArtUrl(
  config: ClientConfig,
  entry: Pick<SongCatalogEntry, "albumArtPath">,
): string | null {
  return entry.albumArtPath ? resolveAssetUrl(config, entry.albumArtPath) : null;
}

export function buildSongSearchText(
  entry: Pick<SongCatalogEntry, "title" | "artist" | "genre" | "searchTerms">,
): string {
  return [entry.title, entry.artist, entry.genre, ...entry.searchTerms]
    .join(" ")
    .trim()
    .toLowerCase();
}

export function clampCatalogFictions(
  entry: SongCatalogEntry,
  fictionId: EnvironmentFictionId,
): EnvironmentFictionId {
  return entry.fictionIds.includes(fictionId) ? fictionId : entry.fictionIds[0];
}
