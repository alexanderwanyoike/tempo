import { z } from "zod";

export const songSectionTypes = [
  "intro",
  "verse",
  "build",
  "drop",
  "bridge",
  "breakdown",
  "finale",
] as const;

export const songSectionSchema = z.object({
  id: z.string(),
  type: z.enum(songSectionTypes),
  startTime: z.number().nonnegative(),
  endTime: z.number().positive(),
  energy: z.number().min(0).max(1),
  density: z.number().min(0).max(1),
  hazardBias: z.number().min(0).max(1),
  pickupBias: z.number().min(0).max(1),
  tags: z.array(z.string()).default([]),
});

export const songDefinitionSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  bpm: z.number().positive(),
  duration: z.number().positive(),
  baseSeed: z.number().int().nonnegative(),
  sections: z.array(songSectionSchema).min(1),
  dropMarkers: z.array(z.number().nonnegative()).default([]),
  chunkBias: z.array(z.string()).default([]),
});

export type SongSectionType = (typeof songSectionTypes)[number];
export type SongSection = z.infer<typeof songSectionSchema>;
export type SongDefinition = z.infer<typeof songDefinitionSchema>;
