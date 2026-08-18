#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, createDecipheriv, pbkdf2Sync, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const defaults = {
  pageUrl:
    "https://mobbin.com/apps/phantom-ios-28f44562-240b-48eb-997f-8a1a731499cb/689aadcf-d2e3-49bb-8ebb-e135252e28bd/screens",
  profileDir: "/Users/user/Library/Application Support/Dia/User Data/Default",
  safeStorageService: "Dia Safe Storage",
  imagesDir: "/Users/user/mobbin-sides/latest-images",
  reportDir: "/Users/user/mobbin-sides/latest-reports",
  category: "phantom",
  concurrency: 6,
};

const args = parseArgs(process.argv.slice(2));
const requestedUrl = String(args["search-url"] || args["page-url"] || args.url || defaults.pageUrl);
const profileDir = String(args["profile-dir"] || defaults.profileDir);
const safeStorageService = String(args["safe-storage-service"] || defaults.safeStorageService);
const category = sanitizeFilename(String(args.category || defaults.category));
const imagesDir = String(args["images-dir"] || join(defaults.imagesDir, category));
const reportDir = String(args["report-dir"] || join(defaults.reportDir, category));
const concurrency = Number(args.concurrency || defaults.concurrency);
const limit = args.limit ? Number(args.limit) : null;
const mode = shouldUseSearchMode(requestedUrl, args) ? "search" : "app-page";

await mkdir(imagesDir, { recursive: true });
await mkdir(reportDir, { recursive: true });

const cookie = await buildMobbinCookieHeader({
  profileDir,
  safeStorageService,
});

const source = mode === "search" ? await loadSearchScreens(requestedUrl, args, cookie, limit) : await loadAppPageScreens(requestedUrl, cookie);
const postFilterQuery = mode === "app-page" ? buildPostFilterQuery(args) : null;
const screens = postFilterQuery ? source.screens.filter((screen) => screenMatchesSearchFilters(screen, postFilterQuery)) : source.screens;
if (postFilterQuery) source.target.postFilter = postFilterQuery;
const selectedScreens = limit ? screens.slice(0, limit) : screens;

const results = [];
let nextIndex = 0;

async function worker() {
  for (;;) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= selectedScreens.length) return;
    results[index] = await exportScreen(selectedScreens[index], index, cookie);
    if ((index + 1) % 25 === 0 || index + 1 === selectedScreens.length) {
      console.error(`processed ${index + 1}/${selectedScreens.length}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

const report = {
  generatedAt: new Date().toISOString(),
  source: source.description,
  mode,
  pageUrl: requestedUrl,
  target: source.target,
  pageFetch: source.pageFetch,
  screenCount: results.length,
  savedImageCount: results.filter((result) => result.status === 200 && result.savedPath).length,
  uniqueSha256Count: new Set(results.map((result) => result.sha256)).size,
  tinyImageCount: results.filter(
    (result) => (result.dimensions?.width || 0) < 100 || (result.dimensions?.height || 0) < 100,
  ).length,
  results,
};

await writeFile(join(reportDir, "mobbin-screen-downloadables-report.json"), JSON.stringify(report, null, 2));
await writeFile(join(reportDir, "mobbin-screen-downloadables.csv"), toCsv(results));

console.log(
  JSON.stringify(
    {
      screenCount: report.screenCount,
      savedImageCount: report.savedImageCount,
      uniqueSha256Count: report.uniqueSha256Count,
      tinyImageCount: report.tinyImageCount,
      imagesDir,
      reportDir,
    },
    null,
    2,
  ),
);

async function exportScreen(screen, index, cookieHeader) {
  const info = await fetchScreenInfo(screen.id, cookieHeader);
  const sources = info.screenCdnImgSources;
  const chosen = chooseBestImageSource(sources);
  if (!chosen?.url) throw new Error(`No downloadable image source for screen ${screen.id}`);

  const imageResp = await fetch(chosen.url, {
    redirect: "follow",
    cache: "no-store",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; MobbinSidesExporter/1.0)",
      accept: "image/webp,image/png,image/jpeg,image/*,*/*",
    },
  });
  const bytes = Buffer.from(await imageResp.arrayBuffer());
  const contentType = imageResp.headers.get("content-type") || "";
  const digest = sha256(bytes);
  const dimensions = imageDimensions(bytes, contentType);
  const filename = `${String(index + 1).padStart(3, "0")}-${screen.id}-${sanitizeFilename(chosen.descriptor)}-${digest.slice(0, 12)}${extensionForContentType(contentType)}`;
  const savedPath = join(imagesDir, filename);

  if (imageResp.ok && /^image\//.test(contentType)) {
    await writeFile(savedPath, bytes);
  }

  return {
    index: index + 1,
    screenId: screen.id,
    appId: screen.appId ?? null,
    appName: screen.appName ?? null,
    appVersionId: screen.appVersionId ?? null,
    screenNumber: info.screenNumber ?? null,
    restricted: Boolean(screen.restricted),
    descriptor: chosen.descriptor,
    status: imageResp.status,
    contentType,
    contentLengthHeader: imageResp.headers.get("content-length"),
    bytes: bytes.length,
    sha256: digest,
    dimensions,
    declaredWidth: info.width ?? screen.width ?? null,
    declaredHeight: info.height ?? screen.height ?? null,
    urlHost: new URL(chosen.url).host,
    urlPathHash: sha256(Buffer.from(new URL(chosen.url).pathname)),
    savedPath: imageResp.ok && /^image\//.test(contentType) ? savedPath : null,
  };
}

async function loadAppPageScreens(pageUrl, cookie) {
  const target = parseMobbinAppPageUrl(pageUrl);
  const { resp: pageResp, text: html } = await fetchTextWithRetry(pageUrl, {
    redirect: "follow",
    cache: "no-store",
    headers: {
      cookie,
      "user-agent": "Mozilla/5.0 (compatible; MobbinSidesExporter/1.0)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!pageResp.ok) {
    throw new Error(`Mobbin page fetch failed: ${pageResp.status} ${pageResp.statusText}`);
  }

  const chunks = extractNextFlightChunks(html);
  const screens = findMainScreensArray(chunks.join("\n"), target);

  return {
    description: "authenticated Dia session cookies plus app page payload plus /api/screen/fetch-screen-info downloadableSrc",
    target,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadSearchScreens(searchUrl, args, cookie, limit) {
  const target = parseMobbinSearchTarget(searchUrl, args);
  let searchRequestId = randomUUID();
  const pages = [];
  const deduped = new Map();
  let advertisedTotalCount = null;

  for (let pageIndex = 0; ; pageIndex += 1) {
    const payload = {
      searchRequestId,
      pageIndex,
      searchQuery: target.searchQuery,
    };
    const resp = await fetch("https://mobbin.com/api/search/fetch-search-page-screens", {
      method: "POST",
      cache: "no-store",
      headers: {
        cookie,
        "user-agent": "Mozilla/5.0 (compatible; MobbinSidesExporter/1.0)",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const responseJson = await resp.json();
    if (!resp.ok || responseJson.error) {
      throw new Error(
        `fetch-search-page-screens failed on page ${pageIndex}: ${resp.status} ${responseJson.error?.message || ""}`,
      );
    }

    const value = responseJson.value;
    searchRequestId = value?.searchRequestId || searchRequestId;
    advertisedTotalCount ??= value?.totalCount ?? null;
    const data = Array.isArray(value?.data) ? value.data : [];
    for (const screen of data) {
      if (screen?.id && !deduped.has(screen.id)) deduped.set(screen.id, screen);
    }

    pages.push({
      pageIndex,
      status: resp.status,
      dataCount: data.length,
      totalCount: value?.totalCount ?? null,
      hasNextPage: Boolean(value?.hasNextPage),
      dedupedCount: deduped.size,
    });
    console.error(`search page ${pageIndex}: received ${data.length}, total unique ${deduped.size}`);

    if (!value?.hasNextPage) break;
    if (limit && deduped.size >= limit) break;
  }

  const endedEarly =
    advertisedTotalCount &&
    deduped.size < advertisedTotalCount &&
    pages.length > 1 &&
    pages.at(-1)?.dataCount === 0 &&
    hasLocalAppPageFallbackFilters(target.searchQuery);

  if (endedEarly) {
    console.error(
      `screen endpoint stopped at ${deduped.size}/${advertisedTotalCount}; falling back to app-page crawl`,
    );
    return loadSearchScreensViaAppPages(target, cookie, limit, pages);
  }

  return {
    description: "authenticated Dia session cookies plus /api/search/fetch-search-page-screens plus /api/screen/fetch-screen-info downloadableSrc",
    target,
    screens: [...deduped.values()],
    pageFetch: {
      endpoint: "https://mobbin.com/api/search/fetch-search-page-screens",
      pagesFetched: pages.length,
      pages,
    },
  };
}

async function loadSearchScreensViaAppPages(target, cookie, limit, directScreenPages) {
  const appSearchQuery = {
    contentType: "apps",
    platform: target.platform,
    type: "filters",
    activeFilterTags: (target.searchQuery.activeFilterTags || []).filter(
      (tag) => tag.categorySlug === "appCategories",
    ),
    categories: target.searchQuery.categories,
    sortBy: target.sortBy,
  };
  const apps = await fetchFilteredApps(appSearchQuery, cookie);
  const deduped = new Map();
  const appPages = [];

  for (const app of apps) {
    if (!app?.id || !app?.appVersionId || !app?.appName || !app?.platform) continue;
    const pageUrl = `https://mobbin.com/apps/${slugify(app.appName)}-${app.platform}-${app.id}/${app.appVersionId}/screens`;
    try {
      const appPage = await loadAppPageScreens(pageUrl, cookie);
      const matchedScreens = appPage.screens.filter((screen) => screenMatchesSearchFilters(screen, target.searchQuery));
      for (const screen of matchedScreens) {
        if (!deduped.has(screen.id)) {
          deduped.set(screen.id, {
            ...screen,
            appId: screen.appId ?? app.id,
            appName: screen.appName ?? app.appName,
            appVersionId: screen.appVersionId ?? app.appVersionId,
          });
        }
      }
      appPages.push({
        appName: app.appName,
        appId: app.id,
        appVersionId: app.appVersionId,
        pageUrl,
        screenCount: appPage.screens.length,
        matchedScreenCount: matchedScreens.length,
        dedupedCount: deduped.size,
      });
      console.error(`${app.appName}: matched ${matchedScreens.length}, total unique ${deduped.size}`);
      if (limit && deduped.size >= limit) break;
    } catch (error) {
      appPages.push({
        appName: app.appName,
        appId: app.id,
        appVersionId: app.appVersionId,
        pageUrl,
        error: error.message,
      });
      console.error(`${app.appName}: ${error.message}`);
    }
  }

  return {
    description: "authenticated Dia session cookies plus app-filter endpoint plus app page payload plus /api/screen/fetch-screen-info downloadableSrc",
    target: {
      ...target,
      appSearchQuery,
      appCount: apps.length,
    },
    screens: [...deduped.values()],
    pageFetch: {
      directScreenEndpointAttempt: directScreenPages,
      fallback: "app-page-crawl",
      appCount: apps.length,
      appPages,
    },
  };
}

async function fetchFilteredApps(searchQuery, cookie) {
  let searchRequestId = randomUUID();
  const apps = [];

  for (let pageIndex = 0; ; pageIndex += 1) {
    const resp = await fetch("https://mobbin.com/api/search/fetch-search-page-apps", {
      method: "POST",
      cache: "no-store",
      headers: {
        cookie,
        "user-agent": "Mozilla/5.0 (compatible; MobbinSidesExporter/1.0)",
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
    console.error(`app page ${pageIndex}: received ${data.length}, total apps ${apps.length}`);
    if (!value?.hasNextPage || data.length === 0) break;
  }

  const deduped = new Map();
  for (const app of apps) {
    if (app?.id && !deduped.has(app.id)) deduped.set(app.id, app);
  }
  return [...deduped.values()];
}

function screenMatchesSearchFilters(screen, searchQuery) {
  if (searchQuery.screenPatterns?.length) {
    const patterns = new Set(extractDisplayNames(screen.screenPatterns));
    if (!searchQuery.screenPatterns.every((pattern) => patterns.has(pattern))) return false;
  }
  if (searchQuery.screenElements?.length) {
    const elements = new Set(extractDisplayNames(screen.screenElements));
    if (!searchQuery.screenElements.every((element) => elements.has(element))) return false;
  }
  return true;
}

function hasLocalAppPageFallbackFilters(searchQuery) {
  return Boolean(
    searchQuery.categories?.length ||
      searchQuery.screenPatterns?.length ||
      searchQuery.screenElements?.length,
  );
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

async function fetchScreenInfo(screenId, cookieHeader) {
  const resp = await fetch("https://mobbin.com/api/screen/fetch-screen-info", {
    method: "POST",
    cache: "no-store",
    headers: {
      cookie: cookieHeader,
      "user-agent": "Mozilla/5.0 (compatible; MobbinSidesExporter/1.0)",
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

async function buildMobbinCookieHeader({ profileDir, safeStorageService }) {
  const cookieDb = join(profileDir, "Cookies");
  const tempDir = await mkdtemp(join(tmpdir(), "mobbin-sides-"));
  const tempCookieDb = join(tempDir, "Cookies");
  await copyFile(cookieDb, tempCookieDb);

  const safeStoragePassword = execFileSync("security", ["find-generic-password", "-w", "-s", safeStorageService], {
    encoding: "utf8",
  }).trim();
  const key = pbkdf2Sync(safeStoragePassword, "saltysalt", 1003, 16, "sha1");
  const rows = JSON.parse(execFileSync(
    "sqlite3",
    [
      "-json",
      tempCookieDb,
      "select host_key, name, coalesce(value,'') as value, coalesce(hex(encrypted_value),'') as encrypted_value_hex from cookies where host_key in ('mobbin.com','.mobbin.com') order by host_key,name;",
    ],
    { encoding: "utf8" },
  ));

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
  if (encryptedValue.subarray(0, 3).toString() !== "v10") {
    return encryptedValue.toString("utf8");
  }

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

function parseMobbinAppPageUrl(rawUrl) {
  const url = new URL(rawUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const appsIndex = parts.indexOf("apps");
  if (appsIndex < 0 || parts.length < appsIndex + 4) {
    throw new Error(`Expected a Mobbin app page URL, got ${rawUrl}`);
  }
  const appSlug = parts[appsIndex + 1];
  const appVersionId = parts[appsIndex + 2];
  const contentType = parts[appsIndex + 3];
  const uuidMatch = appSlug.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  if (!uuidMatch) throw new Error(`Could not extract app id from slug: ${appSlug}`);
  return {
    appSlug,
    appId: uuidMatch[0],
    appVersionId,
    contentType,
  };
}

function shouldUseSearchMode(rawUrl, parsedArgs) {
  if (parsedArgs["search-url"]) return true;
  if (parsedArgs["app-category"] || parsedArgs.filter) return true;
  try {
    return new URL(rawUrl).pathname.startsWith("/search/");
  } catch {
    return false;
  }
}

function buildPostFilterQuery(parsedArgs) {
  const screenPatterns = splitList(parsedArgs["screen-pattern"]);
  const screenElements = splitList(parsedArgs["screen-element"]);
  if (screenPatterns.length === 0 && screenElements.length === 0) return null;
  return {
    screenPatterns: screenPatterns.length ? screenPatterns : null,
    screenElements: screenElements.length ? screenElements : null,
  };
}

function parseMobbinSearchTarget(rawUrl, parsedArgs) {
  const url = new URL(rawUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const platform = String(parsedArgs.platform || parts.at(-1) || "ios");
  const sortBy = String(parsedArgs.sort || url.searchParams.get("sort") || "popularity");
  const requestedContentType = String(parsedArgs["content-type"] || url.searchParams.get("content_type") || "");
  const contentType = requestedContentType === "ui-elements" ? "ui-elements" : "screens";
  const filterTokens = [
    ...url.searchParams.getAll("filter"),
    ...splitList(parsedArgs.filter),
  ];

  for (const value of splitList(parsedArgs["app-category"])) {
    filterTokens.push(`appCategories.${value}`);
  }
  for (const value of splitList(parsedArgs["screen-pattern"])) {
    filterTokens.push(`screenPatterns.${value}`);
  }
  for (const value of splitList(parsedArgs["screen-element"])) {
    filterTokens.push(`screenElements.${value}`);
  }

  const grouped = {
    appCategories: [],
    screenPatterns: [],
    screenElements: [],
  };

  for (const token of filterTokens) {
    const [categorySlug, ...displayParts] = String(token).split(".");
    const displayName = displayParts.join(".").trim();
    if (!categorySlug || !displayName || !grouped[categorySlug]) continue;
    grouped[categorySlug].push(displayName);
  }

  const activeFilterTags = [
    ...grouped.appCategories.map((displayName) => ({ categorySlug: "appCategories", displayName })),
    ...grouped.screenPatterns.map((displayName) => ({ categorySlug: "screenPatterns", displayName })),
    ...grouped.screenElements.map((displayName) => ({ categorySlug: "screenElements", displayName })),
  ];

  const searchQuery = {
    contentType,
    platform,
    type: "filters",
    activeFilterTags,
    categories: grouped.appCategories.length ? grouped.appCategories : null,
    screenElements: grouped.screenElements.length ? grouped.screenElements : null,
    screenPatterns: grouped.screenPatterns.length ? grouped.screenPatterns : null,
    textInScreenshotQuery: parsedArgs["text-in-screenshot"] || null,
    hasAnimation: parsedArgs["has-animation"] ? true : null,
    sortBy,
  };

  if (!searchQuery.categories && !searchQuery.screenElements && !searchQuery.screenPatterns && !searchQuery.textInScreenshotQuery) {
    throw new Error("Search mode needs at least one filter, e.g. --app-category Shopping --screen-pattern Pricing");
  }

  return {
    searchUrl: rawUrl,
    platform,
    sortBy,
    searchQuery,
  };
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
  ];
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(
      columns
        .map((column) => {
          if (column === "width") return csvEscape(row.dimensions?.width);
          if (column === "height") return csvEscape(row.dimensions?.height);
          return csvEscape(row[column]);
        })
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function descriptorRank(descriptor) {
  const width = /^(\d+)w$/.exec(descriptor || "")?.[1];
  if (width) return Number(width);
  if (descriptor === "src") return 720;
  return 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function ascii(buf, offset, length) {
  return Array.from(buf.slice(offset, offset + length))
    .map((byte) => String.fromCharCode(byte))
    .join("");
}

function extensionForContentType(contentType) {
  if (/image\/webp/i.test(contentType || "")) return ".webp";
  if (/image\/png/i.test(contentType || "")) return ".png";
  if (/image\/jpe?g/i.test(contentType || "")) return ".jpg";
  return `.${basename(contentType || "bin").replace(/[^a-z0-9]/gi, "") || "bin"}`;
}

function sanitizeFilename(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function hasBinaryPrefix(buf) {
  let nonPrintable = 0;
  for (const byte of buf) {
    if (byte < 0x20 || byte > 0x7e) nonPrintable += 1;
  }
  return nonPrintable > 8;
}
