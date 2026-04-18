import fs from "node:fs";
import path from "node:path";
import { TrackGenerator } from "../src/client/runtime/track-generator.ts";

type Args = {
  songId: string;
  seed: number | null;
  samples: number;
  safety: number;
  top: number;
  assertMaxSeverity: number | null;
};

type FoldRegion = {
  startU: number;
  endU: number;
  centerU: number;
  minR: number;
  maxHalfWidth: number;
  severity: number;
  sampleCount: number;
};

const DEFAULTS: Args = {
  songId: "the-prodigy-firestarter",
  seed: null,
  samples: 2200,
  safety: 1.0,
  top: 20,
  assertMaxSeverity: null,
};

function parseArgs(argv: string[]): Args {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--song" && next) {
      args.songId = next;
      i += 1;
    } else if (arg === "--seed" && next) {
      args.seed = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--samples" && next) {
      args.samples = Math.max(400, Number.parseInt(next, 10) || DEFAULTS.samples);
      i += 1;
    } else if (arg === "--safety" && next) {
      args.safety = Math.max(0.1, Number.parseFloat(next) || DEFAULTS.safety);
      i += 1;
    } else if (arg === "--top" && next) {
      args.top = Math.max(1, Number.parseInt(next, 10) || DEFAULTS.top);
      i += 1;
    } else if (arg === "--assert-max-severity" && next) {
      args.assertMaxSeverity = Number.parseFloat(next);
      i += 1;
    }
  }
  return args;
}

function resolveSong(songId: string): { song: any; songPath: string } {
  const root = process.cwd();
  const catalogPath = path.join(root, "public", "song-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const entry = catalog.songs.find((candidate: { id: string }) => candidate.id === songId);
  if (!entry) {
    throw new Error(`Song not found in catalog: ${songId}`);
  }
  const songPath = path.join(root, "public", entry.songPath.replace(/^\/+/, ""));
  const song = JSON.parse(fs.readFileSync(songPath, "utf8"));
  return { song, songPath };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function fmt(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return "inf";
  return n.toFixed(digits);
}

function pct(u: number): string {
  return `${(u * 100).toFixed(2)}%`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { song, songPath } = resolveSong(args.songId);
  const seed = args.seed ?? song.baseSeed;
  const track = new TrackGenerator(song, seed);

  const N = args.samples;
  const totalLength = track.totalLength;
  const ds = totalLength / N;

  const tangents: { x: number; y: number; z: number }[] = new Array(N + 1);
  const halfWidths: number[] = new Array(N + 1);
  for (let i = 0; i <= N; i += 1) {
    const u = Math.min(i / N, 0.9999);
    const frame = track.getFrameAt(u);
    tangents[i] = { x: frame.tangent.x, y: frame.tangent.y, z: frame.tangent.z };
    halfWidths[i] = track.getHalfWidthAt(u);
  }

  const radii: number[] = new Array(N + 1);
  const flags: boolean[] = new Array(N + 1);
  let worstR = Number.POSITIVE_INFINITY;
  let worstRU = 0;
  let flaggedSampleCount = 0;

  for (let i = 0; i < N; i += 1) {
    const a = tangents[i];
    const b = tangents[i + 1];
    const dot = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);
    const theta = Math.acos(dot);
    const R = theta > 1e-6 ? ds / theta : Number.POSITIVE_INFINITY;
    radii[i] = R;
    const hw = halfWidths[i];
    const flagged = R < hw * args.safety;
    flags[i] = flagged;
    if (flagged) flaggedSampleCount += 1;
    if (R < worstR) {
      worstR = R;
      worstRU = i / N;
    }
  }
  radii[N] = radii[N - 1] ?? Number.POSITIVE_INFINITY;
  flags[N] = false;

  const regions: FoldRegion[] = [];
  const MAX_GAP = 2;
  let regionStart = -1;
  let gap = 0;
  let regionMinR = Number.POSITIVE_INFINITY;
  let regionMaxHW = 0;
  let regionLastFlagged = -1;
  let regionSampleCount = 0;

  const finalizeRegion = (endIdx: number): void => {
    if (regionStart < 0) return;
    const startU = regionStart / N;
    const endU = endIdx / N;
    const severity = regionMinR > 0 ? regionMaxHW / regionMinR : Number.POSITIVE_INFINITY;
    regions.push({
      startU,
      endU,
      centerU: (startU + endU) / 2,
      minR: regionMinR,
      maxHalfWidth: regionMaxHW,
      severity,
      sampleCount: regionSampleCount,
    });
    regionStart = -1;
    regionMinR = Number.POSITIVE_INFINITY;
    regionMaxHW = 0;
    regionLastFlagged = -1;
    regionSampleCount = 0;
    gap = 0;
  };

  for (let i = 0; i < N; i += 1) {
    if (flags[i]) {
      if (regionStart < 0) regionStart = i;
      regionLastFlagged = i;
      regionSampleCount += 1;
      if (radii[i] < regionMinR) regionMinR = radii[i];
      if (halfWidths[i] > regionMaxHW) regionMaxHW = halfWidths[i];
      gap = 0;
    } else if (regionStart >= 0) {
      gap += 1;
      if (gap > MAX_GAP) {
        finalizeRegion(regionLastFlagged + 1);
      }
    }
  }
  finalizeRegion(regionLastFlagged + 1);

  regions.sort((a, b) => b.severity - a.severity);

  console.log(`Track curvature analysis`);
  console.log(`song: ${song.id} (${song.title ?? "?"} by ${song.artist ?? "?"})`);
  console.log(`songPath: ${songPath}`);
  console.log(`seed: ${seed}`);
  console.log(`samples: ${N}   totalLength: ${fmt(totalLength, 1)}m   ds: ${fmt(ds, 2)}m`);
  console.log(`safetyFactor: ${fmt(args.safety, 2)}   halfWidth baseline: ${fmt(track.halfWidth, 2)}m`);
  console.log("");

  const flaggedPct = (flaggedSampleCount / N) * 100;
  console.log(
    `regions flagged: ${regions.length}   samples flagged: ${flaggedSampleCount} (${flaggedPct.toFixed(2)}%)`,
  );
  console.log(`tightest radius: ${fmt(worstR, 2)}m at u=${pct(worstRU)}`);
  const worstSeverity = regions[0]?.severity ?? 0;
  console.log(`worst severity: ${fmt(worstSeverity, 2)}`);
  console.log("");

  if (regions.length === 0) {
    console.log(`No fold regions found below safetyFactor ${fmt(args.safety, 2)}.`);
  } else {
    console.log(`Top fold regions (by severity):`);
    console.log(`  #   u-range                 center     minR     halfW    sev    samples`);
    for (let i = 0; i < Math.min(args.top, regions.length); i += 1) {
      const r = regions[i];
      const idx = (i + 1).toString().padStart(3, " ");
      const rng = `${pct(r.startU).padStart(7, " ")} - ${pct(r.endU).padStart(7, " ")}`;
      const center = pct(r.centerU).padStart(7, " ");
      const minR = `${fmt(r.minR, 2)}m`.padStart(8, " ");
      const hw = `${fmt(r.maxHalfWidth, 2)}m`.padStart(8, " ");
      const sev = fmt(r.severity, 2).padStart(5, " ");
      const cnt = r.sampleCount.toString().padStart(5, " ");
      console.log(`  ${idx}  ${rng}   ${center}   ${minR} ${hw}  ${sev}  ${cnt}`);
    }
  }

  if (args.assertMaxSeverity !== null) {
    console.log("");
    if (worstSeverity > args.assertMaxSeverity) {
      console.error(
        `FAIL: worst severity ${fmt(worstSeverity, 2)} exceeded ${fmt(args.assertMaxSeverity, 2)}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `PASS: worst severity ${fmt(worstSeverity, 2)} stayed at or below ${fmt(args.assertMaxSeverity, 2)}`,
    );
  }
}

main();
