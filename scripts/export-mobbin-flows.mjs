#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, createDecipheriv, pbkdf2Sync, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const defaults = {
  platform: "ios",
  flowAction: "Transferring Money",
  sortBy: "popularity",
  profileDir: "/Users/user/Library/Application Support/Dia/User Data/Default",
  safeStorageService: "Dia Safe Storage",
  outDir: "/Users/user/mobbin-sides/flows",
  concurrency: 6,
  screenConcurrency: 4,
  appConcurrency: 8,
};

const allFlowActions = [
  "Browsing Tutorial",
  "Creating Account",
  "Onboarding",
  "Editing Profile",
  "Deleting & Deactivating Account",
  "Logging In",
  "Logging Out",
  "Resetting Password",
  "Switching Account",
  "Adding to Cart & Bag",
  "Booking & Reserving",
  "Canceling Order & Refunding",
  "Canceling Subscription",
  "Listing",
  "Purchasing & Ordering",
  "Redeeming",
  "Subscribing & Upgrading",
  "Transferring Money",
  "Banning & Blocking",
  "Calling",
  "Chatting & Sending Messages",
  "Commenting & Replying",
  "Following & Subscribing",
  "Gifting",
  "Giving Feedback",
  "Inviting Teammates & Friends",
  "Joining & Accepting",
  "Leaving",
  "Liking & Upvoting",
  "Muting",
  "Referring Friends",
  "Registering",
  "Reporting",
  "Requesting",
  "Reviewing & Rating",
  "Scheduling",
  "Sharing",
  "Adding & Creating",
  "Archiving",
  "Copying & Duplicating",
  "Deleting & Removing",
  "Drawing",
  "Editing & Updating",
  "Favoriting & Pinning",
  "Filtering & Sorting",
  "Importing & Exporting",
  "Listening to Audio",
  "Logging & Tracking",
  "Marking",
  "Moving",
  "Publishing",
  "Recording Audio & Video",
  "Reordering",
  "Saving to Collection",
  "Scanning",
  "Searching & Finding",
  "Selecting & Choosing",
  "Starting & Completing",
  "Taking Photos",
  "Uploading & Downloading",
  "Watching Video",
  "Changing Language",
  "Connecting & Linking",
  "Enabling & Disabling",
  "Setting Up",
  "Showing & Hiding",
  "Switching to Dark Mode",
  "Switching View",
  "Turning On/Off",
  "Verifying",
  "Misc",
];

const args = parseArgs(process.argv.slice(2));
const profileDir = String(args["profile-dir"] || defaults.profileDir);
const safeStorageService = String(args["safe-storage-service"] || defaults.safeStorageService);
const platform = String(args.platform || defaults.platform);
const sortBy = String(args.sort || args["sort-by"] || defaults.sortBy);
const appPageUrl = args["app-page-url"] || args["page-url"] ? String(args["app-page-url"] || args["page-url"]) : null;
const flowActions = args["all-flow-actions"]
  ? allFlowActions
  : appPageUrl
    ? []
    : splitList(args["flow-action"] || args["flow-actions"] || defaults.flowAction);
const outDir = String(args["out-dir"] || defaults.outDir);
const concurrency = Number(args.concurrency || defaults.concurrency);
const screenConcurrency = Number(args["screen-concurrency"] || defaults.screenConcurrency);
const appConcurrency = Number(args["app-concurrency"] || defaults.appConcurrency);
const limitFlows = args["limit-flows"] ? Number(args["limit-flows"]) : null;
const limitScreens = args["limit-screens"] ? Number(args["limit-screens"]) : null;
const limitApps = args["limit-apps"] ? Number(args["limit-apps"]) : null;
const reuseExisting = !args.force;
const crawlAppPages = Boolean(args["crawl-app-pages"]);
const crawlAllAppVersions = Boolean(args["crawl-all-app-versions"]);

if (!appPageUrl && flowActions.length === 0) {
  throw new Error("Provide at least one flow action, e.g. --flow-action 'Editing Profile'");
}

const cookie = await buildMobbinCookieHeader({
  profileDir,
  safeStorageService,
});

const actionSummaries = [];

if (appPageUrl) {
  const app = parseMobbinAppPageUrl(appPageUrl);
  const appSlug = slugify(args.category || app.appName || "app-flows");
  const appOutDir = join(outDir, appSlug);
  await mkdir(appOutDir, { recursive: true });

  const appPage = await loadAppPageFlows(appPageUrl.replace(/\/screens(?:[?#].*)?$/, "/flows"), cookie, app, null);
  const selectedFlows = limitFlows ? appPage.flows.slice(0, limitFlows) : appPage.flows;
  const results = [];
  let nextFlowIndex = 0;

  async function worker() {
    for (;;) {
      const flowIndex = nextFlowIndex;
      nextFlowIndex += 1;
      if (flowIndex >= selectedFlows.length) return;
      const flow = selectedFlows[flowIndex];
      try {
        results[flowIndex] = await exportFlow({
          flow,
          flowIndex,
          actionOutDir: appOutDir,
          cookie,
          limitScreens,
          reuseExisting,
          screenConcurrency,
        });
        const reused = results[flowIndex]?.reusedExisting ? "reused" : "processed";
        console.error(
          `${app.appName}: ${reused} flow ${flowIndex + 1}/${selectedFlows.length} (${flow.name || flow.id})`,
        );
      } catch (error) {
        results[flowIndex] = {
          flowId: flow.id ?? null,
          flowName: flow.name ?? null,
          appId: flow.appId ?? app.id,
          appName: flow.appName ?? app.appName,
          appVersionId: flow.appVersionId ?? app.appVersionId,
          platform: flow.platform ?? app.platform,
          restricted: Boolean(flow.restricted),
          screenCount: Array.isArray(flow.screens) ? flow.screens.length : 0,
          savedImageCount: 0,
          folder: join(appOutDir, uniqueFlowFolderName(flow, flowIndex)),
          error: error.message,
          screens: [],
        };
        console.error(
          `${app.appName}: failed flow ${flowIndex + 1}/${selectedFlows.length} (${flow.name || flow.id}): ${error.message}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const screenRows = results.flatMap((result) => result.screens);
  const report = {
    generatedAt: new Date().toISOString(),
    description:
      "authenticated Dia session cookies plus single app /flows page crawl plus /api/screen/fetch-screen-info downloadableSrc",
    target: {
      appPageUrl,
      outputDirectory: appOutDir,
      app,
    },
    pageFetch: {
      ...appPage.pageFetch,
      discoveryMethod: "single-app-page-flows",
      paginationComplete: true,
    },
    exportedFlowCount: results.length,
    advertisedFlowScreenCount: selectedFlows.reduce(
      (sum, flow) => sum + (Array.isArray(flow.screens) ? flow.screens.length : 0),
      0,
    ),
    exportedScreenCount: screenRows.length,
    savedImageCount: screenRows.filter((row) => row.status === 200 && row.savedPath).length,
    uniqueSha256Count: new Set(screenRows.map((row) => row.sha256).filter(Boolean)).size,
    tinyImageCount: screenRows.filter(
      (row) => (row.dimensions?.width || 0) < 100 || (row.dimensions?.height || 0) < 100,
    ).length,
    failedFlowCount: results.filter((result) => result.error).length,
    reusedExistingFlowCount: results.filter((result) => result.reusedExisting).length,
    flows: results,
  };

  await writeFile(join(appOutDir, "flow-export-report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(appOutDir, "flow-export-report.csv"), toCsv(screenRows));

  console.log(
    JSON.stringify(
      {
        appName: app.appName,
        exportedFlowCount: report.exportedFlowCount,
        exportedScreenCount: report.exportedScreenCount,
        savedImageCount: report.savedImageCount,
        uniqueSha256Count: report.uniqueSha256Count,
        tinyImageCount: report.tinyImageCount,
        failedFlowCount: report.failedFlowCount,
        outputDirectory: appOutDir,
        reportPath: join(appOutDir, "flow-export-report.json"),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

for (const flowAction of flowActions) {
  const actionSlug = slugify(flowAction);
  const actionOutDir = join(outDir, actionSlug);
  await mkdir(actionOutDir, { recursive: true });

  if (reuseExisting && !limitFlows && !limitScreens) {
    const existingActionReport = await readExistingActionReport(actionOutDir, flowAction);
    if (existingActionReport) {
      console.error(`${flowAction}: reused completed action report`);
      actionSummaries.push(actionSummaryFromReport(existingActionReport, actionOutDir));
      continue;
    }
  }

  const source = crawlAppPages
    ? await loadFlowsFromAppPages({
        platform,
        sortBy,
        flowAction,
        cookie,
        limitFlows,
        limitApps,
        appConcurrency,
        crawlAllAppVersions,
      })
    : await loadSearchFlows({ platform, sortBy, flowAction, cookie, limitFlows });
  const selectedFlows = limitFlows ? source.flows.slice(0, limitFlows) : source.flows;
  const results = [];
  let nextFlowIndex = 0;

  async function worker() {
    for (;;) {
      const flowIndex = nextFlowIndex;
      nextFlowIndex += 1;
      if (flowIndex >= selectedFlows.length) return;
      const flow = selectedFlows[flowIndex];
      try {
        results[flowIndex] = await exportFlow({
          flow,
          flowIndex,
          actionOutDir,
          cookie,
          limitScreens,
          reuseExisting,
          screenConcurrency,
        });
        const reused = results[flowIndex]?.reusedExisting ? "reused" : "processed";
        console.error(
          `${flowAction}: ${reused} flow ${flowIndex + 1}/${selectedFlows.length} (${flow.appName || "unknown app"} / ${
            flow.name || flow.id
          })`,
        );
      } catch (error) {
        results[flowIndex] = {
          flowId: flow.id ?? null,
          flowName: flow.name ?? null,
          appId: flow.appId ?? null,
          appName: flow.appName ?? null,
          appVersionId: flow.appVersionId ?? null,
          platform: flow.platform ?? null,
          restricted: Boolean(flow.restricted),
          screenCount: Array.isArray(flow.screens) ? flow.screens.length : 0,
          savedImageCount: 0,
          folder: join(actionOutDir, uniqueFlowFolderName(flow, flowIndex)),
          error: error.message,
          screens: [],
        };
        console.error(
          `${flowAction}: failed flow ${flowIndex + 1}/${selectedFlows.length} (${flow.appName || "unknown app"} / ${
            flow.name || flow.id
          }): ${error.message}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const screenRows = results.flatMap((result) => result.screens);
  const report = {
    generatedAt: new Date().toISOString(),
    description: crawlAppPages
      ? "authenticated Dia session cookies plus all-app /flows page crawl plus /api/screen/fetch-screen-info downloadableSrc"
      : "authenticated Dia session cookies plus /api/search/fetch-search-page-flows plus /api/screen/fetch-screen-info downloadableSrc",
    target: {
      platform,
      sortBy,
      flowAction,
      outputDirectory: actionOutDir,
    },
    pageFetch: source.pageFetch,
    advertisedFlowCount: source.advertisedFlowCount,
    exportedFlowCount: results.length,
    advertisedFlowScreenCount: selectedFlows.reduce(
      (sum, flow) => sum + (Array.isArray(flow.screens) ? flow.screens.length : 0),
      0,
    ),
    exportedScreenCount: screenRows.length,
    savedImageCount: screenRows.filter((row) => row.status === 200 && row.savedPath).length,
    uniqueSha256Count: new Set(screenRows.map((row) => row.sha256).filter(Boolean)).size,
    tinyImageCount: screenRows.filter(
      (row) => (row.dimensions?.width || 0) < 100 || (row.dimensions?.height || 0) < 100,
    ).length,
    failedFlowCount: results.filter((result) => result.error).length,
    reusedExistingFlowCount: results.filter((result) => result.reusedExisting).length,
    flows: results,
  };

  await writeFile(join(actionOutDir, "flow-export-report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(actionOutDir, "flow-export-report.csv"), toCsv(screenRows));

  actionSummaries.push({
    flowAction,
    advertisedFlowCount: report.advertisedFlowCount,
    exportedFlowCount: report.exportedFlowCount,
    exportedScreenCount: report.exportedScreenCount,
    savedImageCount: report.savedImageCount,
    uniqueSha256Count: report.uniqueSha256Count,
    tinyImageCount: report.tinyImageCount,
    failedFlowCount: report.failedFlowCount,
    reusedExistingFlowCount: report.reusedExistingFlowCount,
    outputDirectory: actionOutDir,
    reportPath: join(actionOutDir, "flow-export-report.json"),
    paginationComplete: report.pageFetch.paginationComplete,
  });
}

console.log(JSON.stringify({ actions: actionSummaries }, null, 2));

async function readExistingActionReport(actionOutDir, flowAction) {
  try {
    const report = JSON.parse(await readFile(join(actionOutDir, "flow-export-report.json"), "utf8"));
    if (
      report?.target?.flowAction === flowAction &&
      Number(report.exportedFlowCount || 0) > 0 &&
      report?.pageFetch?.paginationComplete !== false
    ) {
      return report;
    }
  } catch {
    return null;
  }
  return null;
}

function actionSummaryFromReport(report, actionOutDir) {
  return {
    flowAction: report.target?.flowAction ?? null,
    advertisedFlowCount: report.advertisedFlowCount ?? null,
    exportedFlowCount: report.exportedFlowCount ?? 0,
    exportedScreenCount: report.exportedScreenCount ?? 0,
    savedImageCount: report.savedImageCount ?? 0,
    uniqueSha256Count: report.uniqueSha256Count ?? 0,
    tinyImageCount: report.tinyImageCount ?? 0,
    failedFlowCount: report.failedFlowCount ?? 0,
    reusedExistingFlowCount: report.exportedFlowCount ?? 0,
    reusedExistingActionReport: true,
    outputDirectory: actionOutDir,
    reportPath: join(actionOutDir, "flow-export-report.json"),
    paginationComplete: report.pageFetch?.paginationComplete ?? null,
  };
}

async function exportFlow({ flow, flowIndex, actionOutDir, cookie, limitScreens, reuseExisting, screenConcurrency }) {
  const screens = Array.isArray(flow.screens) ? flow.screens : [];
  const orderedScreens = [...screens].sort((left, right) => Number(left.order ?? 0) - Number(right.order ?? 0));
  const selectedScreens = limitScreens ? orderedScreens.slice(0, limitScreens) : orderedScreens;
  const flowFolder = uniqueFlowFolderName(flow, flowIndex);
  const existingFlowDir = reuseExisting && flow.id ? await findExistingFlowDir(actionOutDir, flow.id) : null;
  const flowDir = existingFlowDir || join(actionOutDir, flowFolder);
  await mkdir(flowDir, { recursive: true });

  if (reuseExisting) {
    const existing = await readExistingCompleteFlowReport(flowDir, selectedScreens.length);
    if (existing) return { ...existing, reusedExisting: true };
  }

  const exportedScreens = [];
  let nextScreenIndex = 0;

  async function screenWorker() {
    for (;;) {
      const index = nextScreenIndex;
      nextScreenIndex += 1;
      if (index >= selectedScreens.length) return;
      const flowScreen = selectedScreens[index];
      try {
        exportedScreens[index] = await exportFlowScreen({
          flow,
          flowScreen,
          index,
          flowDir,
          cookie,
        });
      } catch (error) {
        exportedScreens[index] = {
          flowId: flow.id,
          flowName: flow.name ?? null,
          appId: flow.appId ?? null,
          appName: flow.appName ?? null,
          appVersionId: flow.appVersionId ?? null,
          order: Number(flowScreen.order ?? index + 1),
          index: index + 1,
          screenId: flowScreen.screenId || flowScreen.id || null,
          restricted: Boolean(flowScreen.restricted ?? flow.restricted),
          status: null,
          error: error.message,
          savedPath: null,
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(screenConcurrency, selectedScreens.length || 1)) }, screenWorker),
  );

  const flowReport = {
    flowId: flow.id,
    flowName: flow.name ?? null,
    appId: flow.appId ?? null,
    appName: flow.appName ?? null,
    appVersionId: flow.appVersionId ?? null,
    appVersionPublishedAt: flow.appVersionPublishedAt ?? null,
    platform: flow.platform ?? null,
    restricted: Boolean(flow.restricted),
    screenCount: selectedScreens.length,
    savedImageCount: exportedScreens.filter((screen) => screen.status === 200 && screen.savedPath).length,
    folder: flowDir,
    screens: exportedScreens,
  };

  await writeFile(join(flowDir, "flow.json"), JSON.stringify(flowReport, null, 2));
  return flowReport;
}

async function findExistingFlowDir(actionOutDir, flowId) {
  try {
    const entries = await readdir(actionOutDir, { withFileTypes: true });
    const suffix = `-${flowId}`;
    const match = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(suffix));
    return match ? join(actionOutDir, match.name) : null;
  } catch {
    return null;
  }
}

async function readExistingCompleteFlowReport(flowDir, expectedScreenCount) {
  try {
    const report = JSON.parse(await readFile(join(flowDir, "flow.json"), "utf8"));
    if (
      report &&
      report.screenCount === expectedScreenCount &&
      report.savedImageCount === expectedScreenCount &&
      Array.isArray(report.screens)
    ) {
      return report;
    }
  } catch {
    return null;
  }
  return null;
}

async function exportFlowScreen({ flow, flowScreen, index, flowDir, cookie }) {
  const screenId = flowScreen.screenId || flowScreen.id;
  if (!screenId) throw new Error(`Flow ${flow.id} has a screen without screenId at index ${index + 1}`);

  const info = await fetchScreenInfo(screenId, cookie);
  const chosen = chooseBestImageSource(info.screenCdnImgSources || flowScreen.screenCdnImgSources);
  if (!chosen?.url) throw new Error(`No downloadable image source for screen ${screenId}`);

  const imageResp = await fetch(chosen.url, {
    redirect: "follow",
    cache: "no-store",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; MobbinSidesFlowsExporter/1.0)",
      accept: "image/webp,image/png,image/jpeg,image/*,*/*",
    },
  });
  const bytes = Buffer.from(await imageResp.arrayBuffer());
  const contentType = imageResp.headers.get("content-type") || "";
  const digest = sha256(bytes);
  const dimensions = imageDimensions(bytes, contentType);
  const url = new URL(chosen.url);
  const filename = `${String(index + 1).padStart(3, "0")}-${screenId}-${sanitizeFilename(chosen.descriptor)}-${digest.slice(
    0,
    12,
  )}${extensionForContentType(contentType)}`;
  const savedPath = join(flowDir, filename);

  if (imageResp.ok && /^image\//.test(contentType)) {
    await writeFile(savedPath, bytes);
  }

  return {
    flowId: flow.id,
    flowName: flow.name ?? null,
    appId: flow.appId ?? null,
    appName: flow.appName ?? null,
    appVersionId: flow.appVersionId ?? null,
    order: Number(flowScreen.order ?? index + 1),
    index: index + 1,
    screenId,
    restricted: Boolean(flowScreen.restricted ?? flow.restricted),
    descriptor: chosen.descriptor,
    status: imageResp.status,
    contentType,
    contentLengthHeader: imageResp.headers.get("content-length"),
    bytes: bytes.length,
    sha256: digest,
    dimensions,
    declaredWidth: info.width ?? flowScreen.width ?? null,
    declaredHeight: info.height ?? flowScreen.height ?? null,
    urlHost: url.host,
    urlPathHash: sha256(Buffer.from(url.pathname)),
    savedPath: imageResp.ok && /^image\//.test(contentType) ? savedPath : null,
  };
}

async function loadSearchFlows({ platform, sortBy, flowAction, cookie, limitFlows }) {
  const searchQuery = {
    contentType: "flows",
    platform,
    type: "filters",
    activeFilterTags: [{ categorySlug: "flowActions", displayName: flowAction }],
    categories: null,
    flowActions: [flowAction],
    sortBy,
  };

  let searchRequestId = randomUUID();
  const pages = [];
  const deduped = new Map();
  let advertisedFlowCount = null;
  let stoppedOnEmptyNextPage = false;

  for (let pageIndex = 0; ; pageIndex += 1) {
    const payload = {
      searchRequestId,
      pageIndex,
      searchQuery,
    };
    const resp = await fetch("https://mobbin.com/api/search/fetch-search-page-flows", {
      method: "POST",
      cache: "no-store",
      headers: {
        cookie,
        "user-agent": "Mozilla/5.0 (compatible; MobbinSidesFlowsExporter/1.0)",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const responseJson = await resp.json();
    if (!resp.ok || responseJson.error) {
      throw new Error(
        `fetch-search-page-flows failed on page ${pageIndex}: ${resp.status} ${responseJson.error?.message || ""}`,
      );
    }

    const value = responseJson.value;
    searchRequestId = value?.searchRequestId || searchRequestId;
    advertisedFlowCount ??= value?.totalCount ?? null;
    const data = Array.isArray(value?.data) ? value.data : [];
    for (const flow of data) {
      if (flow?.id && !deduped.has(flow.id)) deduped.set(flow.id, flow);
    }

    pages.push({
      pageIndex,
      status: resp.status,
      dataCount: data.length,
      totalCount: value?.totalCount ?? null,
      hasNextPage: Boolean(value?.hasNextPage),
      dedupedCount: deduped.size,
    });
    console.error(`${flowAction}: flow page ${pageIndex}: received ${data.length}, total unique ${deduped.size}`);

    if (!value?.hasNextPage) {
      if (pageIndex > 0 && data.length === 0 && advertisedFlowCount && deduped.size < advertisedFlowCount) {
        stoppedOnEmptyNextPage = true;
      }
      break;
    }
    if (limitFlows && deduped.size >= limitFlows) break;
  }

  return {
    advertisedFlowCount,
    flows: [...deduped.values()],
    pageFetch: {
      endpoint: "https://mobbin.com/api/search/fetch-search-page-flows",
      searchQuery,
      pagesFetched: pages.length,
      pages,
      paginationComplete: !advertisedFlowCount || deduped.size >= advertisedFlowCount,
      stoppedOnEmptyNextPage,
      note:
        stoppedOnEmptyNextPage || (advertisedFlowCount && deduped.size < advertisedFlowCount)
          ? "The endpoint advertised more flow pages but returned an empty next page for the tested HTTPS pagination request."
          : null,
    },
  };
}

async function loadFlowsFromAppPages({
  platform,
  sortBy,
  flowAction,
  cookie,
  limitFlows,
  limitApps,
  appConcurrency,
  crawlAllAppVersions,
}) {
  const catalogQuery = {
    contentType: "apps",
    platform,
    type: "filters",
    activeFilterTags: [],
    categories: null,
    sortBy,
  };
  console.error(`${flowAction}: fetching app catalog for /flows crawl`);
  const apps = await fetchFilteredApps(catalogQuery, cookie, limitApps);
  console.error(`${flowAction}: app catalog contains ${apps.length} apps`);

  const appPages = [];
  const deduped = new Map();
  let nextAppIndex = 0;

  async function worker(workerIndex) {
    for (;;) {
      const index = nextAppIndex;
      nextAppIndex += 1;
      if (index >= apps.length) return;
      if (limitFlows && deduped.size >= limitFlows) return;

      const app = apps[index];
      const pageUrl = appFlowsPageUrl(app);
      try {
        const appPage = await loadAppPageFlows(pageUrl, cookie, app, flowAction);
        const crawledPages = [
          {
            appName: app.appName,
            appId: app.id,
            appVersionId: app.appVersionId,
            pageUrl,
            status: appPage.pageFetch.status,
            htmlBytes: appPage.pageFetch.htmlBytes,
            nextFlightChunks: appPage.pageFetch.nextFlightChunks,
            flowCount: appPage.flows.length,
          },
        ];

        for (const flow of appPage.flows) {
          if (limitFlows && deduped.size >= limitFlows) break;
          if (flow?.id && !deduped.has(flow.id)) deduped.set(flow.id, flow);
        }

        if (crawlAllAppVersions && !(limitFlows && deduped.size >= limitFlows)) {
          const versions = appPage.appVersions.filter((version) => version.id && version.id !== app.appVersionId);
          for (const version of versions) {
            if (limitFlows && deduped.size >= limitFlows) break;
            const versionApp = {
              ...app,
              appVersionId: version.id,
              appVersionPublishedAt: version.publishedAt ?? version.createdAt ?? null,
            };
            const versionPageUrl = appFlowsPageUrl(versionApp);
            try {
              const versionPage = await loadAppPageFlows(versionPageUrl, cookie, versionApp, flowAction);
              crawledPages.push({
                appName: app.appName,
                appId: app.id,
                appVersionId: version.id,
                pageUrl: versionPageUrl,
                status: versionPage.pageFetch.status,
                htmlBytes: versionPage.pageFetch.htmlBytes,
                nextFlightChunks: versionPage.pageFetch.nextFlightChunks,
                flowCount: versionPage.flows.length,
              });
              for (const flow of versionPage.flows) {
                if (limitFlows && deduped.size >= limitFlows) break;
                if (flow?.id && !deduped.has(flow.id)) deduped.set(flow.id, flow);
              }
            } catch (error) {
              crawledPages.push({
                appName: app.appName,
                appId: app.id,
                appVersionId: version.id,
                pageUrl: versionPageUrl,
                error: error.message,
              });
            }
          }
        }

        appPages[index] = {
          appName: app.appName,
          appId: app.id,
          appVersionId: app.appVersionId,
          pageUrl,
          flowCount: crawledPages.reduce((sum, page) => sum + Number(page.flowCount || 0), 0),
          versionPageCount: crawledPages.length,
          versionPageErrorCount: crawledPages.filter((page) => page.error).length,
          pages: crawledPages,
        };

        console.error(
          `[app ${workerIndex}] ${index + 1}/${apps.length} ${app.appName}: ${appPages[index].flowCount} ${flowAction} flows across ${appPages[index].versionPageCount} version pages, total unique ${deduped.size}`,
        );
      } catch (error) {
        appPages[index] = {
          appName: app.appName,
          appId: app.id,
          appVersionId: app.appVersionId,
          pageUrl,
          error: error.message,
        };
        console.error(`[app ${workerIndex}] ${index + 1}/${apps.length} ${app.appName}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, appConcurrency) }, (_, index) => worker(index + 1)));

  return {
    advertisedFlowCount: null,
    flows: [...deduped.values()],
    pageFetch: {
      endpoint: "authenticated app catalog plus per-app /flows pages",
      searchQuery: catalogQuery,
      discoveryMethod: crawlAllAppVersions ? "app-version-page-crawl" : "app-page-crawl",
      appCount: apps.length,
      appsFetched: appPages.filter(Boolean).length,
      appPageErrorCount: appPages.filter((page) => page?.error).length,
      appVersionPagesFetched: appPages
        .filter(Boolean)
        .reduce((sum, page) => sum + Number(page.versionPageCount || (page.error ? 0 : 1)), 0),
      appVersionPageErrorCount: appPages
        .filter(Boolean)
        .reduce((sum, page) => sum + Number(page.versionPageErrorCount || 0), 0),
      paginationComplete: !limitFlows,
      stoppedOnEmptyNextPage: false,
      pages: appPages.filter(Boolean),
      note: limitFlows ? `Stopped early at --limit-flows ${limitFlows}.` : null,
    },
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
        "user-agent": "Mozilla/5.0 (compatible; MobbinSidesFlowsExporter/1.0)",
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

async function loadAppPageFlows(pageUrl, cookieHeader, app, flowAction) {
  const { resp: pageResp, text: html } = await fetchTextWithRetry(pageUrl, {
    redirect: "follow",
    cache: "no-store",
    headers: {
      cookie: cookieHeader,
      "user-agent": "Mozilla/5.0 (compatible; MobbinSidesFlowsExporter/1.0)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!pageResp.ok) throw new Error(`Mobbin page fetch failed: ${pageResp.status} ${pageResp.statusText}`);

  const chunks = extractNextFlightChunks(html);
  const joinedFlightPayload = chunks.join("\n");
  const flows = findPartialFlows(joinedFlightPayload, app, flowAction);
  const appVersions = findAppVersions(joinedFlightPayload, app);

  return {
    flows,
    appVersions,
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

function findPartialFlows(joinedFlightPayload, app, flowAction) {
  const marker = '"partialFlows":[{';
  const candidates = [];
  let searchFrom = 0;

  for (;;) {
    const markerIndex = joinedFlightPayload.indexOf(marker, searchFrom);
    if (markerIndex < 0) break;
    const arrayStart = joinedFlightPayload.indexOf("[", markerIndex);
    try {
      const parsed = JSON.parse(extractJsonArray(joinedFlightPayload, arrayStart));
      const matching = parsed
        .filter((flow) => flowMatchesAction(flow, flowAction))
        .map((flow) => ({
          ...flow,
          appId: flow.appId ?? app.id,
          appName: flow.appName ?? app.appName,
          appVersionId: flow.appVersionId ?? app.appVersionId,
          appVersionPublishedAt: flow.appVersionPublishedAt ?? app.appVersionPublishedAt ?? null,
          platform: flow.platform ?? app.platform,
          restricted: Boolean(flow.restricted ?? app.restricted ?? app.paywalled),
        }));
      if (matching.length > 0) candidates.push(matching);
    } catch {
      // Continue looking; Next flight chunks include multiple escaped payloads.
    }
    searchFrom = markerIndex + marker.length;
  }

  const deduped = new Map();
  for (const flow of candidates.sort((left, right) => right.length - left.length).flat()) {
    if (flow?.id && !deduped.has(flow.id)) deduped.set(flow.id, flow);
  }
  return [...deduped.values()];
}

function findAppVersions(joinedFlightPayload, app) {
  const marker = '"appVersions":[{';
  const versions = new Map();
  let searchFrom = 0;

  for (;;) {
    const markerIndex = joinedFlightPayload.indexOf(marker, searchFrom);
    if (markerIndex < 0) break;
    const arrayStart = joinedFlightPayload.indexOf("[", markerIndex);
    try {
      const parsed = JSON.parse(extractJsonArray(joinedFlightPayload, arrayStart));
      for (const version of parsed) {
        if (version?.id && !versions.has(version.id)) {
          versions.set(version.id, {
            id: version.id,
            createdAt: version.createdAt ?? null,
            publishedAt: version.publishedAt ?? null,
            flowCount: version.appVersionFlowsCount?.[0]?.count ?? null,
          });
        }
      }
    } catch {
      // Continue looking; only one appVersions array is needed, but chunks may contain escaped partials.
    }
    searchFrom = markerIndex + marker.length;
  }

  if (app.appVersionId && !versions.has(app.appVersionId)) {
    versions.set(app.appVersionId, {
      id: app.appVersionId,
      createdAt: null,
      publishedAt: app.appVersionPublishedAt ?? null,
      flowCount: null,
    });
  }

  return [...versions.values()];
}

function flowMatchesAction(flow, flowAction) {
  if (!flow || typeof flow !== "object") return false;
  if (!flowAction) return true;
  const action = String(flowAction);
  if (String(flow.name || "") === action) return true;
  if (Array.isArray(flow.actions) && flow.actions.map(String).includes(action)) return true;
  if (Array.isArray(flow.flowActions) && flow.flowActions.map(String).includes(action)) return true;
  return false;
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

async function fetchScreenInfo(screenId, cookieHeader) {
  const resp = await fetch("https://mobbin.com/api/screen/fetch-screen-info", {
    method: "POST",
    cache: "no-store",
    headers: {
      cookie: cookieHeader,
      "user-agent": "Mozilla/5.0 (compatible; MobbinSidesFlowsExporter/1.0)",
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
  const tempDir = await mkdtemp(join(tmpdir(), "mobbin-sides-flows-"));
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

function uniqueFlowFolderName(flow, flowIndex) {
  const app = slugify(flow.appName || "unknown-app");
  const name = slugify(flow.name || "flow");
  return `${String(flowIndex + 1).padStart(3, "0")}-${app}-${name}-${flow.id}`;
}

function parseMobbinAppPageUrl(pageUrl) {
  const url = new URL(pageUrl);
  const match = url.pathname.match(/^\/apps\/(.+)-([a-z]+)-([0-9a-f-]{36})\/([0-9a-f-]{36})\/(?:screens|ui-elements|flows)/i);
  if (!match) throw new Error(`Could not parse Mobbin app page URL: ${pageUrl}`);
  const [, appSlug, parsedPlatform, appId, appVersionId] = match;
  return {
    id: appId,
    appName: titleFromSlug(appSlug),
    appVersionId,
    platform: parsedPlatform,
  };
}

function titleFromSlug(value) {
  return String(value)
    .split("-")
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
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

function splitList(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
    "flowId",
    "flowName",
    "appId",
    "appName",
    "appVersionId",
    "order",
    "index",
    "screenId",
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
  if (descriptor === "downloadableSrc") return 10000;
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

function appFlowsPageUrl(app) {
  return `https://mobbin.com/apps/${slugify(app.appName)}-${app.platform}-${app.id}/${app.appVersionId}/flows`;
}

function sanitizeFilename(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
