import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CatalogStore, assetIdentity, flowGroup, formatCatalogJson, versionCatalogSchema, type VersionCatalog } from "./catalog";
import type { EagleAdapter, EagleInventory, StageAssetInput } from "./eagle";

interface PlanMigrationOptions {
  repositoryRoot: string;
  inventory: EagleInventory;
  legacyStatePath?: string;
  hashFile?: (path: string) => Promise<string>;
}

export interface MigrationAsset {
  assetIdentity: string;
  sha256: string;
  position: number;
  sourcePath: string;
  bytes: number;
  width: number;
  height: number;
  descriptor: string;
  eagleItemId: string | null;
  duplicateSourceItemId: string | null;
}

export interface MigrationScreenPlan {
  mobbinScreenId: string;
  position: number;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  descriptor: string;
  assetIdentity: string;
  eagleItemId: string | null;
}

export interface MigrationVersionPlan {
  app: { slug: string; name: string; mobbinAppId: string; platform: string };
  version: { mobbinVersionId: string; publishedAt: string | null };
  flows: Array<{
    mobbinFlowId: string;
    name: string;
    group: string;
    position: number;
    screens: MigrationScreenPlan[];
  }>;
}

export interface MigrationPlan {
  summary: {
    apps: number;
    flows: number;
    references: number;
    contentHashes: number;
    assetIdentities: number;
    reusedItems: number;
    imports: number;
    duplicates: number;
    unresolved: number;
  };
  assets: MigrationAsset[];
  versions: MigrationVersionPlan[];
  legacyFlowsRootId: string | null;
}

export interface MigrationEagle {
  claimLegacyFlowsRoot(rootId: string): Promise<void>;
  preflight(): Promise<void>;
  stageAsset(input: StageAssetInput): Promise<{ id: string }>;
  duplicateAsset(input: Omit<StageAssetInput, "sourcePath">, sourceItemId: string): Promise<{ id: string }>;
  clearLegacyFlowsDescendants(rootId: string): Promise<{ updatedItems: number; removedFolders: number }>;
  reconcile(versions: VersionCatalog[], options?: { removeObsolete?: boolean }): Promise<{
    createdFolders: number;
    updatedItems: number;
    trashedItems: number;
    removedFolders: number;
  }>;
}

export interface MigrationResult {
  completed: boolean;
  mutations: number;
  importedItems: number;
  duplicatedItems: number;
  reusedItems: number;
  createdFolders: number;
  updatedItems: number;
  trashedItems: number;
  removedFolders: number;
}

interface LegacyScreen extends Omit<MigrationScreenPlan, "assetIdentity" | "eagleItemId"> {
  sourcePath: string;
}

interface LegacyState {
  eagleItems?: Record<string, { sha256?: string; name?: string; ext?: string; folders?: string[] }>;
}

export async function planMigration(options: PlanMigrationOptions): Promise<MigrationPlan> {
  const hashFile = options.hashFile ?? sha256File;
  const sourceRoot = join(options.repositoryRoot, "screen-flows");
  const versions = new Map<string, MigrationVersionPlan>();
  const assets = new Map<string, MigrationAsset>();
  let references = 0;
  let flowCount = 0;
  let unresolved = 0;
  for (const appEntry of await directoryEntries(sourceRoot)) {
    if (!appEntry.isDirectory()) continue;
    const appRoot = join(sourceRoot, appEntry.name);
    const flowEntries = (await directoryEntries(appRoot)).filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    for (const [flowIndex, flowEntry] of flowEntries.entries()) {
      const flowRoot = join(appRoot, flowEntry.name);
      let raw: Record<string, unknown>;
      try {
        raw = record(await Bun.file(join(flowRoot, "flow.json")).json());
      } catch {
        unresolved += 1;
        continue;
      }
      const appVersionId = stringValue(raw.appVersionId, `Missing appVersionId in ${flowRoot}`);
      const existingVersion = versions.get(appEntry.name);
      if (existingVersion && existingVersion.version.mobbinVersionId !== appVersionId) throw new Error(`App ${appEntry.name} contains mixed Mobbin versions`);
      const version = existingVersion ?? {
        app: {
          slug: appEntry.name,
          name: stringValue(raw.appName, `Missing appName in ${flowRoot}`),
          mobbinAppId: stringValue(raw.appId, `Missing appId in ${flowRoot}`),
          platform: typeof raw.platform === "string" ? raw.platform : "ios",
        },
        version: {
          mobbinVersionId: appVersionId,
          publishedAt: typeof raw.appVersionPublishedAt === "string" ? raw.appVersionPublishedAt : null,
        },
        flows: [],
      } satisfies MigrationVersionPlan;
      versions.set(appEntry.name, version);
      const screens: MigrationScreenPlan[] = [];
      for (const value of Array.isArray(raw.screens) ? raw.screens : []) {
        const screen = record(value);
        const dimensions = record(screen.dimensions);
        const legacy: LegacyScreen = {
          mobbinScreenId: stringValue(screen.screenId, `Missing screenId in ${flowRoot}`),
          position: numberValue(screen.index, `Missing screen position in ${flowRoot}`),
          sha256: stringValue(screen.sha256, `Missing screen hash in ${flowRoot}`),
          bytes: numberValue(screen.bytes, `Missing screen bytes in ${flowRoot}`),
          width: numberValue(dimensions.width, `Missing screen width in ${flowRoot}`),
          height: numberValue(dimensions.height, `Missing screen height in ${flowRoot}`),
          descriptor: typeof screen.descriptor === "string" ? screen.descriptor : "downloadableSrc",
          sourcePath: join(flowRoot, basename(stringValue(screen.savedPath, `Missing savedPath in ${flowRoot}`))),
        };
        references += 1;
        try {
          if (await hashFile(legacy.sourcePath) !== legacy.sha256) {
            unresolved += 1;
            continue;
          }
        } catch {
          unresolved += 1;
          continue;
        }
        const identity = assetIdentity(legacy.sha256, legacy.position);
        if (!assets.has(identity)) assets.set(identity, { ...legacy, assetIdentity: identity, eagleItemId: null, duplicateSourceItemId: null });
        screens.push({
          mobbinScreenId: legacy.mobbinScreenId,
          position: legacy.position,
          sha256: legacy.sha256,
          bytes: legacy.bytes,
          width: legacy.width,
          height: legacy.height,
          descriptor: legacy.descriptor,
          assetIdentity: identity,
          eagleItemId: null,
        });
      }
      flowCount += 1;
      version.flows.push({
        mobbinFlowId: stringValue(raw.flowId, `Missing flowId in ${flowRoot}`),
        name: stringValue(raw.flowName, `Missing flowName in ${flowRoot}`),
        group: flowGroup(stringValue(raw.flowName, `Missing flowName in ${flowRoot}`)),
        position: leadingPosition(flowEntry.name) ?? flowIndex + 1,
        screens,
      });
    }
  }

  const state = await readLegacyState(options.legacyStatePath ?? join(options.repositoryRoot, ".eagle-sync-state.json"));
  const liveItems = new Set(options.inventory.items.map((item) => item.id));
  const availableByHash = new Map<string, Array<{ id: string; name: string }>>();
  for (const [id, item] of Object.entries(state.eagleItems ?? {})) {
    if (!item.sha256 || !liveItems.has(id)) continue;
    const values = availableByHash.get(item.sha256) ?? [];
    values.push({ id, name: item.name ?? "" });
    availableByHash.set(item.sha256, values);
  }
  const assetsByHash = Map.groupBy([...assets.values()], (asset) => asset.sha256);
  let reusedItems = 0;
  for (const [hash, hashAssets] of assetsByHash) {
    const candidates = availableByHash.get(hash) ?? [];
    if (candidates.length === 0) continue;
    const positions = new Set(hashAssets.map((asset) => asset.position));
    const candidate = candidates[0]!;
    const namedPosition = leadingPosition(candidate.name);
    const chosenPosition = namedPosition && positions.has(namedPosition) ? namedPosition : Math.min(...positions);
    const chosen = hashAssets.find((asset) => asset.position === chosenPosition)!;
    chosen.eagleItemId = candidate.id;
    for (const asset of hashAssets) if (asset !== chosen) asset.duplicateSourceItemId = candidate.id;
    reusedItems += 1;
  }
  for (const version of versions.values()) {
    for (const flow of version.flows) {
      for (const screen of flow.screens) screen.eagleItemId = assets.get(screen.assetIdentity)?.eagleItemId ?? null;
    }
  }
  const values = [...assets.values()].sort((left, right) => left.assetIdentity.localeCompare(right.assetIdentity));
  const legacyFlowsRoot = options.inventory.folders.find((folder) => folder.parent === null && folder.name === "Flows");
  return {
    summary: {
      apps: versions.size,
      flows: flowCount,
      references,
      contentHashes: new Set(values.map((asset) => asset.sha256)).size,
      assetIdentities: values.length,
      reusedItems,
      imports: values.filter((asset) => !asset.eagleItemId && !asset.duplicateSourceItemId).length,
      duplicates: values.filter((asset) => !asset.eagleItemId && asset.duplicateSourceItemId).length,
      unresolved,
    },
    assets: values,
    versions: [...versions.values()].sort((left, right) => left.app.slug.localeCompare(right.app.slug)),
    legacyFlowsRootId: legacyFlowsRoot?.id ?? null,
  };
}

export async function executeMigration(options: {
  plan: MigrationPlan;
  eagle: MigrationEagle;
  store: CatalogStore;
  now?: () => Date;
  progress?: (entry: { phase: string; current?: number; total?: number }) => void;
}): Promise<MigrationResult> {
  const complete = options.store.getCheckpoint("migration:complete");
  if (complete?.status === "completed") {
    return { completed: true, mutations: 0, importedItems: 0, duplicatedItems: 0, reusedItems: 0, createdFolders: 0, updatedItems: 0, trashedItems: 0, removedFolders: 0 };
  }
  if (options.plan.summary.unresolved > 0) throw new Error(`Migration has ${options.plan.summary.unresolved} unresolved source references`);
  if (!options.plan.legacyFlowsRootId) throw new Error("Legacy Flows root was not found in Eagle");
  const report: MigrationResult = { completed: false, mutations: 0, importedItems: 0, duplicatedItems: 0, reusedItems: 0, createdFolders: 0, updatedItems: 0, trashedItems: 0, removedFolders: 0 };
  await options.eagle.claimLegacyFlowsRoot(options.plan.legacyFlowsRootId);
  await options.eagle.preflight();
  options.store.setCheckpoint("migration:root-claimed", "completed", { eagleId: options.plan.legacyFlowsRootId });
  const assets = new Map<string, MigrationAsset>();
  for (const [index, planned] of options.plan.assets.entries()) {
    options.progress?.({ phase: "assets", current: index + 1, total: options.plan.assets.length });
    const existing = options.store.getAsset(planned.assetIdentity);
    if (existing) {
      planned.eagleItemId = existing.eagleItemId;
      assets.set(planned.assetIdentity, planned);
      continue;
    }
    if (planned.eagleItemId) {
      options.store.upsertAsset({ ...planned, eagleItemId: planned.eagleItemId, status: "staged" });
      report.reusedItems += 1;
      report.mutations += 1;
    } else if (planned.duplicateSourceItemId) {
      const item = await options.eagle.duplicateAsset(planned, planned.duplicateSourceItemId);
      planned.eagleItemId = item.id;
      report.duplicatedItems += 1;
      report.mutations += 1;
    } else {
      const item = await options.eagle.stageAsset({ ...planned, sourcePath: planned.sourcePath });
      planned.eagleItemId = item.id;
      report.importedItems += 1;
      report.mutations += 1;
    }
    assets.set(planned.assetIdentity, planned);
  }
  options.store.setCheckpoint("migration:assets-staged", "completed", { count: assets.size });
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const versions = options.plan.versions.map((planned) => versionCatalogSchema.parse({
    schemaVersion: 1,
    generatedAt,
    app: planned.app,
    version: planned.version,
    flows: planned.flows.map((flow) => ({
      ...flow,
      screens: flow.screens.map((screen) => {
        const asset = assets.get(screen.assetIdentity);
        if (!asset?.eagleItemId) throw new Error(`Asset ${screen.assetIdentity} was not staged`);
        options.store.recordScreenHash(screen.mobbinScreenId, screen);
        return { ...screen, eagleItemId: asset.eagleItemId };
      }),
    })),
  }));
  if (!options.store.getCheckpoint("migration:legacy-cleared")) {
    const cleared = await options.eagle.clearLegacyFlowsDescendants(options.plan.legacyFlowsRootId);
    report.updatedItems += cleared.updatedItems;
    report.removedFolders += cleared.removedFolders;
    report.mutations += cleared.updatedItems + cleared.removedFolders;
    options.store.setCheckpoint("migration:legacy-cleared", "completed", cleared);
  }
  const committed = await options.eagle.reconcile(versions, { removeObsolete: false });
  report.createdFolders += committed.createdFolders;
  report.updatedItems += committed.updatedItems;
  report.mutations += committed.createdFolders + committed.updatedItems;
  options.store.setCheckpoint("migration:folders-committed", "completed", committed);
  for (const version of versions) {
    await options.store.commitVersion(version);
    const planHash = createHash("sha256").update(formatCatalogJson(version)).digest("hex");
    const run = options.store.beginRun({ appSlug: version.app.slug, versionId: version.version.mobbinVersionId, planHash });
    for (const flow of version.flows) for (const screen of flow.screens) options.store.recordRunAsset(run.id, screen.assetIdentity, "committed");
    options.store.markRun(run.id, "completed");
  }
  options.store.setCheckpoint("migration:catalog-committed", "completed", { apps: versions.length });
  const cleaned = await options.eagle.reconcile(versions, { removeObsolete: true });
  report.createdFolders += cleaned.createdFolders;
  report.updatedItems += cleaned.updatedItems;
  report.trashedItems += cleaned.trashedItems;
  report.removedFolders += cleaned.removedFolders;
  report.mutations += cleaned.createdFolders + cleaned.updatedItems + cleaned.trashedItems + cleaned.removedFolders;
  options.store.setCheckpoint("migration:cleanup-complete", "completed", cleaned);
  options.store.setCheckpoint("migration:complete", "completed", { summary: options.plan.summary });
  report.completed = true;
  return report;
}

export async function backupEagleLibrary(options: {
  libraryPath: string;
  apiUrl?: string;
  now?: () => Date;
}): Promise<{ backupPath: string; imageDirectories: number; method: "clone" | "copy" }> {
  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(dirname(options.libraryPath), `${basename(options.libraryPath)}.pre-eagle-only-${stamp}`);
  if (await Bun.file(backupPath).exists()) throw new Error(`Eagle backup path already exists: ${backupPath}`);
  const sourceImages = await countDirectories(join(options.libraryPath, "images"));
  await runProcess(["osascript", "-e", "tell application \"Eagle\" to quit"]);
  await waitForProcessExit("Eagle", 60_000);
  let method: "clone" | "copy" = "clone";
  try {
    const clone = await runProcess(["cp", "-cR", options.libraryPath, backupPath], false);
    if (clone !== 0) {
      method = "copy";
      await rm(backupPath, { recursive: true, force: true });
      await runProcess(["cp", "-R", options.libraryPath, backupPath]);
    }
  } finally {
    await runProcess(["open", "-a", "Eagle", options.libraryPath]);
  }
  const metadataExists = await Bun.file(join(backupPath, "metadata.json")).exists();
  const backupImages = await countDirectories(join(backupPath, "images"));
  if (!metadataExists || backupImages !== sourceImages) throw new Error(`Eagle backup verification failed at ${backupPath}`);
  await waitForEagle(options.apiUrl ?? "http://127.0.0.1:41595", options.libraryPath, 90_000);
  return { backupPath, imageDirectories: backupImages, method };
}

export async function flattenGroupedFolders(options: {
  store: CatalogStore;
  adapter: Pick<EagleAdapter, "updateFolder" | "removeFolders" | "setFolderOrder">;
}): Promise<{ movedFolders: number; removedContainers: number }> {
  const versions = await options.store.readCurrentVersions();
  const updates: Array<{ logicalKey: string; id: string; name: string; parentId: string; parentKey: string }> = [];
  for (const version of versions) {
    for (const flow of version.flows) {
      const logicalKey = `group-flow:${flow.group}:${version.app.slug}:${flow.mobbinFlowId}`;
      const folder = options.store.getManagedFolder(logicalKey);
      const parentKey = `group:${flow.group}`;
      const parent = options.store.getManagedFolder(parentKey);
      if (!folder || !parent) throw new Error(`Missing managed group folders for ${version.app.slug}/${flow.mobbinFlowId}`);
      updates.push({ logicalKey, id: folder.eagleId, parentKey, parentId: parent.eagleId, name: `${version.app.slug} — ${String(flow.position).padStart(3, "0")} — ${flow.name}` });
    }
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const update = updates[next++];
      if (!update) return;
      await options.adapter.updateFolder({ id: update.id, name: update.name, parent: update.parentId, description: "Managed by Mobbin tooling", orderBy: "NAME" });
      options.store.upsertManagedFolder({ logicalKey: update.logicalKey, eagleId: update.id, kind: "group-flow", parentKey: update.parentKey, name: update.name });
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, Math.max(1, updates.length)) }, worker));
  await options.adapter.setFolderOrder(updates.map((update) => update.id), "NAME", true);
  const containers = options.store.listManagedFolders().filter((folder) => folder.kind === "group-app");
  if (containers.length > 0) {
    await options.adapter.removeFolders(containers.map((folder) => folder.eagleId));
    options.store.deleteManagedFolders(containers.map((folder) => folder.logicalKey));
  }
  return { movedFolders: updates.length, removedContainers: containers.length };
}

async function readLegacyState(path: string): Promise<LegacyState> {
  try {
    return record(await Bun.file(path).json()) as LegacyState;
  } catch {
    return {};
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
}

async function directoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, message: string): string {
  if (typeof value !== "string" || !value) throw new Error(message);
  return value;
}

function numberValue(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(message);
  return value;
}

function leadingPosition(value: string): number | null {
  const match = /^(\d{3})/.exec(value);
  return match ? Number(match[1]) : null;
}

async function countDirectories(path: string): Promise<number> {
  return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
}

async function runProcess(command: string[], required = true): Promise<number> {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (required && code !== 0) throw new Error(`${command[0]} failed: ${stderr.trim().slice(0, 300)}`);
  return code;
}

async function waitForProcessExit(name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const process = Bun.spawn(["pgrep", "-x", name], { stdout: "ignore", stderr: "ignore" });
    if (await process.exited !== 0) return;
    await Bun.sleep(500);
  }
  throw new Error(`${name} did not exit within ${timeoutMs}ms`);
}

async function waitForEagle(apiUrl: string, expectedPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/library/info`);
      const payload = await response.json() as { status?: string; data?: { library?: { path?: string } } };
      if (response.ok && payload.status === "success" && payload.data?.library?.path === expectedPath) return;
    } catch {}
    await Bun.sleep(1000);
  }
  throw new Error(`Eagle did not reopen ${expectedPath} within ${timeoutMs}ms`);
}
