import type { SongDefinition } from "./song-schema.js";

export function buildCheckpointUs(song: SongDefinition): number[] {
  const checkpoints: number[] = [];
  let lastU = 0;

  for (const section of song.sections.slice(1)) {
    const u = clamp01(section.startTime / song.duration);
    if (u < 0.08 || u > 0.95) continue;
    if (u - lastU < 0.08) continue;
    checkpoints.push(u);
    lastU = u;
  }

  if (checkpoints.length === 0) {
    checkpoints.push(0.5);
  }

  return checkpoints;
}

export function checkpointIndexForU(trackU: number, checkpoints: readonly number[]): number {
  let index = 0;
  for (let i = 0; i < checkpoints.length; i++) {
    if (trackU >= checkpoints[i]) index = i + 1;
    else break;
  }
  return index;
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
