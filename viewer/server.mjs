#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import http from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");
const exportRoot = resolve(process.env.MOBBIN_EXPORT_ROOT || "/Users/user/mobbin-sides/flows");
const port = Number(process.env.PORT || 5177);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/catalog") return sendJson(res, await buildCatalog());
    if (url.pathname === "/api/flow") return sendJson(res, await loadFlow(url));
    if (url.pathname.startsWith("/assets/")) return serveAsset(url, res);
    return serveStatic(url.pathname, res);
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, { error: error.message || "Internal error" }, status);
  }
});

server.listen(port, () => {
  console.log(`Mobbin Sides Viewer: http://localhost:${port}`);
  console.log(`Export root: ${exportRoot}`);
});

async function buildCatalog() {
  const actionEntries = await safeReaddir(exportRoot);
  const actions = [];
  let totalFlows = 0;
  let totalScreens = 0;
  let totalSavedImages = 0;
  let completeActionReports = 0;

  for (const actionEntry of actionEntries.filter((entry) => entry.isDirectory())) {
    const actionSlug = actionEntry.name;
    const actionDir = join(exportRoot, actionSlug);
    const report = await readJson(join(actionDir, "flow-export-report.json"));
    const flowEntries = await safeReaddir(actionDir);
    const flows = [];

    for (const flowEntry of flowEntries.filter((entry) => entry.isDirectory())) {
      const flowDir = join(actionDir, flowEntry.name);
      const flow = await readJson(join(flowDir, "flow.json"));
      if (!flow) {
        flows.push({
          actionSlug,
          folder: flowEntry.name,
          title: unslug(flowEntry.name.replace(/^\d+-/, "")),
          appName: "In progress",
          flowName: "In progress",
          screenCount: 0,
          savedImageCount: 0,
          complete: false,
          thumbnails: await findImageAssetUrls(flowDir, 3),
        });
        continue;
      }

      const thumbnails = flow.screens
        ?.filter((screen) => screen?.savedPath)
        .slice(0, 4)
        .map((screen) => assetUrlForPath(screen.savedPath))
        .filter(Boolean);

      flows.push({
        actionSlug,
        folder: flowEntry.name,
        flowId: flow.flowId,
        appId: flow.appId,
        appName: flow.appName || "Unknown app",
        flowName: flow.flowName || "Untitled flow",
        title: `${flow.flowName || "Untitled flow"} in ${flow.appName || "Unknown app"}`,
        platform: flow.platform,
        restricted: Boolean(flow.restricted),
        screenCount: Number(flow.screenCount || flow.screens?.length || 0),
        savedImageCount: Number(flow.savedImageCount || 0),
        complete: Number(flow.savedImageCount || 0) === Number(flow.screenCount || flow.screens?.length || 0),
        thumbnails: thumbnails?.length ? thumbnails : await findImageAssetUrls(flowDir, 4),
      });
    }

    flows.sort((left, right) => left.folder.localeCompare(right.folder, undefined, { numeric: true }));
    totalFlows += flows.length;
    totalScreens += flows.reduce((sum, flow) => sum + flow.screenCount, 0);
    totalSavedImages += flows.reduce((sum, flow) => sum + flow.savedImageCount, 0);
    if (report) completeActionReports += 1;

    actions.push({
      actionSlug,
      actionName: report?.target?.flowAction || unslug(actionSlug),
      reportComplete: Boolean(report),
      advertisedFlowCount: report?.advertisedFlowCount ?? null,
      exportedFlowCount: report?.exportedFlowCount ?? flows.length,
      savedImageCount: report?.savedImageCount ?? flows.reduce((sum, flow) => sum + flow.savedImageCount, 0),
      tinyImageCount: report?.tinyImageCount ?? null,
      paginationComplete: report?.pageFetch?.paginationComplete ?? null,
      stoppedOnEmptyNextPage: report?.pageFetch?.stoppedOnEmptyNextPage ?? null,
      flows,
    });
  }

  actions.sort((left, right) => left.actionName.localeCompare(right.actionName));

  return {
    generatedAt: new Date().toISOString(),
    exportRoot,
    actionCount: actions.length,
    completeActionReports,
    totalFlows,
    totalScreens,
    totalSavedImages,
    actions,
  };
}

async function loadFlow(url) {
  const action = requiredParam(url, "action");
  const folder = requiredParam(url, "folder");
  const flowDir = safeJoin(exportRoot, action, folder);
  const flow = await readJson(join(flowDir, "flow.json"));
  if (!flow) throw httpError(404, `No flow.json found for ${action}/${folder}`);

  return {
    ...flow,
    actionSlug: action,
    folder,
    screens: (flow.screens || []).map((screen) => ({
      ...screen,
      assetUrl: screen.savedPath ? assetUrlForPath(screen.savedPath) : null,
    })),
  };
}

async function serveStatic(pathname, res) {
  const cleanPath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = safeJoin(publicDir, cleanPath);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) return serveStatic("/index.html", res);
  streamFile(res, filePath);
}

async function serveAsset(url, res) {
  const relPath = decodeURIComponent(url.pathname.slice("/assets/".length));
  const filePath = safeJoin(exportRoot, relPath);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) throw httpError(404, "Asset not found");
  streamFile(res, filePath);
}

function streamFile(res, filePath) {
  res.writeHead(200, {
    "content-type": contentType(filePath),
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function requiredParam(url, name) {
  const value = url.searchParams.get(name);
  if (!value) throw httpError(400, `Missing query parameter: ${name}`);
  return value;
}

function assetUrlForPath(pathname) {
  if (!pathname) return null;
  const absolute = resolve(pathname);
  const rel = relative(exportRoot, absolute);
  if (rel.startsWith("..") || rel === "" || rel.split(sep).includes("..")) return null;
  return `/assets/${rel.split(sep).map(encodeURIComponent).join("/")}`;
}

async function findImageAssetUrls(dir, limit) {
  const entries = await safeReaddir(dir);
  return entries
    .filter((entry) => entry.isFile() && /\.(webp|png|jpe?g)$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
    .slice(0, limit)
    .map((entry) => assetUrlForPath(join(dir, entry.name)))
    .filter(Boolean);
}

async function safeReaddir(dir) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeJoin(root, ...parts) {
  const fullPath = resolve(root, ...parts);
  const rel = relative(root, fullPath);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) throw httpError(403, "Path escapes export root");
  return fullPath;
}

function contentType(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".jsx":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".webp":
      return "image/webp";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function unslug(value) {
  return String(value || "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
