#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");
const publicDir = join(repoRoot, "public");
const uploadRoots = [
  join(publicDir, "music"),
  join(publicDir, "songs"),
  join(publicDir, "cars"),
  join(publicDir, "album-art"),
  join(publicDir, "song-catalog.json"),
];

const force = process.argv.includes("--force");

const required = [
  "CLOUDFLARE_R2_ACCOUNT_ID",
  "CLOUDFLARE_R2_BUCKET",
  "CLOUDFLARE_R2_ACCESS_KEY_ID",
  "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  console.error("Set them in .env (see .env.example) and re-run.");
  process.exit(1);
}

const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID;
const bucket = process.env.CLOUDFLARE_R2_BUCKET;

const client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
  },
});

const contentTypes = {
  ".mp3": "audio/mpeg",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

async function walk(target) {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (info.isFile()) return [target];
  if (!info.isDirectory()) return [];
  const entries = await readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function objectExists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

async function uploadFile(fullPath) {
  const key = relative(publicDir, fullPath).split(/[\\/]/).join("/");
  const ext = extname(fullPath).toLowerCase();
  const contentType = contentTypes[ext] ?? "application/octet-stream";

  if (!force && (await objectExists(key))) {
    console.log(`skip  ${key}`);
    return { uploaded: false };
  }

  const body = await readFile(fullPath);
  const { size } = await stat(fullPath);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: size,
    }),
  );
  console.log(`up    ${key}  (${(size / 1024).toFixed(1)} KB)`);
  return { uploaded: true };
}

async function main() {
  const files = (await Promise.all(uploadRoots.map(walk))).flat();
  if (files.length === 0) {
    console.log("No files found under configured public asset roots.");
    return;
  }
  console.log(`Uploading ${files.length} file(s) to bucket "${bucket}"${force ? " (force)" : ""}.`);
  let uploaded = 0;
  let skipped = 0;
  for (const file of files) {
    const result = await uploadFile(file);
    if (result.uploaded) uploaded += 1;
    else skipped += 1;
  }
  console.log(`\nDone. uploaded=${uploaded} skipped=${skipped}`);
  if (process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL) {
    console.log(`Public base: ${process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
