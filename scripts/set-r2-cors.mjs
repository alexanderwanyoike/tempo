#!/usr/bin/env node
import { PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";

const required = [
  "CLOUDFLARE_R2_ACCOUNT_ID",
  "CLOUDFLARE_R2_BUCKET",
  "CLOUDFLARE_R2_ACCESS_KEY_ID",
  "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
  },
});

const corsRules = [
  {
    AllowedOrigins: [
      "https://tempo-racer.netlify.app",
      "https://playtempo.uk",
      "https://www.playtempo.uk",
      "http://localhost:5173",
      "http://localhost:4173",
    ],
    AllowedMethods: ["GET", "HEAD"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag", "Content-Length", "Content-Range"],
    MaxAgeSeconds: 3600,
  },
];

await client.send(
  new PutBucketCorsCommand({
    Bucket: process.env.CLOUDFLARE_R2_BUCKET,
    CORSConfiguration: { CORSRules: corsRules },
  }),
);

console.log(`CORS policy applied to bucket "${process.env.CLOUDFLARE_R2_BUCKET}".`);
for (const rule of corsRules) {
  console.log(`  origins: ${rule.AllowedOrigins.join(", ")}`);
  console.log(`  methods: ${rule.AllowedMethods.join(", ")}`);
}
