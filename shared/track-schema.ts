import { z } from "zod";

export const trackChunkSchema = z.object({
  id: z.string(),
  biome: z.string(),
  length: z.number().positive(),
  width: z.number().positive(),
  curvature: z.number().min(-1).max(1),
  banking: z.number().min(-1).max(1),
  elevationDelta: z.number(),
  entryTag: z.string(),
  exitTag: z.string(),
  supportsJump: z.boolean().default(false),
  supportsDrop: z.boolean().default(false),
  hazardSockets: z.array(z.string()).default([]),
  pickupSockets: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const trackVariantSchema = z.object({
  songId: z.string(),
  variantSeed: z.number().int().nonnegative(),
  chunkIds: z.array(z.string()).min(1),
  totalLength: z.number().positive(),
});

export type TrackChunkDefinition = z.infer<typeof trackChunkSchema>;
export type TrackVariant = z.infer<typeof trackVariantSchema>;
