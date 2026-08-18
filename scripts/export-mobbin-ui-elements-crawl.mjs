#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const defaults = {
  platform: "ios",
  sort: "popularity",
  profileDir: "/Users/user/Library/Application Support/Dia/User Data/Default",
  safeStorageService: "Dia Safe Storage",
  outDir: "/Users/user/mobbin-sides/UI-element",
  reportDir: "/Users/user/mobbin-sides/UI-element-reports",
  appConcurrency: 8,
  screenConcurrency: 32,
  screenBatchSize: null,
  screenBatchConcurrency: null,
  aggregateInterval: 250,
  reportInterval: 5000,
};

const uiElements = [
  { group: "Control", name: "Accordion", count: 1464 },
  { group: "Control", name: "Button", count: 32574 },
  { group: "Control", name: "Checkbox", count: 1725 },
  { group: "Control", name: "Color Picker", count: 779 },
  { group: "Control", name: "Date Picker", count: 668 },
  { group: "Control", name: "Floating Action Button", count: 2241 },
  { group: "Control", name: "Radio Button", count: 1355 },
  { group: "Control", name: "Rating Control", count: 380 },
  { group: "Control", name: "Search Bar", count: 5497 },
  { group: "Control", name: "Segmented Control", count: 2289 },
  { group: "Control", name: "Slider", count: 1667 },
  { group: "Control", name: "Stepper", count: 901 },
  { group: "Control", name: "Switch", count: 4070 },
  { group: "Control", name: "Tab", count: 5989 },
  { group: "Control", name: "Text Field", count: 13452 },
  { group: "Control", name: "Tile", count: 3248 },
  { group: "Control", name: "Time Picker", count: 423 },

  { group: "View", name: "Badge", count: 3235 },
  { group: "View", name: "Banner", count: 3432 },
  { group: "View", name: "Card", count: 10325 },
  { group: "View", name: "Carousel", count: 6803 },
  { group: "View", name: "Chip", count: 4096 },
  { group: "View", name: "Divider", count: 5154 },
  { group: "View", name: "Gallery", count: 3071 },
  { group: "View", name: "Loading Indicator", count: 3055 },
  { group: "View", name: "Map Pin", count: 1289 },
  { group: "View", name: "Progress Indicator", count: 4174 },
  { group: "View", name: "Side Navigation", count: 260 },
  { group: "View", name: "Skeleton", count: 471 },
  { group: "View", name: "Stacked List", count: 11568 },
  { group: "View", name: "Status Dot", count: 798 },
  { group: "View", name: "Tab Bar", count: 3626 },
  { group: "View", name: "Table", count: 582 },
  { group: "View", name: "Toolbar", count: 2509 },
  { group: "View", name: "Top Navigation Bar", count: 2849 },

  { group: "Overlay", name: "Action Sheet", count: 177 },
  { group: "Overlay", name: "Bottom Sheet", count: 13876 },
  { group: "Overlay", name: "Coach Marks", count: 1608 },
  { group: "Overlay", name: "Dialog", count: 4242 },
  { group: "Overlay", name: "Drawer", count: 314 },
  { group: "Overlay", name: "Dropdown Menu", count: 955 },
  { group: "Overlay", name: "Full-Screen Overlay", count: 2976 },
  { group: "Overlay", name: "Toast", count: 3083 },
  { group: "Overlay", name: "Tooltip", count: 440 },

  { group: "Imagery", name: "Avatar", count: 7285 },
  { group: "Imagery", name: "Icon", count: 7215 },
  { group: "Imagery", name: "Illustration", count: 6459 },
  { group: "Imagery", name: "Logo", count: 1946 },
  { group: "Imagery", name: "Photo", count: 2316 },
];

const args = parseArgs(process.argv.slice(2));
const platform = String(args.platform || defaults.platform);
const sort = String(args.sort || defaults.sort);
const profileDir = String(args["profile-dir"] || defaults.profileDir);
const safeStorageService = String(args["safe-storage-service"] || defaults.safeStorageService);
const outDir = String(args["out-dir"] || defaults.outDir);
const reportDir = String(args["report-dir"] || defaults.reportDir);
const appConcurrency = Number(args["app-concurrency"] || defaults.appConcurrency);
const screenConcurrency = Number(args["screen-concurrency"] || defaults.screenConcurrency);
const screenBatchSize = args["screen-batch-size"] ? Number(args["screen-batch-size"]) : defaults.screenBatchSize;
const screenBatchConcurrency = args["screen-batch-concurrency"]
  ? Number(args["screen-batch-concurrency"])
  : defaults.screenBatchConcurrency;
const aggregateInterval = Number(args["aggregate-interval"] || defaults.aggregateInterval);
const reportInterval = Number(args["report-interval"] || defaults.reportInterval);
const limitApps = args["limit-apps"] ? Number(args["limit-apps"]) : null;
const limitScreens = args["limit-screens"] || args.limit ? Number(args["limit-screens"] || args.limit) : null;
const dryRun = Boolean(args["dry-run"]);

const selectedElements = selectElements(args);
const selectedByName = new Map(selectedElements.map((element) => [element.name, element]));
const selectedNames = new Set(selectedByName.keys());
const selectedBySlug = new Map(selectedElements.map((element) => [slugify(element.name), element]));

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        platform,
        sort,
        outDir,
        reportDir,
        appConcurrency,
        screenConcurrency,
        screenBatchSize,
        screenBatchConcurrency,
        aggregateInterval,
        reportInterval,
        selectedElementCount: selectedElements.length,
        selectedElements,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
await mkdir(reportDir, { recursive: true });
for (const element of selectedElements) {
  await mkdir(join(outDir, slugify(element.name)), { recursive: true });
  await mkdir(join(reportDir, slugify(element.name)), { recursive: true });
}

const cookie = await buildMobbinCookieHeader({ profileDir, safeStorageService });
const startedAt = new Date().toISOString();

console.error("fetching app catalog");
const apps = await fetchFilteredApps(
  {
    contentType: "apps",
    platform,
    type: "filters",
    activeFilterTags: [],
    categories: null,
    sortBy: sort,
  },
  cookie,
  limitApps,
);
console.error(`catalog apps: ${apps.length}`);

const crawlReport = [];
const screenMap = new Map();
const elementResults = new Map(selectedElements.map((element) => [slugify(element.name), []]));
let elementMatchedCounts = null;
let nextAppIndex = 0;

async function appWorker(workerIndex) {
  for (;;) {
    const index = nextAppIndex;
    nextAppIndex += 1;
    if (index >= apps.length) return;
    const app = apps[index];
    const appResult = await crawlApp(app, index, apps.length, workerIndex);
    crawlReport[index] = appResult;
    if ((index + 1) % 25 === 0 || index + 1 === apps.length) await writeAggregateReport({ phase: "crawling" });
  }
}

await Promise.all(Array.from({ length: Math.max(1, appConcurrency) }, (_, index) => appWorker(index + 1)));

let screens = [...screenMap.values()];
if (limitScreens) screens = screens.slice(0, limitScreens);
elementMatchedCounts = countElementMatches(screens);

console.error(`matched unique screens: ${screens.length}`);
await writeAggregateReport({ phase: "downloading", matchedUniqueScreens: screens.length });

let nextScreenIndex = 0;
let completedScreenCount = 0;

async function screenWorker(workerIndex) {
  for (;;) {
    const index = nextScreenIndex;
    nextScreenIndex += 1;
    if (index >= screens.length) return;
    const screen = screens[index];
    const results = await exportScreen(screen, index, screens.length, workerIndex);
    for (const result of results) {
      elementResults.get(result.uiElementSlug)?.push(result);
    }
    const processedCount = index + 1;
    if (reportInterval > 0 && (processedCount % reportInterval === 0 || processedCount === screens.length)) {
      await writeElementReports();
    }
    if (processedCount % aggregateInterval === 0 || processedCount === screens.length) {
      await writeAggregateReport({ phase: "downloading", matchedUniqueScreens: screens.length });
    }
  }
}

async function screenBatchWorker(batchWorkerIndex) {
  for (;;) {
    const batchStart = nextScreenIndex;
    nextScreenIndex += screenBatchSize;
    if (batchStart >= screens.length) return;

    const batchEnd = Math.min(batchStart + screenBatchSize, screens.length);
    const batchIndices = [];
    for (let index = batchStart; index < batchEnd; index += 1) batchIndices.push(index);

    await Promise.all(
      batchIndices.map(async (index) => {
        const screen = screens[index];
        const results = await exportScreen(screen, index, screens.length, `batch-${batchWorkerIndex}`);
        for (const result of results) {
          elementResults.get(result.uiElementSlug)?.push(result);
        }
      }),
    );

    completedScreenCount += batchIndices.length;
    console.error(`[batch ${batchWorkerIndex}] processed ${completedScreenCount}/${screens.length}`);

    if (reportInterval > 0 && (completedScreenCount % reportInterval === 0 || completedScreenCount === screens.length)) {
      await writeElementReports();
    }
    if (completedScreenCount % aggregateInterval === 0 || completedScreenCount === screens.length) {
      await writeAggregateReport({ phase: "downloading", matchedUniqueScreens: screens.length });
    }
  }
}

if (screenBatchSize && screenBatchConcurrency) {
  console.error(
    `downloading in batch mode: ${screenBatchConcurrency} concurrent batches x ${screenBatchSize} screens = up to ${
      screenBatchConcurrency * screenBatchSize
    } active downloads`,
  );
  await Promise.all(
    Array.from({ length: Math.max(1, screenBatchConcurrency) }, (_, index) => screenBatchWorker(index + 1)),
  );
} else {
  await Promise.all(Array.from({ length: Math.max(1, screenConcurrency) }, (_, index) => screenWorker(index + 1)));
}
await writeElementReports();
await writeAggregateReport({ phase: "complete", matchedUniqueScreens: screens.length });

const summary = summarizeAll();
console.log(JSON.stringify(summary, null, 2));

async function crawlApp(app, index, total, workerIndex) {
  const pageUrl = appPageUrl(app);
  try {
    const appPage = await loadAppPageScreens(pageUrl, cookie, app);
    let matchedScreenCount = 0;

    for (const screen of appPage.screens) {
      const matchingElements = extractDisplayNames(screen.screenElements).filter((name) => selectedNames.has(name));
      if (matchingElements.length === 0) continue;
      matchedScreenCount += 1;

      const existing = screenMap.get(screen.id);
      if (existing) {
        for (const name of matchingElements) existing.uiElements.add(name);
      } else {
        screenMap.set(screen.id, {
          ...screen,
          appId: screen.appId ?? app.id,
          appName: screen.appName ?? app.appName,
          appVersionId: screen.appVersionId ?? app.appVersionId,
          uiElements: new Set(matchingElements),
        });
      }
    }

    console.error(
      `[app ${workerIndex}] ${index + 1}/${total} ${app.appName}: ${matchedScreenCount}/${appPage.screens.length} matched, total unique ${screenMap.size}`,
    );
    return {
      appName: app.appName,
      appId: app.id,
      appVersionId: app.appVersionId,
      pageUrl,
      screenCount: appPage.screens.length,
      matchedScreenCount,
    };
  } catch (error) {
    console.error(`[app ${workerIndex}] ${index + 1}/${total} ${app.appName}: ${error.message}`);
    return {
      appName: app.appName,
      appId: app.id,
      appVersionId: app.appVersionId,
      pageUrl,
      error: error.message,
    };
  }
}

async function exportScreen(screen, index, total, workerIndex) {
  const uiElementsForScreen = [...screen.uiElements].filter((name) => selectedByName.has(name));
  try {
    let info = null;
    let sourceLookup = "pagePayload.downloadableSrc";
    let chosen = chooseDownloadableImageSource(screen.screenCdnImgSources);
    if (!chosen?.url) {
      info = await fetchScreenInfo(screen.id, cookie);
      sourceLookup = "fetch-screen-info";
      chosen = chooseBestImageSource(info.screenCdnImgSources);
    }
    if (!chosen?.url) throw new Error("No downloadable image source");

    const imageResp = await fetch(chosen.url, {
      redirect: "follow",
      cache: "no-store",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; MobbinSidesUIElementExporter/1.0)",
        accept: "image/webp,image/png,image/jpeg,image/*,*/*",
      },
    });
    const bytes = Buffer.from(await imageResp.arrayBuffer());
    const contentType = imageResp.headers.get("content-type") || "";
    const digest = sha256(bytes);
    const dimensions = imageDimensions(bytes, contentType);
    const filename = `${sanitizeFilename(screen.appName || "app")}-${screen.id}-${sanitizeFilename(chosen.descriptor)}-${digest.slice(0, 12)}${extensionForContentType(contentType)}`;
    const canSave = imageResp.ok && /^image\//.test(contentType);
    let canonicalSavedPath = null;

    const results = [];
    for (const elementName of uiElementsForScreen) {
      const element = selectedByName.get(elementName);
      const uiElementSlug = slugify(elementName);
      const savedPath = join(outDir, uiElementSlug, filename);

      if (canSave) {
        if (!canonicalSavedPath) {
          await writeFile(savedPath, bytes);
          canonicalSavedPath = savedPath;
        } else {
          try {
            await link(canonicalSavedPath, savedPath);
          } catch {
            await writeFile(savedPath, bytes);
          }
        }
      }

      results.push({
        index: index + 1,
        screenId: screen.id,
        appId: screen.appId ?? null,
        appName: screen.appName ?? null,
        appVersionId: screen.appVersionId ?? null,
        screenNumber: info?.screenNumber ?? null,
        uiElement: element.name,
        uiElementSlug,
        uiElementGroup: element.group,
        restricted: Boolean(screen.restricted),
        descriptor: chosen.descriptor,
        sourceLookup,
        status: imageResp.status,
        contentType,
        contentLengthHeader: imageResp.headers.get("content-length"),
        bytes: bytes.length,
        sha256: digest,
        dimensions,
        declaredWidth: info?.width ?? screen.width ?? null,
        declaredHeight: info?.height ?? screen.height ?? null,
        urlHost: new URL(chosen.url).host,
        urlPathHash: sha256(Buffer.from(new URL(chosen.url).pathname)),
        savedPath: canSave ? savedPath : null,
      });
    }

    if ((index + 1) % 25 === 0 || index + 1 === total) {
      console.error(`[screen ${workerIndex}] processed ${index + 1}/${total}`);
    }
    return results;
  } catch (error) {
    return uiElementsForScreen.map((elementName) => {
      const element = selectedByName.get(elementName);
      return {
        index: index + 1,
        screenId: screen.id,
        appId: screen.appId ?? null,
        appName: screen.appName ?? null,
        appVersionId: screen.appVersionId ?? null,
        uiElement: element.name,
        uiElementSlug: slugify(element.name),
        uiElementGroup: element.group,
        restricted: Boolean(screen.restricted),
        status: "error",
        error: error.message,
        savedPath: null,
      };
    });
  }
}

async function writeElementReports() {
  for (const element of selectedElements) {
    const slug = slugify(element.name);
    const results = elementResults.get(slug) || [];
    const report = {
      generatedAt: new Date().toISOString(),
      source: "authenticated Dia session cookies plus all-app page crawl plus /api/screen/fetch-screen-info downloadableSrc",
      uiElement: element,
      screenCount: results.length,
      savedImageCount: results.filter((result) => result.status === 200 && result.savedPath).length,
      uniqueSha256Count: new Set(results.map((result) => result.sha256).filter(Boolean)).size,
      tinyImageCount: results.filter(
        (result) => (result.dimensions?.width || 0) > 0 && ((result.dimensions?.width || 0) < 100 || (result.dimensions?.height || 0) < 100),
      ).length,
      results: results.sort((left, right) => left.index - right.index),
    };
    await writeFile(join(reportDir, slug, "mobbin-screen-downloadables-report.json"), JSON.stringify(report, null, 2));
    await writeFile(join(reportDir, slug, "mobbin-screen-downloadables.csv"), toCsv(report.results));
  }
}

async function writeAggregateReport(extra = {}) {
  const elementSummaries = selectedElements.map((element) => {
    const slug = slugify(element.name);
    const results = elementResults.get(slug) || [];
    const matchedBeforeDownload =
      elementMatchedCounts?.get(slug) ??
      [...screenMap.values()].filter((screen) => screen.uiElements?.has(element.name)).length;
    return {
      ...element,
      slug,
      matchedScreenCount: Math.max(matchedBeforeDownload, results.length),
      savedImageCount: results.filter((result) => result.status === 200 && result.savedPath).length,
      reportPath: join(reportDir, slug, "mobbin-screen-downloadables-report.json"),
      imagesDir: join(outDir, slug),
    };
  });

  await writeFile(
    join(reportDir, "ui-elements-export-report.json"),
    JSON.stringify(
      {
        generatedAt: startedAt,
        updatedAt: new Date().toISOString(),
        platform,
        sort,
        outDir,
        reportDir,
        appCount: apps.length,
        crawledAppCount: crawlReport.filter(Boolean).length,
        appPageErrorCount: crawlReport.filter((result) => result?.error).length,
        matchedUniqueScreens: screenMap.size,
        selectedElementCount: selectedElements.length,
        appPages: crawlReport.filter(Boolean),
        elements: elementSummaries,
        ...extra,
      },
      null,
      2,
    ),
  );
}

function countElementMatches(screens) {
  const counts = new Map(selectedElements.map((element) => [slugify(element.name), 0]));
  for (const screen of screens) {
    for (const elementName of screen.uiElements || []) {
      const slug = slugify(elementName);
      if (counts.has(slug)) counts.set(slug, counts.get(slug) + 1);
    }
  }
  return counts;
}

function summarizeAll() {
  const summaries = selectedElements.map((element) => {
    const slug = slugify(element.name);
    const results = elementResults.get(slug) || [];
    return {
      name: element.name,
      slug,
      screenCount: results.length,
      savedImageCount: results.filter((result) => result.status === 200 && result.savedPath).length,
    };
  });
  return {
    outDir,
    reportDir,
    appCount: apps.length,
    matchedUniqueScreens: screenMap.size,
    totalElementScreenMemberships: summaries.reduce((total, item) => total + item.screenCount, 0),
    totalSavedImageMemberships: summaries.reduce((total, item) => total + item.savedImageCount, 0),
    elements: summaries,
  };
}

async function fetchFilteredApps(searchQuery, cookieHeader, limit) {
  let searchRequestId = randomUUID();
  const apps = [];

  for (let pageIndex = 0; ; pageIndex += 1) {
    const resp = await fetch("https://mobbin.com/api/search/fetch-search-page-apps", {
      method: "POST",
      cache: "no-store",
      headers: {
        cookie: cookieHeader,
        "user-agent": "Mozilla/5.0 (compatible; MobbinSidesUIElementExporter/1.0)",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ searchRequestId, pageIndex, searchQuery }),
    });
    const responseJson = await resp.json();
    if (!resp.ok || responseJson.error) {
      throw new Error(
        `fetch-search-page-apps failed on page ${pageIndex}: ${resp.status} ${responseJson.error?.message || ""}`,
      );
    }

    const value = responseJson.value;
    searchRequestId = value?.searchRequestId || searchRequestId;
    const data = Array.isArray(value?.data) ? value.data : [];
    apps.push(...data);
    console.error(`app catalog page ${pageIndex}: received ${data.length}, total apps ${apps.length}`);
    if (limit && apps.length >= limit) break;
    if (!value?.hasNextPage || data.length === 0) break;
  }

  const deduped = new Map();
  for (const app of apps.slice(0, limit || apps.length)) {
    if (app?.id && !deduped.has(app.id)) deduped.set(app.id, app);
  }
  return [...deduped.values()];
}

async function loadAppPageScreens(pageUrl, cookieHeader, app) {
  const { resp: pageResp, text: html } = await fetchTextWithRetry(pageUrl, {
    redirect: "follow",
    cache: "no-store",
    headers: {
      cookie: cookieHeader,
      "user-agent": "Mozilla/5.0 (compatible; MobbinSidesUIElementExporter/1.0)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!pageResp.ok) throw new Error(`Mobbin page fetch failed: ${pageResp.status} ${pageResp.statusText}`);

  const chunks = extractNextFlightChunks(html);
  const screens = findMainScreensArray(chunks.join("\n"), {
    appId: app.id,
    appVersionId: app.appVersionId,
  });

  return {
    screens,
    pageFetch: {
      status: pageResp.status,
      finalUrl: pageResp.url,
      htmlBytes: html.length,
      nextFlightChunks: chunks.length,
    },
  };
}

async function fetchTextWithRetry(url, options, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const resp = await fetch(url, options);
      const text = await resp.text();
      return { resp, text };
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(500 * attempt);
    }
  }
  throw lastError;
}

async function fetchScreenInfo(screenId, cookieHeader) {
  const resp = await fetch("https://mobbin.com/api/screen/fetch-screen-info", {
    method: "POST",
    cache: "no-store",
    headers: {
      cookie: cookieHeader,
      "user-agent": "Mozilla/5.0 (compatible; MobbinSidesUIElementExporter/1.0)",
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ screenId }),
  });
  const payload = await resp.json();
  if (!resp.ok || payload.error) {
    throw new Error(`fetch-screen-info failed for ${screenId}: ${resp.status} ${payload.error?.message || ""}`);
  }
  return payload.value;
}

function chooseBestImageSource(sources) {
  if (!sources) return null;
  if (typeof sources.downloadableSrc === "string") {
    return { url: sources.downloadableSrc, descriptor: "downloadableSrc" };
  }
  const bestSrcSet = Array.isArray(sources.srcSet)
    ? [...sources.srcSet].sort((left, right) => descriptorRank(right.descriptor) - descriptorRank(left.descriptor))[0]
    : null;
  if (bestSrcSet?.url) return { url: bestSrcSet.url, descriptor: bestSrcSet.descriptor || "srcSet" };
  if (typeof sources.src === "string") return { url: sources.src, descriptor: "src" };
  return null;
}

function chooseDownloadableImageSource(sources) {
  if (!sources) return null;
  if (typeof sources.downloadableSrc === "string") {
    return { url: sources.downloadableSrc, descriptor: "downloadableSrc" };
  }
  return null;
}

async function buildMobbinCookieHeader({ profileDir, safeStorageService }) {
  const cookieDb = join(profileDir, "Cookies");
  const tempDir = await mkdtemp(join(tmpdir(), "mobbin-sides-"));
  const tempCookieDb = join(tempDir, "Cookies");
  await copyFile(cookieDb, tempCookieDb);

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

  if (rows.length === 0) throw new Error(`No Mobbin cookies found in ${cookieDb}`);

  return rows
    .flatMap(({ host_key: hostKey, name, value: plainValue, encrypted_value_hex: encryptedValueHex }) => {
      const value = encryptedValueHex ? decryptChromiumCookieValue(hostKey, encryptedValueHex, key) : plainValue || "";
      if (!name || !value) return [];
      return `${name}=${value}`;
    })
    .join("; ");
}

function decryptChromiumCookieValue(hostKey, encryptedValueHex, key) {
  if (!encryptedValueHex) return "";
  const encryptedValue = Buffer.from(encryptedValueHex, "hex");
  if (encryptedValue.subarray(0, 3).toString() !== "v10") return encryptedValue.toString("utf8");

  const iv = Buffer.alloc(16, " ");
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  let value = Buffer.concat([decipher.update(encryptedValue.subarray(3)), decipher.final()]);

  const hostHash = sha256(Buffer.from(hostKey));
  if (value.length > 32 && value.subarray(0, 32).toString("hex") === hostHash) {
    value = value.subarray(32);
  } else if (value.length > 32 && hasBinaryPrefix(value.subarray(0, 32))) {
    value = value.subarray(32);
  }

  return value.toString("utf8");
}

function findMainScreensArray(joinedFlightPayload, target) {
  const marker = '"screens":[{"type":"curated"';
  const candidates = [];
  let searchFrom = 0;

  for (;;) {
    const markerIndex = joinedFlightPayload.indexOf(marker, searchFrom);
    if (markerIndex < 0) break;
    const arrayStart = joinedFlightPayload.indexOf("[", markerIndex);
    try {
      const parsed = JSON.parse(extractJsonArray(joinedFlightPayload, arrayStart));
      const matching = parsed.filter(
        (screen) =>
          screen &&
          screen.appId === target.appId &&
          screen.appVersionId === target.appVersionId &&
          screen.screenCdnImgSources,
      );
      if (matching.length > 0) candidates.push(matching);
    } catch {
      // Continue looking; Next flight chunks include other arrays that are not the app grid.
    }
    searchFrom = markerIndex + marker.length;
  }

  if (candidates.length === 0) {
    throw new Error(`No authenticated Mobbin screen array found for ${target.appId}/${target.appVersionId}`);
  }

  const deduped = new Map();
  for (const screen of candidates.sort((left, right) => right.length - left.length)[0]) {
    if (!deduped.has(screen.id)) deduped.set(screen.id, screen);
  }
  return [...deduped.values()];
}

function extractNextFlightChunks(html) {
  const chunks = [];
  const scriptRegex = /<script[^>]*>(self\.__next_f\.push\([\s\S]*?\))<\/script>/g;
  for (const match of html.matchAll(scriptRegex)) {
    const jsonText = match[1].slice("self.__next_f.push(".length, -1);
    try {
      const arr = JSON.parse(jsonText);
      if (typeof arr[1] === "string") chunks.push(arr[1]);
    } catch {
      // Ignore non-parseable chunks.
    }
  }
  return chunks;
}

function extractJsonArray(text, start) {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaping) escaping = false;
      else if (char === "\\") escaping = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  throw new Error("Could not find end of JSON array");
}

function selectElements(parsedArgs) {
  const requested = [
    ...splitList(parsedArgs.element),
    ...splitList(parsedArgs.elements),
    ...splitList(parsedArgs["screen-element"]),
  ];
  if (parsedArgs.all || requested.length === 0) return uiElements;

  const bySlug = new Map(uiElements.map((element) => [slugify(element.name), element]));
  return requested.map((name) => {
    const match = bySlug.get(slugify(name));
    if (!match) throw new Error(`Unknown UI element: ${name}`);
    return match;
  });
}

function extractDisplayNames(value) {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (typeof item === "string") return [item];
      if (!item || typeof item !== "object") return [];
      return [item.displayName, item.name, item.title, item.slug].filter(Boolean);
    })
    .map(String);
}

function imageDimensions(buf, contentType) {
  if (buf.length >= 30 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") {
    const fourcc = ascii(buf, 12, 4);
    if (fourcc === "VP8 ") {
      return {
        format: "WEBP/VP8",
        width: (buf[26] | (buf[27] << 8)) & 0x3fff,
        height: (buf[28] | (buf[29] << 8)) & 0x3fff,
      };
    }
    if (fourcc === "VP8X") {
      return {
        format: "WEBP/VP8X",
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
    if (fourcc === "VP8L") {
      const bits = buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24);
      return {
        format: "WEBP/VP8L",
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    }
  }

  if (buf.length >= 24 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return { format: "PNG", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  return { format: contentType || "unknown", width: null, height: null };
}

function toCsv(rows) {
  const columns = [
    "index",
    "screenId",
    "screenNumber",
    "appId",
    "appName",
    "appVersionId",
    "uiElement",
    "uiElementGroup",
    "restricted",
    "descriptor",
    "status",
    "contentType",
    "contentLengthHeader",
    "bytes",
    "sha256",
    "width",
    "height",
    "declaredWidth",
    "declaredHeight",
    "urlHost",
    "urlPathHash",
    "savedPath",
    "error",
  ];
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(
      columns
        .map((column) => {
          const value =
            column === "width"
              ? row.dimensions?.width
              : column === "height"
                ? row.dimensions?.height
                : row[column];
          return csvCell(value);
        })
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  if (value == null) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replaceAll('"', '""')}"`;
  return str;
}

function appPageUrl(app) {
  return `https://mobbin.com/apps/${slugify(app.appName)}-${app.platform}-${app.id}/${app.appVersionId}/screens`;
}

function descriptorRank(descriptor) {
  const match = String(descriptor || "").match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function extensionForContentType(contentType) {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  return ".bin";
}

function sanitizeFilename(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function ascii(buf, start, length) {
  return buf.subarray(start, start + length).toString("ascii");
}

function hasBinaryPrefix(buf) {
  return buf.some((byte) => byte < 0x20 || byte > 0x7e);
}

function splitList(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
