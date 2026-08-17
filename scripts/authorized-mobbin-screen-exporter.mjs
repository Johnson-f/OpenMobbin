#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";

const args = parseArgs(process.argv.slice(2));

if (args.help || (!args.endpoint && !args.manifest)) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

const outDir = args.out || "mobbin-authorized-screen-export";
const concurrency = Number(args.concurrency || 4);
const token = args.token || process.env.MOBBIN_EXPORT_TOKEN || "";
const allowHosts = new Set(
  String(args.allowHosts || "localhost,127.0.0.1,staging.mobbin.com,mobbin.test")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
);

await mkdir(outDir, { recursive: true });

const source = args.endpoint
  ? await fetchAuthorizedManifest(args.endpoint, token, allowHosts)
  : await readManifest(args.manifest);

const screens = normalizeScreens(source).slice(0, Number(args.limit || Number.MAX_SAFE_INTEGER));
if (screens.length === 0) {
  throw new Error("No screen records found. Expected records with id and imageUrl/url/src.");
}

const written = [];
await mapLimit(screens, concurrency, async (screen, index) => {
  const imageUrl = screen.imageUrl || screen.url || screen.src;
  assertAllowedUrl(imageUrl, allowHosts);

  const fileBase = safeName(
    [
      String(index + 1).padStart(4, "0"),
      screen.appSlug || screen.appName,
      screen.flowSlug || screen.flowName,
      screen.name,
      screen.id,
    ]
      .filter(Boolean)
      .join("-"),
  );

  const urlExt = extname(new URL(imageUrl).pathname);
  const fileExt = urlExt && urlExt.length <= 8 ? urlExt : ".webp";
  const filePath = join(outDir, `${fileBase}${fileExt}`);

  const result = await downloadImage(imageUrl, filePath, token);
  written.push({
    ...pick(screen, [
      "id",
      "appId",
      "appName",
      "appSlug",
      "flowId",
      "flowName",
      "screenName",
      "name",
      "width",
      "height",
      "restricted",
    ]),
    sourceHost: new URL(imageUrl).host,
    savedPath: filePath,
    ...result,
  });
});

written.sort((a, b) => a.savedPath.localeCompare(b.savedPath));

const reportPath = join(outDir, "export-report.json");
const csvPath = join(outDir, "export-report.csv");
await writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), count: written.length, written }, null, 2));
await writeFile(csvPath, toCsv(written));

console.log(
  JSON.stringify(
    {
      savedImages: written.length,
      outDir,
      reportPath,
      csvPath,
    },
    null,
    2,
  ),
);

function printHelp() {
  console.log(`Authorized Mobbin screen exporter

Usage:
  node authorized-mobbin-screen-exporter.mjs --endpoint https://staging.mobbin.com/internal/exports/screens?... --token "$MOBBIN_EXPORT_TOKEN"
  node authorized-mobbin-screen-exporter.mjs --manifest screens-export.json

Options:
  --endpoint      Internal/staging/local HTTPS endpoint returning JSON screen records
  --manifest      Local JSON manifest exported by your backend
  --token         Bearer token; can also use MOBBIN_EXPORT_TOKEN
  --out           Output directory, default: mobbin-authorized-screen-export
  --limit         Max screens to save
  --concurrency   Parallel downloads, default: 4
  --allowHosts    Comma-separated allowed hosts, default: localhost,127.0.0.1,staging.mobbin.com,mobbin.test

Accepted JSON shapes:
  { "screens": [{ "id": "...", "imageUrl": "https://..." }] }
  { "data": [{ "id": "...", "url": "https://..." }] }
  [{ "id": "...", "src": "https://..." }]
`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

async function fetchAuthorizedManifest(endpoint, bearerToken, allowHosts) {
  assertAllowedUrl(endpoint, allowHosts);
  const headers = { accept: "application/json" };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

  const resp = await fetch(endpoint, { headers, redirect: "follow" });
  if (!resp.ok) {
    throw new Error(`Export endpoint failed: HTTP ${resp.status} ${resp.statusText}`);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Export endpoint returned ${contentType || "unknown content type"}, expected JSON`);
  }
  return resp.json();
}

async function readManifest(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function normalizeScreens(source) {
  if (Array.isArray(source)) return source;
  if (Array.isArray(source.screens)) return source.screens;
  if (Array.isArray(source.data)) return source.data;
  if (Array.isArray(source.items)) return source.items;
  return [];
}

async function downloadImage(url, filePath, bearerToken) {
  const headers = { accept: "image/*" };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

  const resp = await fetch(url, { headers, redirect: "follow" });
  if (!resp.ok) {
    throw new Error(`Image fetch failed for ${basename(filePath)}: HTTP ${resp.status} ${resp.statusText}`);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`Refusing to save non-image response for ${basename(filePath)}: ${contentType || "unknown content type"}`);
  }

  const hash = createHash("sha256");
  let bytes = 0;
  const hashingStream = new TransformStream({
    transform(chunk, controller) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      hash.update(buffer);
      controller.enqueue(buffer);
    },
  });

  await pipeline(resp.body, hashingStream, createWriteStream(filePath));

  return {
    contentType,
    bytes,
    sha256: hash.digest("hex"),
  };
}

function assertAllowedUrl(value, allowHosts) {
  if (!value) throw new Error("Missing URL");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (!allowHosts.has(url.hostname)) {
    throw new Error(`Host not allowed: ${url.hostname}. Pass --allowHosts for approved internal hosts.`);
  }
}

async function mapLimit(items, limit, fn) {
  const queue = [...items.entries()];
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length) {
      const [index, item] = queue.shift();
      await fn(item, index);
    }
  });
  await Promise.all(workers);
}

function pick(object, keys) {
  const result = {};
  for (const key of keys) {
    if (object[key] !== undefined) result[key] = object[key];
  }
  return result;
}

function safeName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 180);
}

function toCsv(rows) {
  const columns = [
    "id",
    "appId",
    "appName",
    "flowId",
    "flowName",
    "name",
    "width",
    "height",
    "restricted",
    "sourceHost",
    "savedPath",
    "contentType",
    "bytes",
    "sha256",
  ];
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column] ?? "")).join(",")),
  ].join("\n") + "\n";
}

function csvEscape(value) {
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}
