import fs from "node:fs";
import path from "node:path";
import { TrackGenerator } from "../src/client/runtime/track-generator.ts";

type Args = {
  songId: string;
  seed: number | null;
  samples: number;
  minGap: number;
  proximityThreshold: number;
  assertMinTangentDot: number | null;
};

type FrameFinding = {
  u: number;
  tangentDot: number;
  rightDot: number;
  upDot: number;
};

type EdgeFinding = {
  uA: number;
  uB: number;
  pair: string;
  distance: number;
  tangentDot: number;
};

const DEFAULTS: Args = {
  songId: "the-prodigy-firestarter",
  seed: null,
  samples: 1800,
  minGap: 18,
  proximityThreshold: 8.5,
  assertMinTangentDot: null,
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
    } else if (arg === "--min-gap" && next) {
      args.minGap = Math.max(4, Number.parseInt(next, 10) || DEFAULTS.minGap);
      i += 1;
    } else if (arg === "--threshold" && next) {
      args.proximityThreshold = Math.max(2, Number.parseFloat(next) || DEFAULTS.proximityThreshold);
      i += 1;
    } else if (arg === "--assert-min-tangent-dot" && next) {
      args.assertMinTangentDot = Number.parseFloat(next);
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

function keepTopFrameFindings(list: FrameFinding[], candidate: FrameFinding, limit: number): void {
  list.push(candidate);
  list.sort((a, b) => Math.min(a.tangentDot, a.rightDot, a.upDot) - Math.min(b.tangentDot, b.rightDot, b.upDot));
  if (list.length > limit) list.length = limit;
}

function keepTopEdgeFindings(list: EdgeFinding[], candidate: EdgeFinding, limit: number): void {
  list.push(candidate);
  list.sort((a, b) => {
    const scoreA = a.distance + a.tangentDot * 6;
    const scoreB = b.distance + b.tangentDot * 6;
    return scoreA - scoreB;
  });
  if (list.length > limit) list.length = limit;
}

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { song, songPath } = resolveSong(args.songId);
  const seed = args.seed ?? song.baseSeed;
  const track = new TrackGenerator(song, seed);

  const sampleCount = args.samples;
  const samples = Array.from({ length: sampleCount + 1 }, (_, i) => {
    const u = Math.min(i / sampleCount, 0.9999);
    const point = track.getPointAt(u);
    const frame = track.getFrameAt(u);
    const halfWidth = track.getHalfWidthAt(u);
    const left = point.clone().addScaledVector(frame.right, -halfWidth);
    const right = point.clone().addScaledVector(frame.right, halfWidth);
    return { u, point, frame, left, right };
  });

  const frameFindings: FrameFinding[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const current = samples[i];
    keepTopFrameFindings(frameFindings, {
      u: current.u,
      tangentDot: prev.frame.tangent.dot(current.frame.tangent),
      rightDot: prev.frame.right.dot(current.frame.right),
      upDot: prev.frame.up.dot(current.frame.up),
    }, 20);
  }

  const edgeFindings: EdgeFinding[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = 0; j < i - args.minGap; j += 1) {
      const tangentDot = Math.abs(samples[i].frame.tangent.dot(samples[j].frame.tangent));
      if (tangentDot > 0.92) continue;

      const ll = samples[i].left.distanceTo(samples[j].left);
      if (ll < args.proximityThreshold) {
        keepTopEdgeFindings(edgeFindings, { uA: samples[i].u, uB: samples[j].u, pair: "left-left", distance: ll, tangentDot }, 20);
      }
      const rr = samples[i].right.distanceTo(samples[j].right);
      if (rr < args.proximityThreshold) {
        keepTopEdgeFindings(edgeFindings, { uA: samples[i].u, uB: samples[j].u, pair: "right-right", distance: rr, tangentDot }, 20);
      }
      const lr = samples[i].left.distanceTo(samples[j].right);
      if (lr < args.proximityThreshold) {
        keepTopEdgeFindings(edgeFindings, { uA: samples[i].u, uB: samples[j].u, pair: "left-right", distance: lr, tangentDot }, 20);
      }
      const rl = samples[i].right.distanceTo(samples[j].left);
      if (rl < args.proximityThreshold) {
        keepTopEdgeFindings(edgeFindings, { uA: samples[i].u, uB: samples[j].u, pair: "right-left", distance: rl, tangentDot }, 20);
      }
    }
  }

  console.log(`Track topology analysis`);
  console.log(`song: ${song.id}`);
  console.log(`songPath: ${songPath}`);
  console.log(`seed: ${seed}`);
  console.log(`duration: ${song.duration}s`);
  console.log(`trackLength: ${fmt(track.totalLength, 1)}m`);
  console.log(`samples: ${sampleCount}`);
  console.log(`threshold: ${args.proximityThreshold}m`);
  console.log("");

  console.log(`Worst frame continuity transitions:`);
  for (const finding of frameFindings.slice(0, 12)) {
    console.log(
      `u=${fmt(finding.u)} tangentDot=${fmt(finding.tangentDot)} rightDot=${fmt(finding.rightDot)} upDot=${fmt(finding.upDot)}`,
    );
  }
  console.log("");

  if (edgeFindings.length === 0) {
    console.log(`No suspicious edge proximities found below ${args.proximityThreshold}m.`);
  } else {
    console.log(`Suspicious edge proximities:`);
    for (const finding of edgeFindings.slice(0, 12)) {
      console.log(
        `${finding.pair} u=${fmt(finding.uA)} vs u=${fmt(finding.uB)} distance=${fmt(finding.distance, 2)} tangentDot=${fmt(finding.tangentDot, 2)}`,
      );
    }
  }

  const worstFrameFinding = frameFindings[0];
  if (args.assertMinTangentDot !== null && worstFrameFinding && worstFrameFinding.tangentDot < args.assertMinTangentDot) {
    console.error("");
    console.error(
      `FAIL: worst tangent continuity ${fmt(worstFrameFinding.tangentDot)} fell below ${fmt(args.assertMinTangentDot)} at u=${fmt(worstFrameFinding.u)}`,
    );
    process.exitCode = 1;
    return;
  }

  if (args.assertMinTangentDot !== null) {
    console.log("");
    console.log(
      `PASS: worst tangent continuity ${fmt(worstFrameFinding?.tangentDot ?? 1)} stayed above ${fmt(args.assertMinTangentDot)}`,
    );
  }
}

main();
