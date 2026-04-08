import {
  songDefinitionSchema,
  type SongDefinition,
  type SongSection,
} from "../../../shared/song-schema";

export async function loadSongDefinition(url: string): Promise<SongDefinition> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load song definition: ${response.status} ${url}`);
  }
  const json = await response.json();
  return songDefinitionSchema.parse(json);
}

export function getSectionAtTime(song: SongDefinition, time: number): SongSection {
  for (let i = song.sections.length - 1; i >= 0; i--) {
    if (time >= song.sections[i].startTime) {
      return song.sections[i];
    }
  }
  return song.sections[0];
}

export function getEnergyAtTime(song: SongDefinition, time: number): number {
  return getSectionAtTime(song, time).energy;
}
