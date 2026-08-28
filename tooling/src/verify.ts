import { createHash, randomUUID } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { CatalogStore, type VersionCatalog, formatCatalogJson, itemName, scanForbiddenMedia } from "./catalog";
import type { EagleInventory, EagleItem } from "./eagle";

export interface VerifyEagle {
  preflight(): Promise<void>;
  inventory(): Promise<EagleInventory>;
  itemFilePath(item: EagleItem): string;
}

export interface VerificationFailure {
  code: string;
  message: string;
}

export interface VerificationReport {
  ok: boolean;
  failures: VerificationFailure[];
  apps: number;
  flows: number;
  references: number;
  assets: number;
}

interface VerifyOptions {
  eagle: VerifyEagle;
  store: CatalogStore;
  repositoryRoot: string;
  hashFile?: (path: string) => Promise<string>;
  allowLegacySources?: boolean;
}

export async function verify(options: VerifyOptions): Promise<VerificationReport> {
  const failures: VerificationFailure[] = [];
  const fail = (code: string, message: string): void => { failures.push({ code, message }); };
  try {
    await options.eagle.preflight();
  } catch (error) {
    fail("EAGLE_PREFLIGHT_FAILED", error instanceof Error ? error.message : "Eagle preflight failed");
    return { ok: false, failures, apps: 0, flows: 0, references: 0, assets: 0 };
  }
  const inventory = await options.eagle.inventory();
  const items = new Map(inventory.items.map((item) => [item.id, item]));
  const folders = new Map(inventory.folders.map((folder) => [folder.id, folder]));
  const versions = await options.store.readCurrentVersions();
  let flowCount = 0;
  let referenceCount = 0;
  const identities = new Set<string>();
  const checkedHashes = new Map<string, string>();
  const hashFile = options.hashFile ?? sha256File;
  for (const version of versions) {
    flowCount += version.flows.length;
    for (const flow of version.flows) {
      const appLeaf = options.store.getManagedFolder(`app-flow:${version.app.slug}:${flow.mobbinFlowId}`);
      const groupLeaf = options.store.getManagedFolder(`group-flow:${flow.group}:${version.app.slug}:${flow.mobbinFlowId}`);
      if (!appLeaf || !groupLeaf) {
        fail("MANAGED_FOLDER_MISSING", `Managed leaves are missing for ${version.app.slug}/${flow.mobbinFlowId}`);
        continue;
      }
      if (folders.get(appLeaf.eagleId)?.orderBy !== "NAME" || folders.get(groupLeaf.eagleId)?.orderBy !== "NAME") {
        fail("FOLDER_ORDER_INVALID", `Managed leaves are not name-sorted for ${version.app.slug}/${flow.mobbinFlowId}`);
      }
      for (const screen of flow.screens) {
        referenceCount += 1;
        identities.add(screen.assetIdentity);
        const item = items.get(screen.eagleItemId);
        if (!item) {
          fail("EAGLE_ITEM_MISSING", `Eagle item ${screen.eagleItemId} is missing`);
          continue;
        }
        if (item.name !== itemName(screen.position, screen.sha256)) fail("EAGLE_NAME_MISMATCH", `Eagle item ${item.id} has the wrong name`);
        if (!item.folders.includes(appLeaf.eagleId) || !item.folders.includes(groupLeaf.eagleId)) {
          fail("EAGLE_MEMBERSHIP_MISMATCH", `Eagle item ${item.id} is missing a required flow folder`);
        }
        let actualHash = checkedHashes.get(item.id);
        if (!actualHash) {
          try {
            actualHash = await hashFile(options.eagle.itemFilePath(item));
            checkedHashes.set(item.id, actualHash);
          } catch (error) {
            fail("EAGLE_FILE_UNREADABLE", `Could not read Eagle item ${item.id}: ${error instanceof Error ? error.message : "unknown error"}`);
            continue;
          }
        }
        if (actualHash !== screen.sha256) fail("EAGLE_HASH_MISMATCH", `Eagle item ${item.id} hash does not match catalog`);
      }
    }
  }
  const staging = options.store.getManagedFolder("root:staging");
  if (staging && inventory.items.some((item) => item.folders.includes(staging.eagleId))) fail("STAGING_NOT_EMPTY", "_Mobbin Staging contains items after completion");
  const state = options.store.pragmaState();
  if (state.integrity !== "ok" || !state.foreignKeys) fail("SQLITE_INTEGRITY_FAILED", `SQLite integrity is ${state.integrity}`);
  const activeCounts = options.store.counts();
  const rebuiltPath = join(options.repositoryRoot, ".mobbin", `verify-${randomUUID()}.sqlite`);
  try {
    const rebuilt = await CatalogStore.rebuild({ catalogRoot: options.store.catalogRoot, statePath: rebuiltPath });
    try {
      const rebuiltCounts = rebuilt.counts();
      if (rebuiltCounts.assets !== activeCounts.assets || rebuiltCounts.screenHashes !== activeCounts.screenHashes || rebuiltCounts.completedRuns !== activeCounts.completedRuns) {
        fail("SQLITE_REBUILD_MISMATCH", "Rebuilt SQLite counts differ from active state");
      }
    } finally {
      rebuilt.close();
    }
  } finally {
    await rm(rebuiltPath, { force: true });
    await rm(`${rebuiltPath}-shm`, { force: true });
    await rm(`${rebuiltPath}-wal`, { force: true });
  }
  for (const version of versions) await verifyCatalogFiles(options.store.catalogRoot, version, fail);
  let media = await scanForbiddenMedia(options.repositoryRoot);
  if (options.allowLegacySources) media = [];
  if (media.length > 0) fail("REPOSITORY_WEBP_FOUND", `Repository contains ${media.length} project WebPs`);
  if (!options.allowLegacySources) {
    for (const name of ["screen-flows", "grouped-flows"]) if (await pathExists(join(options.repositoryRoot, name))) fail("LEGACY_GALLERY_FOUND", `${name} still exists`);
  }
  return { ok: failures.length === 0, failures, apps: versions.length, flows: flowCount, references: referenceCount, assets: identities.size };
}

async function verifyCatalogFiles(catalogRoot: string, version: VersionCatalog, fail: (code: string, message: string) => void): Promise<void> {
  const versionPath = join(catalogRoot, "apps", version.app.slug, "versions", `${version.version.mobbinVersionId}.json`);
  const appPath = join(catalogRoot, "apps", version.app.slug, "app.json");
  for (const path of [appPath, versionPath]) {
    try {
      const text = await Bun.file(path).text();
      if (text !== formatCatalogJson(JSON.parse(text))) fail("CATALOG_FORMAT_INVALID", `${path} is not deterministically formatted`);
    } catch (error) {
      fail("CATALOG_FILE_INVALID", `${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
