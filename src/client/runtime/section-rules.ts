import type { SongSectionType, SongSection } from "../../../shared/song-schema";
import type { ChunkType } from "./chunks";
import type { ChunkParams } from "./chunks";
import { MathUtils } from "three";

// ---- Weighted chunk selection per section type ----

type ChunkWeight = {
  type: ChunkType;
  weight: number;
  minEnergy?: number;
};

const sectionChunkRules: Record<SongSectionType, ChunkWeight[]> = {
  intro:     [{ type: "straight", weight: 2 }, { type: "gentleCurve", weight: 3 }, { type: "sCurve", weight: 2 }, { type: "hill", weight: 1 }],
  verse:     [{ type: "sCurve", weight: 3 }, { type: "sharpTurn", weight: 2 }, { type: "hill", weight: 2 }, { type: "jumpRamp", weight: 1, minEnergy: 0.85 }],
  build:     [{ type: "sharpTurn", weight: 3 }, { type: "sCurve", weight: 2 }, { type: "hill", weight: 2 }, { type: "jumpRamp", weight: 4, minEnergy: 0.45 }, { type: "loop", weight: 0.8, minEnergy: 0.88 }],
  drop:      [{ type: "sharpTurn", weight: 3 }, { type: "jumpRamp", weight: 5 }, { type: "sCurve", weight: 3 }, { type: "hill", weight: 1 }, { type: "loop", weight: 1.4, minEnergy: 0.82 }],
  bridge:    [{ type: "sCurve", weight: 2 }, { type: "gentleCurve", weight: 2 }, { type: "valley", weight: 4 }],
  breakdown: [{ type: "gentleCurve", weight: 2 }, { type: "sCurve", weight: 1 }, { type: "valley", weight: 4 }, { type: "straight", weight: 1 }],
  finale:    [{ type: "sharpTurn", weight: 3 }, { type: "jumpRamp", weight: 5 }, { type: "sCurve", weight: 3 }, { type: "hill", weight: 1 }, { type: "loop", weight: 1.8, minEnergy: 0.8 }],
};

export function pickChunkForSection(
  section: SongSection,
  rng: () => number,
  recentChunks: ChunkType[],
): ChunkType {
  const pool = sectionChunkRules[section.type];

  // Filter by energy threshold and build weights
  let totalWeight = 0;
  const candidates: { type: ChunkType; weight: number }[] = [];

  for (const entry of pool) {
    if (entry.minEnergy !== undefined && section.energy < entry.minEnergy) continue;

    // Loop cooldown: skip if a loop appeared in recent history
    if (entry.type === "loop" && recentChunks.includes("loop")) continue;

    let w = entry.weight;

    // Repetition penalty: halve weight if last 2 chunks were this type
    const lastTwo = recentChunks.slice(-2);
    if (lastTwo.length === 2 && lastTwo[0] === entry.type && lastTwo[1] === entry.type) {
      w *= 0.25;
    } else if (recentChunks.length > 0 && recentChunks[recentChunks.length - 1] === entry.type) {
      w *= 0.5;
    }

    candidates.push({ type: entry.type, weight: w });
    totalWeight += w;
  }

  // Fallback if nothing qualified
  if (candidates.length === 0) return "straight";

  // Weighted random selection
  let roll = rng() * totalWeight;
  for (const c of candidates) {
    roll -= c.weight;
    if (roll <= 0) return c.type;
  }

  return candidates[candidates.length - 1].type;
}

export function scaleChunkParams(section: SongSection): ChunkParams {
  return {
    energy: section.energy,
    density: section.density,
    // Track narrows with energy: 30m at 0 energy, 20m at max
    trackWidth: MathUtils.lerp(30, 20, section.energy),
  };
}
