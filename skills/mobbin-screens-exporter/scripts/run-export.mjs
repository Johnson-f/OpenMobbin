#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..", "..", "..");
const exporterPath = join(projectRoot, "scripts", "export-mobbin-screens.mjs");
const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

if (!existsSync(exporterPath)) {
  fail([`Exporter not found: ${exporterPath}`]);
}

let pageUrl = args["page-url"] || args.url || null;
const query = args.query || args.app || null;
const platform = String(args.platform || "ios");
const contentType = String(args["content-type"] || "screens");
const profileDir = String(args["profile-dir"] || "/Users/user/Library/Application Support/Dia/User Data/Default");
const safeStorageService = String(args["safe-storage-service"] || "Dia Safe Storage");

if (!pageUrl && query) {
  const resolved = await resolveMobbinAppPageUrl({
    query: String(query),
    platform,
    contentType,
    profileDir,
    safeStorageService,
  });
  pageUrl = resolved.pageUrl;
  console.error(
    `resolved ${JSON.stringify({
      query,
      appName: resolved.appName,
      platform: resolved.platform,
      appId: resolved.appId,
      appVersionId: resolved.appVersionId,
      pageUrl,
    })}`,
  );
}

const category = sanitizeCategory(args.category || deriveCategory(pageUrl) || query || "phantom");
const imagesDir = String(args["images-dir"] || join(projectRoot, "latest-images", category));
const reportDir = String(args["report-dir"] || join(projectRoot, "latest-reports", category));
const reportPath = join(reportDir, "mobbin-screen-downloadables-report.json");
const csvPath = join(reportDir, "mobbin-screen-downloadables.csv");

run(process.execPath, ["--check", exporterPath], { stdio: "pipe" });

const exportArgs = [exporterPath, "--category", category, "--images-dir", imagesDir, "--report-dir", reportDir];
if (pageUrl) exportArgs.push("--page-url", pageUrl);
for (const key of ["profile-dir", "safe-storage-service", "concurrency", "limit"]) {
  if (args[key] !== undefined) exportArgs.push(`--${key}`, String(args[key]));
}

run(process.execPath, exportArgs, { stdio: "inherit" });

const summary = verifyExport({
  category,
  pageUrl,
  imagesDir,
  reportDir,
  reportPath,
  csvPath,
  allowDuplicates: Boolean(args["allow-duplicates"]),
  allowTiny: Boolean(args["allow-tiny"]),
});

console.log(JSON.stringify(summary, null, 2));

function verifyExport({ category, pageUrl, imagesDir, reportDir, reportPath, csvPath, allowDuplicates, allowTiny }) {
  const issues = [];
  if (!existsSync(reportPath)) issues.push(`Missing JSON report: ${reportPath}`);
  if (!existsSync(csvPath)) issues.push(`Missing CSV report: ${csvPath}`);
  if (!existsSync(imagesDir)) issues.push(`Missing images directory: ${imagesDir}`);
  if (issues.length > 0) fail(issues);

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const imageFiles = readdirSync(imagesDir).filter((file) => lstatSync(join(imagesDir, file)).isFile());
  const screenCount = Number(report.screenCount || 0);
  const savedImageCount = Number(report.savedImageCount || 0);
  const uniqueSha256Count = Number(report.uniqueSha256Count || 0);
  const tinyImageCount = Number(report.tinyImageCount || 0);

  if (screenCount <= 0) issues.push(`Expected screenCount > 0, got ${screenCount}`);
  if (savedImageCount !== screenCount) {
    issues.push(`Expected savedImageCount (${savedImageCount}) to equal screenCount (${screenCount})`);
  }
  if (imageFiles.length !== savedImageCount) {
    issues.push(`Expected ${savedImageCount} files in ${imagesDir}, found ${imageFiles.length}`);
  }
  if (!allowDuplicates && uniqueSha256Count !== savedImageCount) {
    issues.push(`Expected uniqueSha256Count (${uniqueSha256Count}) to equal savedImageCount (${savedImageCount})`);
  }
  if (!allowTiny && tinyImageCount !== 0) {
    issues.push(`Expected tinyImageCount 0, got ${tinyImageCount}`);
  }

  const summary = {
    ok: issues.length === 0,
    category,
    pageUrl: pageUrl || report.pageUrl,
    imagesDir,
    reportDir,
    reportPath,
    csvPath,
    screenCount,
    savedImageCount,
    filesystemImageCount: imageFiles.length,
    uniqueSha256Count,
    tinyImageCount,
  };

  if (issues.length > 0) {
    console.error(JSON.stringify({ ...summary, issues }, null, 2));
    process.exit(2);
  }

  return summary;
}

function run(command, commandArgs, options) {
  const result = spawnSync(command, commandArgs, { ...options, encoding: "utf8" });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
}

async function resolveMobbinAppPageUrl({ query, platform, contentType, profileDir, safeStorageService }) {
  const cookie = buildMobbinCookieHeader({ profileDir, safeStorageService });
  const searchResp = await fetch("https://mobbin.com/api/search-bar/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (compatible; MobbinScreensExporter/1.0)",
      cookie,
    },
    body: JSON.stringify({ query, experience: "apps", platform }),
  });

  if (!searchResp.ok) {
    throw new Error(`Mobbin search failed: ${searchResp.status} ${searchResp.statusText}`);
  }

  const searchPayload = await searchResp.json();
  if (searchPayload.error) {
    throw new Error(`Mobbin search error: ${searchPayload.error.message || "unknown"}`);
  }

  const ids = [
    ...(searchPayload.value?.primary || []),
    ...(searchPayload.value?.secondaryPlatform || []),
    ...(searchPayload.value?.other || []),
  ]
    .filter((result) => result?.type === "app" && result.id)
    .map((result) => result.id);

  for (const appId of ids) {
    const appResp = await fetch(`https://mobbin.com/api/app-hover-card/${appId}`, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; MobbinScreensExporter/1.0)",
        cookie,
      },
    });
    if (!appResp.ok) continue;
    const app = await appResp.json();
    if (app.platform !== platform) continue;
    const appVersion = latestAppVersion(app.appVersions || []);
    if (!appVersion?.id) continue;
    const appSlug = `${slugify(app.appName)}-${platform}-${app.id}`;
    return {
      pageUrl: `https://mobbin.com/apps/${appSlug}/${appVersion.id}/${contentType}`,
      appName: app.appName,
      platform: app.platform,
      appId: app.id,
      appVersionId: appVersion.id,
    };
  }

  throw new Error(`No Mobbin ${platform} app result found for query: ${query}`);
}

function buildMobbinCookieHeader({ profileDir, safeStorageService }) {
  const tempCookieDb = join(mkdtempSync(join(tmpdir(), "mobbin-screens-exporter-")), "Cookies");
  copyFileSync(join(profileDir, "Cookies"), tempCookieDb);

  const safeStoragePassword = execFileSync("security", ["find-generic-password", "-w", "-s", safeStorageService], {
    encoding: "utf8",
  }).trim();
  const key = pbkdf2Sync(safeStoragePassword, "saltysalt", 1003, 16, "sha1");
  const rows = JSON.parse(
    execFileSync(
      "sqlite3",
      [
        "-json",
        tempCookieDb,
        "select host_key, name, coalesce(value,'') as value, coalesce(hex(encrypted_value),'') as encrypted_value_hex from cookies where host_key in ('mobbin.com','.mobbin.com') order by host_key,name;",
      ],
      { encoding: "utf8" },
    ),
  );

  const cookie = rows
    .flatMap(({ host_key: hostKey, name, value: plainValue, encrypted_value_hex: encryptedValueHex }) => {
      const value = encryptedValueHex ? decryptChromiumCookieValue(hostKey, encryptedValueHex, key) : plainValue || "";
      if (!name || !value) return [];
      return `${name}=${value}`;
    })
    .join("; ");

  if (!cookie) throw new Error(`No Mobbin cookies found in ${join(profileDir, "Cookies")}`);
  return cookie;
}

function decryptChromiumCookieValue(hostKey, encryptedValueHex, key) {
  if (!encryptedValueHex) return "";
  const encryptedValue = Buffer.from(encryptedValueHex, "hex");
  if (encryptedValue.subarray(0, 3).toString() !== "v10") {
    return encryptedValue.toString("utf8");
  }

  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  let value = Buffer.concat([decipher.update(encryptedValue.subarray(3)), decipher.final()]);
  const hostHash = createHash("sha256").update(Buffer.from(hostKey)).digest("hex");
  if (value.length > 32 && value.subarray(0, 32).toString("hex") === hostHash) {
    value = value.subarray(32);
  } else if (value.length > 32 && hasBinaryPrefix(value.subarray(0, 32))) {
    value = value.subarray(32);
  }

  return value.toString("utf8");
}

function hasBinaryPrefix(buf) {
  let suspicious = 0;
  for (const byte of buf) {
    if (byte < 9 || (byte > 13 && byte < 32) || byte > 126) suspicious += 1;
  }
  return suspicious >= 8;
}

function latestAppVersion(appVersions) {
  return [...appVersions].sort((left, right) => {
    const rightDate = new Date(right.publishedAt || right.createdAt || 0).getTime();
    const leftDate = new Date(left.publishedAt || left.createdAt || 0).getTime();
    return rightDate - leftDate;
  })[0];
}

function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      if (!parsed._) parsed._ = [];
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  if (!parsed["page-url"] && parsed._?.[0]) parsed["page-url"] = parsed._[0];
  return parsed;
}

function deriveCategory(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const appSlug = parts[parts.indexOf("apps") + 1];
    if (!appSlug) return null;
    return appSlug
      .replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "")
      .replace(/-(ios|android|web)$/i, "");
  } catch {
    return null;
  }
}

function sanitizeCategory(value) {
  const sanitized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) fail(["Category resolved to an empty folder name"]);
  return sanitized;
}

function fail(issues) {
  console.error(JSON.stringify({ ok: false, issues }, null, 2));
  process.exit(2);
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-export.mjs --page-url <mobbin-url> [--category <name>]
  node scripts/run-export.mjs --query <app-name> [--platform ios] [--category <name>]

Options:
  --page-url <url>              Mobbin app screens or flows URL
  --query <app-name>            Resolve a Mobbin app URL from search
  --app <app-name>              Alias for --query
  --platform <platform>         Platform for query resolution. Default: ios
  --content-type <type>         Content route for query resolution. Default: screens
  --category <name>             Output subfolder name; derived from URL when omitted
  --limit <n>                   Export only first n screens
  --concurrency <n>             Exporter concurrency
  --images-dir <path>           Override image output directory
  --report-dir <path>           Override report output directory
  --profile-dir <path>          Override Dia/Chromium profile directory
  --safe-storage-service <name> Override macOS Keychain service
  --allow-duplicates            Do not fail when hashes repeat
  --allow-tiny                  Do not fail when tiny images are detected`);
}
