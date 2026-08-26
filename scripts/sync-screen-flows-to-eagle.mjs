import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const STATE_VERSION = 1;
const execFileAsync = promisify(execFile);

export function processListHasActiveFlowExporter(processList) {
  return processList
    .split("\n")
    .some((command) => /(?:^|\/)(?:node|bun)\s+.*(?:^|\/)export-mobbin-flows\.mjs(?:\s|$)/.test(command.trim()));
}

export class EagleClient {
  constructor(baseUrl = "http://127.0.0.1:41595") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async getLibraryInfo() {
    const data = await this.request("/api/library/info");
    return data.library;
  }

  async listFolders() {
    return this.paginate("/api/v2/folder/get", { method: "GET" });
  }

  async listItems() {
    return this.paginate("/api/v2/item/get", {
      body: {
        fields: ["id", "name", "ext", "folders", "tags"],
      },
      method: "POST",
    });
  }

  async createFolder(folder) {
    return this.request("/api/v2/folder/create", { body: folder, method: "POST" });
  }

  async addItem(item) {
    return this.request("/api/v2/item/add", { body: item, method: "POST" });
  }

  async updateItem(item) {
    return this.request("/api/v2/item/update", { body: item, method: "POST" });
  }

  async moveItemsToTrash(itemIds) {
    return this.request("/api/item/moveToTrash", {
      body: { itemIds },
      method: "POST",
    });
  }

  async removeFolders(folderIds) {
    const ids = JSON.stringify(folderIds);
    const script = `(() => { const scope = angular.element("body").scope(); for (const id of ${ids}) { const folder = scope.folderMappings[id]; if (!folder || folder.imageCount > 0 || folder.children.length > 0) continue; scope.removeFolder(folder, { isDeleteImages: false, ignoreRestore: true }); } scope.$evalAsync(); })()`;
    return this.request("/api/script/inject", {
      body: { script },
      method: "POST",
    });
  }

  async paginate(path, options) {
    const items = [];
    const limit = 1000;
    for (let offset = 0; ; offset += limit) {
      const query = options.method === "GET" ? `?limit=${limit}&offset=${offset}` : "";
      const body = options.method === "POST" ? { ...options.body, limit, offset } : undefined;
      const page = await this.request(`${path}${query}`, { ...options, body });
      items.push(...page.data);
      if (items.length >= page.total || page.data.length === 0) return items;
    }
  }

  async request(path, { body, method = "GET" } = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        method,
      });
    } catch (error) {
      throw new Error(`Cannot reach Eagle at ${this.baseUrl}. Open Eagle and try again.`, { cause: error });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.status !== "success") {
      throw new Error(payload?.message || `Eagle API ${method} ${path} failed with HTTP ${response.status}`);
    }
    return payload.data;
  }
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function syncScreenFlows({
  eagle,
  hashFile = sha256File,
  libraryPath,
  log = () => {},
  sourceRoot,
  stateFile,
}) {
  const library = await eagle.getLibraryInfo();
  if (library.path !== libraryPath) {
    throw new Error(`Eagle has ${library.path} open; expected ${libraryPath}`);
  }

  const previousState = await loadState(stateFile, { libraryPath, sourceRoot });
  const sourceScan = await scanSourceFiles(sourceRoot, previousState.sourceFiles, hashFile);
  const folders = await eagle.listFolders();
  const folderIndex = indexFolders(folders);
  const folderTree = indexFolderTree(folders);
  const managedFolderIds = new Set();
  let createdFolders = 0;

  const ensureFolder = async (name, parent = null) => {
    const key = folderKey(parent, name);
    const existing = folderIndex.get(key);
    if (existing) {
      if (managedFolderIds.has(parent)) managedFolderIds.add(existing.id);
      return existing;
    }
    const created = await eagle.createFolder({ name, parent });
    folderIndex.set(key, created);
    folderTree.set(created.id, { folder: created, parent });
    if (managedFolderIds.has(parent)) managedFolderIds.add(created.id);
    createdFolders += 1;
    return created;
  };

  const flowsRoot = await ensureFolder("Flows");
  collectFolderIds(flowsRoot, managedFolderIds);
  collectFlatDescendants([...folderIndex.values()], managedFolderIds);
  const sourceGroups = new Map();
  for (const screen of sourceScan.screens) {
    const appFolder = await ensureFolder(screen.appName, flowsRoot.id);
    const flowFolder = await ensureFolder(screen.flowName, appFolder.id);
    const group = sourceGroups.get(screen.sha256) || {
      appNames: new Set(),
      folders: new Set(),
      path: screen.path,
      sha256: screen.sha256,
    };
    group.appNames.add(screen.appName);
    group.folders.add(flowFolder.id);
    sourceGroups.set(screen.sha256, group);
  }

  const existingItems = await eagle.listItems();
  const finalFoldersByItem = new Map(existingItems.map((item) => [item.id, [...(item.folders || [])]]));
  const eagleScan = await indexEagleItems(existingItems, previousState.eagleItems, libraryPath, hashFile);
  let addedItems = 0;
  const activeItemIds = new Set();
  const trashItemIds = [];
  let updatedItems = 0;

  for (const group of sourceGroups.values()) {
    const existing = eagleScan.byHash.get(group.sha256);
    const externalFolders = (existing?.folders || []).filter((folderId) => !managedFolderIds.has(folderId));
    const foldersToKeep = union(externalFolders, group.folders);
    const tagsToKeep = union(existing?.tags, ["mobbin-flow", ...group.appNames]);

    if (!existing) {
      const created = await eagle.addItem({
        folders: foldersToKeep,
        name: basename(group.path, extname(group.path)),
        path: group.path,
        tags: tagsToKeep,
      });
      const item = { ...created, folders: foldersToKeep, tags: tagsToKeep };
      eagleScan.byHash.set(group.sha256, item);
      eagleScan.state[item.id] = {
        ext: item.ext || extname(group.path).slice(1),
        folders: foldersToKeep,
        name: item.name,
        sha256: group.sha256,
        tags: tagsToKeep,
      };
      finalFoldersByItem.set(item.id, foldersToKeep);
      addedItems += 1;
      continue;
    }

    activeItemIds.add(existing.id);
    finalFoldersByItem.set(existing.id, foldersToKeep);
    if (!sameValues(existing.folders, foldersToKeep) || !sameValues(existing.tags, tagsToKeep)) {
      await eagle.updateItem({ id: existing.id, folders: foldersToKeep, tags: tagsToKeep });
      existing.folders = foldersToKeep;
      existing.tags = tagsToKeep;
      updatedItems += 1;
    }
  }

  for (const { item } of eagleScan.entries) {
    if (activeItemIds.has(item.id) || !item.tags?.includes("mobbin-flow")) continue;
    const externalFolders = (item.folders || []).filter((folderId) => !managedFolderIds.has(folderId));
    if (externalFolders.length > 0) {
      if (!sameValues(item.folders, externalFolders)) {
        await eagle.updateItem({ id: item.id, folders: externalFolders, tags: item.tags || [] });
        item.folders = externalFolders;
        finalFoldersByItem.set(item.id, externalFolders);
        updatedItems += 1;
      }
      continue;
    }
    trashItemIds.push(item.id);
    finalFoldersByItem.delete(item.id);
    delete eagleScan.state[item.id];
  }

  for (let index = 0; index < trashItemIds.length; index += 500) {
    await eagle.moveItemsToTrash(trashItemIds.slice(index, index + 500));
  }

  const keepFolderIds = new Set([flowsRoot.id]);
  for (const itemFolders of finalFoldersByItem.values()) {
    for (const folderId of itemFolders) {
      let currentId = folderId;
      while (managedFolderIds.has(currentId) && !keepFolderIds.has(currentId)) {
        keepFolderIds.add(currentId);
        currentId = folderTree.get(currentId)?.parent;
      }
    }
  }
  const removeFolderIds = [...managedFolderIds]
    .filter((folderId) => folderId !== flowsRoot.id && !keepFolderIds.has(folderId))
    .sort((left, right) => folderDepth(right, folderTree) - folderDepth(left, folderTree));
  if (removeFolderIds.length > 0) await eagle.removeFolders(removeFolderIds);

  await saveState(stateFile, {
    eagleItems: eagleScan.state,
    libraryPath,
    sourceFiles: sourceScan.state,
    sourceRoot,
    version: STATE_VERSION,
  });

  const result = {
    addedItems,
    createdFolders,
    removedFolders: removeFolderIds.length,
    sourceFiles: sourceScan.screens.length,
    trashedItems: trashItemIds.length,
    uniqueImages: sourceGroups.size,
    updatedItems,
  };
  log(result);
  return result;
}

async function scanSourceFiles(sourceRoot, previousFiles, hashFile) {
  const paths = await listWebpFiles(sourceRoot);
  const screens = [];
  const nextState = {};

  for (const path of paths) {
    const relativePath = relative(sourceRoot, path);
    const parts = relativePath.split("/");
    if (parts.length !== 3) continue;
    const fileStat = await stat(path);
    const cached = previousFiles[relativePath];
    const sha256 = cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs
      ? cached.sha256
      : await hashFile(path);
    nextState[relativePath] = { mtimeMs: fileStat.mtimeMs, sha256, size: fileStat.size };
    screens.push({
      appName: parts[0],
      flowName: parts[1],
      path,
      sha256,
    });
  }

  return { screens, state: nextState };
}

async function listWebpFiles(root) {
  const paths = [];
  for (const app of await directoryEntries(root)) {
    if (!app.isDirectory()) continue;
    const appPath = join(root, app.name);
    for (const flow of await directoryEntries(appPath)) {
      if (!flow.isDirectory()) continue;
      const flowPath = join(appPath, flow.name);
      for (const file of await directoryEntries(flowPath)) {
        if (file.isFile() && file.name.toLowerCase().endsWith(".webp")) {
          paths.push(join(flowPath, file.name));
        }
      }
    }
  }
  return paths.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

async function directoryEntries(path) {
  return readdir(path, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

async function indexEagleItems(items, previousItems, libraryPath, hashFile) {
  const byHash = new Map();
  const entries = [];
  const nextState = {};

  for (const item of items.sort((left, right) => left.id.localeCompare(right.id))) {
    const cached = previousItems[item.id];
    const itemPath = join(libraryPath, "images", `${item.id}.info`, `${item.name}.${item.ext}`);
    const fileStat = await stat(itemPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    let sha256;
    if (cached && cached.name === item.name && cached.ext === item.ext) {
      const sameFile = !fileStat || (cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs);
      if (sameFile) sha256 = cached.sha256;
    }
    if (!sha256 && fileStat) sha256 = await hashFile(itemPath);
    if (!sha256) continue;

    nextState[item.id] = {
      ext: item.ext,
      folders: item.folders || [],
      mtimeMs: fileStat?.mtimeMs,
      name: item.name,
      sha256,
      size: fileStat?.size,
      tags: item.tags || [],
    };
    entries.push({ item, sha256 });
    if (!byHash.has(sha256)) byHash.set(sha256, item);
  }

  return { byHash, entries, state: nextState };
}

function indexFolders(folders) {
  const index = new Map();
  const visit = (folder, inheritedParent = null) => {
    const parent = folder.parent ?? inheritedParent;
    index.set(folderKey(parent, folder.name), folder);
    for (const child of folder.children || []) visit(child, folder.id);
  };
  for (const folder of folders) visit(folder);
  return index;
}

function indexFolderTree(folders) {
  const index = new Map();
  const visit = (folder, inheritedParent = null) => {
    const parent = folder.parent ?? inheritedParent;
    index.set(folder.id, { folder, parent });
    for (const child of folder.children || []) visit(child, folder.id);
  };
  for (const folder of folders) visit(folder);
  return index;
}

function folderKey(parent, name) {
  return `${parent || ""}\0${name}`;
}

function collectFolderIds(folder, ids) {
  ids.add(folder.id);
  for (const child of folder.children || []) collectFolderIds(child, ids);
}

function collectFlatDescendants(folders, ids) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (ids.has(folder.parent) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
}

function folderDepth(folderId, folderTree) {
  let depth = 0;
  let currentId = folderId;
  while (folderTree.has(currentId)) {
    depth += 1;
    currentId = folderTree.get(currentId).parent;
  }
  return depth;
}

function union(current = [], additions = []) {
  return [...new Set([...current, ...additions])].sort();
}

function sameValues(left = [], right = []) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

async function loadState(stateFile, expected) {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (state.version !== STATE_VERSION) return emptyState();
    if (state.libraryPath !== expected.libraryPath || state.sourceRoot !== expected.sourceRoot) {
      throw new Error(`Sync state belongs to a different source or Eagle library: ${stateFile}`);
    }
    return {
      eagleItems: state.eagleItems || {},
      sourceFiles: state.sourceFiles || {},
    };
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw error;
  }
}

function emptyState() {
  return { eagleItems: {}, sourceFiles: {} };
}

async function saveState(stateFile, state) {
  await mkdir(dirname(stateFile), { recursive: true });
  const temporaryPath = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporaryPath, stateFile);
}

async function assertNoActiveFlowExporter() {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "command="]);
  if (processListHasActiveFlowExporter(stdout)) {
    throw new Error("A Mobbin flow export is still running. Wait for it to finish before syncing Eagle.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const sourceRoot = join(repositoryRoot, "screen-flows");
  const stateFile = join(repositoryRoot, ".eagle-sync-state.json");
  const libraryPath = join(homedir(), "Mobbin.library");

  console.log(`Syncing ${sourceRoot} to ${libraryPath}...`);
  try {
    await assertNoActiveFlowExporter();
    const result = await syncScreenFlows({
      eagle: new EagleClient(),
      libraryPath,
      sourceRoot,
      stateFile,
    });
    console.log(
      `Synced ${result.sourceFiles} screen references (${result.uniqueImages} unique): `
      + `${result.addedItems} added, ${result.updatedItems} updated, ${result.trashedItems} moved to Trash, `
      + `${result.createdFolders} folders created, ${result.removedFolders} empty folders removed.`,
    );
    console.log(`State cache: ${stateFile}`);
  } catch (error) {
    console.error(`Eagle sync failed: ${error.message}`);
    process.exitCode = 1;
  }
}
