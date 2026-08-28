import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { type AssetRecord, type CatalogStore, type VersionCatalog, itemName } from "./catalog";

const managedDescription = "Managed by Mobbin tooling";
const managedTag = "mobbin-managed";

export interface EagleFolder {
  id: string;
  name: string;
  parent: string | null;
  children: EagleFolder[];
  description: string;
  orderBy?: "NAME";
}

export interface EagleItem {
  id: string;
  name: string;
  ext: string;
  folders: string[];
  tags: string[];
  annotation: string;
}

export interface EagleInventory {
  folders: EagleFolder[];
  items: EagleItem[];
  libraryPath: string;
}

export interface EagleAdapter {
  getLibraryInfo(): Promise<{ name: string; path: string }>;
  listFolders(): Promise<EagleFolder[]>;
  listItems(): Promise<EagleItem[]>;
  createFolder(input: { name: string; parent: string | null; description: string; orderBy?: "NAME" }): Promise<EagleFolder>;
  updateFolder(input: { id: string; name: string; description: string; parent?: string | null; orderBy?: "NAME" }): Promise<void>;
  setFolderOrder(ids: string[], orderBy: "NAME", sortIncrease: boolean): Promise<void>;
  addItem(input: { path: string; name: string; folders: string[]; tags: string[]; annotation: string }): Promise<EagleItem>;
  duplicateItem(sourceId: string): Promise<EagleItem>;
  updateItem(input: { id: string; name?: string; folders: string[]; tags: string[]; annotation?: string }): Promise<void>;
  updateItems(inputs: Array<{ id: string; name?: string; folders: string[]; tags: string[]; annotation?: string }>): Promise<void>;
  moveItemsToTrash(ids: string[]): Promise<void>;
  removeFolders(ids: string[]): Promise<void>;
}

export interface StageAssetInput {
  assetIdentity: string;
  sha256: string;
  position: number;
  sourcePath: string;
  bytes: number;
  width: number;
  height: number;
  descriptor: string;
}

interface EagleLibraryOptions {
  adapter: EagleAdapter;
  expectedLibraryPath: string;
  store: CatalogStore;
  verifyFilesystem?: boolean;
}

export class EagleLibrary {
  private folders = new Map<string, EagleFolder>();
  private items = new Map<string, EagleItem>();
  private readonly staging = new Map<string, Promise<EagleItem>>();
  private itemCreationQueue: Promise<void> = Promise.resolve();
  private readonly verifyFilesystem: boolean;

  constructor(private readonly options: EagleLibraryOptions) {
    this.verifyFilesystem = options.verifyFilesystem ?? true;
  }

  async preflight(): Promise<void> {
    const library = await this.options.adapter.getLibraryInfo();
    if (library.path !== this.options.expectedLibraryPath) throw new Error(`Eagle has ${library.path} open; expected ${this.options.expectedLibraryPath}`);
    if (this.verifyFilesystem) {
      await access(join(this.options.expectedLibraryPath, "metadata.json"), constants.R_OK | constants.W_OK);
    }
    await this.refresh();
    for (const [logicalKey, name] of [["root:apps", "Apps"], ["root:flows", "Flows"], ["root:staging", "_Mobbin Staging"]] as const) {
      const owned = this.options.store.getManagedFolder(logicalKey);
      const matching = [...this.folders.values()].find((folder) => folder.parent === null && folder.name === name);
      if (matching && (!owned || owned.eagleId !== matching.id)) throw new Error(`Eagle root ${name} is unowned; migration mapping is required`);
      if (owned && (!this.folders.has(owned.eagleId) || this.folders.get(owned.eagleId)?.name !== name)) {
        throw new Error(`Managed Eagle root ${name} is missing or changed`);
      }
    }
  }

  async inventory(): Promise<EagleInventory> {
    const library = await this.options.adapter.getLibraryInfo();
    const folders = flattenFolders(await this.options.adapter.listFolders());
    const items = await this.options.adapter.listItems();
    return { folders, items, libraryPath: library.path };
  }

  hasItem(itemId: string): boolean {
    return this.items.has(itemId);
  }

  itemFilePath(item: EagleItem): string {
    const root = resolve(this.options.expectedLibraryPath, "images");
    const path = resolve(root, `${item.id}.info`, `${item.name}.${item.ext}`);
    if (path !== root && !path.startsWith(`${root}/`)) throw new Error(`Eagle item path escapes the library: ${item.id}`);
    return path;
  }

  async claimLegacyFlowsRoot(rootId: string): Promise<void> {
    const inventory = await this.inventory();
    const root = inventory.folders.find((folder) => folder.id === rootId && folder.parent === null && folder.name === "Flows");
    if (!root) throw new Error(`Legacy Flows root ${rootId} is missing`);
    const existing = this.options.store.getManagedFolder("root:flows");
    if (existing && existing.eagleId !== rootId) throw new Error(`A different Flows root is already managed`);
    this.options.store.upsertManagedFolder({ logicalKey: "root:flows", eagleId: rootId, kind: "root", parentKey: null, name: "Flows" });
  }

  async clearLegacyFlowsDescendants(rootId: string): Promise<{ updatedItems: number; removedFolders: number }> {
    const inventory = await this.inventory();
    const descendants = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of inventory.folders) {
        if ((folder.parent === rootId || descendants.has(folder.parent ?? "")) && !descendants.has(folder.id)) {
          descendants.add(folder.id);
          changed = true;
        }
      }
    }
    let updatedItems = 0;
    for (const item of inventory.items) {
      const folders = item.folders.filter((folder) => !descendants.has(folder));
      if (!sameValues(item.folders, folders)) {
        await this.options.adapter.updateItem({ id: item.id, folders, tags: item.tags, annotation: item.annotation });
        updatedItems += 1;
      }
    }
    const removal = [...descendants].sort((left, right) => folderDepth(right, inventory.folders) - folderDepth(left, inventory.folders));
    if (removal.length > 0) await this.options.adapter.removeFolders(removal);
    await this.refresh();
    return { updatedItems, removedFolders: removal.length };
  }

  async stageAsset(input: StageAssetInput): Promise<EagleItem> {
    const pending = this.staging.get(input.assetIdentity);
    if (pending) return pending;
    const operation = this.itemCreationQueue.then(() => this.stageAssetOnce(input)).finally(() => this.staging.delete(input.assetIdentity));
    this.itemCreationQueue = operation.then(() => undefined, () => undefined);
    this.staging.set(input.assetIdentity, operation);
    return operation;
  }

  async duplicateAsset(input: Omit<StageAssetInput, "sourcePath">, sourceItemId: string): Promise<EagleItem> {
    const pending = this.staging.get(input.assetIdentity);
    if (pending) return pending;
    const operation = this.itemCreationQueue.then(() => this.duplicateAssetOnce(input, sourceItemId)).finally(() => this.staging.delete(input.assetIdentity));
    this.itemCreationQueue = operation.then(() => undefined, () => undefined);
    this.staging.set(input.assetIdentity, operation);
    return operation;
  }

  private async duplicateAssetOnce(input: Omit<StageAssetInput, "sourcePath">, sourceItemId: string): Promise<EagleItem> {
    const existing = this.options.store.getAsset(input.assetIdentity);
    if (existing) {
      await this.refreshUntilItems([existing.eagleItemId]);
      return this.items.get(existing.eagleItemId)!;
    }
    if (!this.hasItem(sourceItemId)) throw new Error(`Eagle source item ${sourceItemId} is missing`);
    const staging = await this.ensureFolder("root:staging", "root", "_Mobbin Staging", null, false);
    const duplicated = await this.options.adapter.duplicateItem(sourceItemId);
    const name = itemName(input.position, input.sha256);
    const annotation = `Mobbin asset ${input.assetIdentity}`;
    await this.options.adapter.updateItem({ id: duplicated.id, name, folders: [staging.id], tags: [managedTag], annotation });
    await this.refreshUntilItems([duplicated.id]);
    const item = { ...duplicated, name, folders: [staging.id], tags: [managedTag], annotation };
    this.options.store.upsertAsset({ ...input, eagleItemId: item.id, status: "staged" });
    this.items.set(item.id, item);
    return item;
  }

  private async stageAssetOnce(input: StageAssetInput): Promise<EagleItem> {
    const existing = this.options.store.getAsset(input.assetIdentity);
    if (existing) {
      await this.refreshUntilItems([existing.eagleItemId]);
      const item = this.items.get(existing.eagleItemId);
      if (!item) throw new Error(`Staged Eagle item ${existing.eagleItemId} is missing`);
      return item;
    }
    const source = this.options.store.listAssets()
      .filter((asset) => asset.sha256 === input.sha256 && this.hasItem(asset.eagleItemId))
      .sort((left, right) => Number(right.status === "committed") - Number(left.status === "committed"))[0];
    if (source) {
      const { sourcePath: _, ...duplicateInput } = input;
      return this.duplicateAssetOnce(duplicateInput, source.eagleItemId);
    }
    const staging = await this.ensureFolder("root:staging", "root", "_Mobbin Staging", null, false);
    const created = await this.options.adapter.addItem({
      path: input.sourcePath,
      name: itemName(input.position, input.sha256),
      folders: [staging.id],
      tags: [managedTag],
      annotation: `Mobbin asset ${input.assetIdentity}`,
    });
    await this.refreshUntilItems([created.id]);
    const asset: AssetRecord = {
      assetIdentity: input.assetIdentity,
      sha256: input.sha256,
      position: input.position,
      eagleItemId: created.id,
      status: "staged",
      bytes: input.bytes,
      width: input.width,
      height: input.height,
      descriptor: input.descriptor,
    };
    this.options.store.upsertAsset(asset);
    this.items.set(created.id, created);
    return created;
  }

  async reconcile(versions: VersionCatalog[], options: { removeObsolete?: boolean } = {}): Promise<{ createdFolders: number; updatedItems: number; trashedItems: number; removedFolders: number }> {
    await this.refresh();
    let createdFolders = 0;
    const keepLogicalKeys = new Set<string>();
    const ensure = async (logicalKey: string, kind: string, name: string, parentKey: string | null, leaf: boolean): Promise<EagleFolder> => {
      keepLogicalKeys.add(logicalKey);
      const before = this.options.store.getManagedFolder(logicalKey);
      const folder = await this.ensureFolder(logicalKey, kind, name, parentKey, leaf);
      if (!before) createdFolders += 1;
      return folder;
    };
    const appsRoot = await ensure("root:apps", "root", "Apps", null, false);
    const flowsRoot = await ensure("root:flows", "root", "Flows", null, false);
    await ensure("root:staging", "root", "_Mobbin Staging", null, false);
    const desired = new Map<string, Set<string>>();
    const desiredNames = new Map<string, string>();
    const leafFolderIds = new Set<string>();
    for (const version of versions) {
      const appKey = `app:${version.app.slug}`;
      const appFolder = await ensure(appKey, "app", version.app.slug, "root:apps", false);
      for (const flow of version.flows) {
        const leafName = `${String(flow.position).padStart(3, "0")} — ${flow.name}`;
        const appLeaf = await ensure(`app-flow:${version.app.slug}:${flow.mobbinFlowId}`, "app-flow", leafName, appKey, true);
        const groupKey = `group:${flow.group}`;
        const groupFolder = await ensure(groupKey, "group", flow.group, "root:flows", false);
        const groupLeafName = `${version.app.slug} — ${leafName}`;
        const groupLeaf = await ensure(`group-flow:${flow.group}:${version.app.slug}:${flow.mobbinFlowId}`, "group-flow", groupLeafName, groupKey, true);
        leafFolderIds.add(appLeaf.id);
        leafFolderIds.add(groupLeaf.id);
        void appsRoot;
        void flowsRoot;
        void appFolder;
        void groupFolder;
        for (const screen of flow.screens) {
          const folders = desired.get(screen.eagleItemId) ?? new Set<string>();
          folders.add(appLeaf.id);
          folders.add(groupLeaf.id);
          desired.set(screen.eagleItemId, folders);
          desiredNames.set(screen.eagleItemId, itemName(screen.position, screen.sha256));
        }
      }
    }
    if (leafFolderIds.size > 0) {
      await this.options.adapter.setFolderOrder([...leafFolderIds], "NAME", true);
      for (const id of leafFolderIds) Object.assign(this.folders.get(id) ?? {}, { orderBy: "NAME" as const });
    }
    await this.refreshUntilItems([...desired.keys()]);
    const managedIds = new Set(this.options.store.listManagedFolders().map((folder) => folder.eagleId));
    let updatedItems = 0;
    const desiredUpdates: Array<{ id: string; name?: string; folders: string[]; tags: string[]; annotation?: string }> = [];
    for (const [itemId, folders] of desired) {
      const item = this.items.get(itemId);
      if (!item) throw new Error(`Desired Eagle item ${itemId} is missing`);
      const external = item.folders.filter((folder) => this.folders.has(folder) && !managedIds.has(folder));
      const nextFolders = union(external, folders);
      const nextName = desiredNames.get(itemId)!;
      const nextTags = union(item.tags.filter((tag) => tag !== "mobbin-flow"), [managedTag]);
      if (item.name !== nextName || !sameValues(item.folders, nextFolders) || !sameValues(item.tags, nextTags)) {
        desiredUpdates.push({ id: item.id, name: nextName, folders: nextFolders, tags: nextTags, annotation: item.annotation || `Mobbin asset` });
        item.name = nextName;
        item.folders = nextFolders;
        item.tags = nextTags;
        updatedItems += 1;
      }
      const asset = this.options.store.listAssets().find((candidate) => candidate.eagleItemId === itemId);
      if (asset?.status === "staged") this.options.store.upsertAsset({ ...asset, status: "committed" });
    }
    if (desiredUpdates.length > 0) await this.options.adapter.updateItems(desiredUpdates);
    const trash: string[] = [];
    if (options.removeObsolete === false) return { createdFolders, updatedItems, trashedItems: 0, removedFolders: 0 };
    const obsoleteUpdates: Array<{ id: string; folders: string[]; tags: string[]; annotation?: string }> = [];
    for (const item of this.items.values()) {
      if (desired.has(item.id) || (!item.tags.includes(managedTag) && !item.tags.includes("mobbin-flow"))) continue;
      const external = item.folders.filter((folder) => this.folders.has(folder) && !managedIds.has(folder));
      if (external.length > 0) {
        if (!sameValues(item.folders, external)) {
          obsoleteUpdates.push({ id: item.id, folders: external, tags: item.tags, annotation: item.annotation });
          item.folders = external;
          updatedItems += 1;
        }
      } else {
        trash.push(item.id);
      }
    }
    if (obsoleteUpdates.length > 0) await this.options.adapter.updateItems(obsoleteUpdates);
    for (let index = 0; index < trash.length; index += 500) await this.options.adapter.moveItemsToTrash(trash.slice(index, index + 500));
    const stale = this.options.store.listManagedFolders()
      .filter((folder) => !keepLogicalKeys.has(folder.logicalKey))
      .sort((left, right) => folderRank(right.kind) - folderRank(left.kind));
    if (stale.length > 0) {
      await this.options.adapter.removeFolders(stale.map((folder) => folder.eagleId));
      this.options.store.deleteManagedFolders(stale.map((folder) => folder.logicalKey));
    }
    return { createdFolders, updatedItems, trashedItems: trash.length, removedFolders: stale.length };
  }

  private async ensureFolder(logicalKey: string, kind: string, name: string, parentKey: string | null, leaf: boolean): Promise<EagleFolder> {
    const owned = this.options.store.getManagedFolder(logicalKey);
    const parentId = parentKey ? this.options.store.getManagedFolder(parentKey)?.eagleId ?? null : null;
    if (parentKey && !parentId) throw new Error(`Managed parent ${parentKey} is missing`);
    if (owned) {
      const folder = this.folders.get(owned.eagleId);
      if (!folder) throw new Error(`Managed folder ${logicalKey} is missing from Eagle`);
      if (folder.name !== name || folder.parent !== parentId || folder.description !== managedDescription || (leaf && folder.orderBy !== "NAME")) {
        await this.options.adapter.updateFolder({ id: folder.id, name, parent: parentId, description: managedDescription, orderBy: leaf ? "NAME" : undefined });
        Object.assign(folder, { name, parent: parentId, description: managedDescription, orderBy: leaf ? "NAME" : folder.orderBy });
      }
      return folder;
    }
    const collision = [...this.folders.values()].find((folder) => folder.parent === parentId && folder.name === name);
    if (collision) throw new Error(`Eagle folder ${name} is unowned; migration mapping is required`);
    const created = await this.options.adapter.createFolder({ name, parent: parentId, description: managedDescription, orderBy: leaf ? "NAME" : undefined });
    this.folders.set(created.id, created);
    this.options.store.upsertManagedFolder({ logicalKey, eagleId: created.id, kind, parentKey, name });
    return created;
  }

  private async refresh(): Promise<void> {
    const folders = flattenFolders(await this.options.adapter.listFolders());
    this.folders = new Map(folders.map((folder) => [folder.id, folder]));
    const items = await this.options.adapter.listItems();
    this.items = new Map(items.map((item) => [item.id, item]));
  }

  private async refreshUntilItems(ids: string[], timeoutMs = 30_000): Promise<void> {
    const pending = new Set(ids);
    const deadline = Date.now() + timeoutMs;
    do {
      await this.refresh();
      for (const id of pending) if (this.items.has(id)) pending.delete(id);
      if (pending.size === 0) return;
      await Bun.sleep(500);
    } while (Date.now() < deadline);
    throw new Error(`Eagle did not index items: ${[...pending].slice(0, 10).join(", ")}`);
  }
}

function flattenFolders(folders: EagleFolder[], inheritedParent: string | null = null): EagleFolder[] {
  const result: EagleFolder[] = [];
  for (const folder of folders) {
    const parent = folder.parent ?? inheritedParent;
    const normalized = { ...folder, parent };
    result.push(normalized);
    result.push(...flattenFolders(folder.children ?? [], folder.id));
  }
  return result;
}

function union(left: Iterable<string>, right: Iterable<string>): string[] {
  return [...new Set([...left, ...right])].sort();
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function folderRank(kind: string): number {
  if (kind === "app-flow" || kind === "group-flow") return 3;
  if (kind === "group-app") return 2;
  if (kind === "app" || kind === "group") return 1;
  return 0;
}

function folderDepth(folderId: string, folders: EagleFolder[]): number {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let depth = 0;
  let current = byId.get(folderId);
  while (current) {
    depth += 1;
    current = current.parent ? byId.get(current.parent) : undefined;
  }
  return depth;
}
