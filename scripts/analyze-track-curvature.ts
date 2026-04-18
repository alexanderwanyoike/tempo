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
  rollMinRadius: number;
  assertMaxRollSeverity: number | null;
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

type RollRegion = {
  startU: number;
  endU: number;
  centerU: number;
  minRollRadius: number;
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
  rollMinRadius: 8,
  assertMaxRollSeverity: null,
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
    } else if (arg === "--roll-min-radius" && next) {
      args.rollMinRadius = Math.max(0.5, Number.parseFloat(next) || DEFAULTS.rollMinRadius);
      i += 1;
    } else if (arg === "--assert-max-roll-severity" && next) {
      args.assertMaxRollSeverity = Number.parseFloat(next);
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
  const rights: { x: number; y: number; z: number }[] = new Array(N + 1);
  const halfWidths: number[] = new Array(N + 1);
  for (let i = 0; i <= N; i += 1) {
    const u = Math.min(i / N, 0.9999);
    const frame = track.getFrameAt(u);
    tangents[i] = { x: frame.tangent.x, y: frame.tangent.y, z: frame.tangent.z };
    rights[i] = { x: frame.right.x, y: frame.right.y, z: frame.right.z };
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

  const rollRadii: number[] = new Array(N + 1);
  const rollFlags: boolean[] = new Array(N + 1);
  const rollBudget = ds / args.rollMinRadius;
  let worstRollR = Number.POSITIVE_INFINITY;
  let worstRollRU = 0;
  let flaggedRollSampleCount = 0;

  for (let i = 0; i < N; i += 1) {
    const ta = tangents[i];
    const tb = tangents[i + 1];
    const tx = ta.x + tb.x, ty = ta.y + tb.y, tz = ta.z + tb.z;
    const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tlen < 1e-8) {
      rollRadii[i] = Number.POSITIVE_INFINITY;
      rollFlags[i] = false;
      continue;
    }
    const tnx = tx / tlen, tny = ty / tlen, tnz = tz / tlen;

    const ra = rights[i];
    const rb = rights[i + 1];
    const dotA = ra.x * tnx + ra.y * tny + ra.z * tnz;
    const dotB = rb.x * tnx + rb.y * tny + rb.z * tnz;
    const pax = ra.x - dotA * tnx, pay = ra.y - dotA * tny, paz = ra.z - dotA * tnz;
    const pbx = rb.x - dotB * tnx, pby = rb.y - dotB * tny, pbz = rb.z - dotB * tnz;
    const palen = Math.sqrt(pax * pax + pay * pay + paz * paz);
    const pblen = Math.sqrt(pbx * pbx + pby * pby + pbz * pbz);
    if (palen < 1e-8 || pblen < 1e-8) {
      rollRadii[i] = Number.POSITIVE_INFINITY;
      rollFlags[i] = false;
      continue;
    }
    const cosAngle = clamp((pax * pbx + pay * pby + paz * pbz) / (palen * pblen), -1, 1);
    const rollAngle = Math.acos(cosAngle);
    const rollR = rollAngle > 1e-6 ? ds / rollAngle : Number.POSITIVE_INFINITY;
    rollRadii[i] = rollR;
    const flagged = rollAngle > rollBudget;
    rollFlags[i] = flagged;
    if (flagged) flaggedRollSampleCount += 1;
    if (rollR < worstRollR) {
      worstRollR = rollR;
      worstRollRU = i / N;
    }
  }
  rollRadii[N] = rollRadii[N - 1] ?? Number.POSITIVE_INFINITY;
  rollFlags[N] = false;

  const rollRegions: RollRegion[] = [];
  {
    let rStart = -1;
    let rGap = 0;
    let rMin = Number.POSITIVE_INFINITY;
    let rLast = -1;
    let rCount = 0;
    const finalize = (endIdx: number) => {
      if (rStart < 0) return;
      const startU = rStart / N;
      const endU = endIdx / N;
      rollRegions.push({
        startU,
        endU,
        centerU: (startU + endU) / 2,
        minRollRadius: rMin,
        severity: rMin > 0 ? args.rollMinRadius / rMin : Number.POSITIVE_INFINITY,
        sampleCount: rCount,
      });
      rStart = -1;
      rMin = Number.POSITIVE_INFINITY;
      rLast = -1;
      rCount = 0;
      rGap = 0;
    };
    for (let i = 0; i < N; i += 1) {
      if (rollFlags[i]) {
        if (rStart < 0) rStart = i;
        rLast = i;
        rCount += 1;
        if (rollRadii[i] < rMin) rMin = rollRadii[i];
        rGap = 0;
      } else if (rStart >= 0) {
        rGap += 1;
        if (rGap > MAX_GAP) finalize(rLast + 1);
      }
    }
    finalize(rLast + 1);
  }
  rollRegions.sort((a, b) => b.severity - a.severity);

  const rollFlaggedPct = (flaggedRollSampleCount / N) * 100;
  const worstRollSeverity = rollRegions[0]?.severity ?? 0;

  console.log("");
  console.log(`Roll-rate analysis (ROLL_MIN_RADIUS=${fmt(args.rollMinRadius, 2)}m):`);
  console.log(
    `roll regions flagged: ${rollRegions.length}   samples flagged: ${flaggedRollSampleCount} (${rollFlaggedPct.toFixed(2)}%)`,
  );
  console.log(`tightest roll radius: ${fmt(worstRollR, 2)}m at u=${pct(worstRollRU)}`);
  console.log(`worst roll severity: ${fmt(worstRollSeverity, 2)}`);
  console.log("");

  if (rollRegions.length === 0) {
    console.log(`No roll-rate regions exceed budget ${fmt(args.rollMinRadius, 2)}m.`);
  } else {
    console.log(`Top roll regions (by severity):`);
    console.log(`  #   u-range                 center    minRollR   budget   sev    samples`);
    for (let i = 0; i < Math.min(args.top, rollRegions.length); i += 1) {
      const r = rollRegions[i];
      const idx = (i + 1).toString().padStart(3, " ");
      const rng = `${pct(r.startU).padStart(7, " ")} - ${pct(r.endU).padStart(7, " ")}`;
      const center = pct(r.centerU).padStart(7, " ");
      const minR = `${fmt(r.minRollRadius, 2)}m`.padStart(9, " ");
      const budget = `${fmt(args.rollMinRadius, 2)}m`.padStart(7, " ");
      const sev = fmt(r.severity, 2).padStart(5, " ");
      const cnt = r.sampleCount.toString().padStart(5, " ");
      console.log(`  ${idx}  ${rng}   ${center}  ${minR} ${budget}  ${sev}  ${cnt}`);
    }
  }

  if (args.assertMaxRollSeverity !== null) {
    console.log("");
    if (worstRollSeverity > args.assertMaxRollSeverity) {
      console.error(
        `FAIL: worst roll severity ${fmt(worstRollSeverity, 2)} exceeded ${fmt(args.assertMaxRollSeverity, 2)}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `PASS: worst roll severity ${fmt(worstRollSeverity, 2)} stayed at or below ${fmt(args.assertMaxRollSeverity, 2)}`,
    );
  }
}

main();
