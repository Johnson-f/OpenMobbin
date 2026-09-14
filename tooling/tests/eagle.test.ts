import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogStore, versionCatalogSchema } from "../src/catalog";
import { EagleLibrary, type EagleAdapter, type EagleFolder, type EagleItem } from "../src/eagle";
import { scrape } from "../src/scrape";
import { parseAppPageHtml, parseMobbinAppUrl } from "../src/local/mobbin-page";

describe("Eagle module", () => {
  test("imports and updates Luma Web beside iOS without replacing its catalog or images", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobbin-eagle-platforms-"));
    const store = await CatalogStore.open({ catalogRoot: join(root, "catalog"), statePath: join(root, "state.sqlite") });
    const adapter = new FakeEagle(join(root, "Mobbin.library"));
    const eagle = new EagleLibrary({ adapter, expectedLibraryPath: adapter.libraryPath, store, verifyFilesystem: false });
    const v1 = "11111111-1111-1111-1111-111111111111";
    const v2 = "22222222-2222-2222-2222-222222222222";
    const iosUrl = `https://mobbin.com/apps/luma-ios-33333333-3333-3333-3333-333333333333/${v1}/flows`;
    const webUrl = `https://mobbin.com/apps/luma-web-44444444-4444-4444-4444-444444444444/${v1}/flows`;
    const mobbin = {
      async preflight() {},
      async discover(url: string) {
        const app = parseMobbinAppUrl(url);
        const screenId = app.platform === "ios" ? "a" : app.versionId === v1 ? "b" : "c";
        const data = { partialFlows: [{ id: `flow-${screenId}`, name: "Onboarding", screens: [{ screenId, order: 1 }] }] };
        const html = `<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify(data)])})</script>`;
        return parseAppPageHtml(html, app);
      },
      async fetchScreen(id: string) {
        return { path: join(root, "screen.webp"), metadata: { mobbinScreenId: id, sha256: id.repeat(64), bytes: 6, width: 3024, height: 2010, contentType: "image/webp" as const, descriptor: "downloadableSrc" }, async dispose() {} };
      },
    };
    try {
      await scrape(iosUrl, { eagle, mobbin, store });
      const iosBefore = await store.readApp("luma");
      const iosItemId = adapter.items[0]!.id;
      const web = await scrape(webUrl, { eagle, mobbin, store });
      expect(web.app).toBe("luma-web");
      const oldWebId = adapter.items.find((item) => item.id !== iosItemId)!.id;
      const webLeaf = adapter.folderPath(["Apps", "luma-web", "001 — Onboarding"]);
      const groupLeaf = adapter.folderPath(["Flows", "onboarding", "luma-web — 001 — Onboarding"]);
      expect(adapter.item(oldWebId).folders.sort()).toEqual([webLeaf.id, groupLeaf.id].sort());
      const updated = await scrape(webUrl.replace(v1, v2), { eagle, mobbin, store });
      expect(updated.trashedItems).toBe(1);
      expect(adapter.trashCalls.flat()).toEqual([oldWebId]);
      expect(await store.readApp("luma")).toEqual(iosBefore);
      expect(adapter.item(iosItemId).folders).toContain(adapter.folderPath(["Apps", "luma", "001 — Onboarding"]).id);
      expect(await store.readApp("luma-web")).toMatchObject({ platform: "web", currentVersionId: v2, versionIds: [v1, v2] });
      expect(await scrape(webUrl.replace(v1, v2), { eagle, mobbin, store })).toMatchObject({ fetched: 0, staged: 0, updatedItems: 0, trashedItems: 0 });
      expect((await store.readCurrentVersions()).map((version) => version.app.slug)).toEqual(["luma", "luma-web"]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reuses managed flow folders when a new version changes flow IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobbin-eagle-version-"));
    const store = await CatalogStore.open({ catalogRoot: join(root, "catalog"), statePath: join(root, "state.sqlite") });
    const adapter = new FakeEagle(join(root, "Mobbin.library"));
    const eagle = new EagleLibrary({ adapter, expectedLibraryPath: adapter.libraryPath, store, verifyFilesystem: false });
    try {
      const first = await eagle.stageAsset(asset("a".repeat(64), 1, join(root, "screen.webp")));
      const second = await eagle.duplicateAsset(duplicateAsset("a".repeat(64), 2), first.id);
      await eagle.reconcile([version(first.id, second.id)]);
      const oldAppLeaf = adapter.folderPath(["Apps", "luma", "001 — Onboarding"]).id;
      const oldGroupLeaf = adapter.folderPath(["Flows", "onboarding", "luma — 001 — Onboarding"]).id;
      const updated = versionWithoutFirst(second.id);
      updated.version.mobbinVersionId = "version-2";
      updated.flows[0]!.mobbinFlowId = "new-flow-1";
      const result = await eagle.reconcile([updated], { removeObsolete: false });
      expect(result.createdFolders).toBe(0);
      expect(adapter.item(first.id)).toBeDefined();
      expect(store.getManagedFolder("app-flow:luma:new-flow-1")?.eagleId).toBe(oldAppLeaf);
      expect(store.getManagedFolder("group-flow:onboarding:luma:new-flow-1")?.eagleId).toBe(oldGroupLeaf);
      expect(store.getManagedFolder("app-flow:luma:flow-1")).toBeNull();
      const cleanup = await eagle.reconcile([updated]);
      expect(cleanup).toMatchObject({ createdFolders: 0, trashedItems: 1, removedFolders: 0 });
      expect(adapter.item(second.id).folders.sort()).toEqual([oldAppLeaf, oldGroupLeaf].sort());
      expect(await eagle.reconcile([updated])).toMatchObject({ createdFolders: 0, updatedItems: 0, trashedItems: 0, removedFolders: 0 });
      const unowned = adapter.addExternalFolder("002 — Settings");
      unowned.parent = adapter.folderPath(["Apps", "luma"]).id;
      updated.flows.push({ ...updated.flows[0]!, position: 2, name: "Settings", group: "settings", mobbinFlowId: "new-flow-2" });
      await expect(eagle.reconcile([updated])).rejects.toThrow("unowned");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stages exact identities and reconciles both views while preserving external links", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobbin-eagle-module-"));
    const store = await CatalogStore.open({ catalogRoot: join(root, "catalog"), statePath: join(root, "state.sqlite") });
    const adapter = new FakeEagle(join(root, "Mobbin.library"));
    const eagle = new EagleLibrary({ adapter, expectedLibraryPath: adapter.libraryPath, store, verifyFilesystem: false });
    const source = join(root, "screen.webp");
    await writeFile(source, "screen");
    const hash = "a".repeat(64);
    try {
      await eagle.preflight();
      const first = await eagle.stageAsset(asset(hash, 1, source));
      expect((await eagle.stageAsset(asset(hash, 1, source))).id).toBe(first.id);
      const second = await eagle.duplicateAsset(duplicateAsset(hash, 2), first.id);
      expect(adapter.addCalls).toHaveLength(1);
      expect(adapter.duplicateCalls).toHaveLength(1);
      const external = adapter.addExternalFolder("Favorites");
      adapter.item(first.id).folders.push(external.id);

      const result = await eagle.reconcile([version(first.id, second.id)]);

      expect(result).toMatchObject({ createdFolders: 6, updatedItems: 2, trashedItems: 0 });
      const appsFlow = adapter.folderPath(["Apps", "luma", "001 — Onboarding"]);
      const groupedFlow = adapter.folderPath(["Flows", "onboarding", "luma — 001 — Onboarding"]);
      expect(appsFlow.orderBy).toBe("NAME");
      expect(groupedFlow.orderBy).toBe("NAME");
      expect(adapter.item(first.id).name).toBe("001 — aaaaaaaaaaaa");
      expect(adapter.item(first.id).folders.sort()).toEqual([external.id, appsFlow.id, groupedFlow.id].sort());
      expect(adapter.item(second.id).folders.sort()).toEqual([appsFlow.id, groupedFlow.id].sort());

      await eagle.reconcile([versionWithoutFirst(second.id)]);
      expect(adapter.item(first.id).folders).toEqual([external.id]);
      adapter.item(first.id).folders = [];
      await eagle.reconcile([versionWithoutFirst(second.id)]);
      expect(adapter.trashCalls.flat()).toContain(first.id);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects the wrong library and unowned root collisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobbin-eagle-preflight-"));
    const store = await CatalogStore.open({ catalogRoot: join(root, "catalog"), statePath: join(root, "state.sqlite") });
    try {
      const wrong = new FakeEagle(join(root, "Other.library"));
      await expect(new EagleLibrary({ adapter: wrong, expectedLibraryPath: join(root, "Mobbin.library"), store, verifyFilesystem: false }).preflight())
        .rejects.toThrow("expected");
      const collision = new FakeEagle(join(root, "Mobbin.library"));
      collision.addExternalFolder("Apps");
      await expect(new EagleLibrary({ adapter: collision, expectedLibraryPath: collision.libraryPath, store, verifyFilesystem: false }).preflight())
        .rejects.toThrow("unowned");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes native duplicate operations across different identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobbin-eagle-duplicates-"));
    const store = await CatalogStore.open({ catalogRoot: join(root, "catalog"), statePath: join(root, "state.sqlite") });
    const adapter = new FakeEagle(join(root, "Mobbin.library"));
    const eagle = new EagleLibrary({ adapter, expectedLibraryPath: adapter.libraryPath, store, verifyFilesystem: false });
    const source = join(root, "screen.webp");
    await writeFile(source, "screen");
    try {
      const hash = "c".repeat(64);
      const original = await eagle.stageAsset(asset(hash, 1, source));
      await Promise.all([
        eagle.duplicateAsset(duplicateAsset(hash, 2), original.id),
        eagle.duplicateAsset(duplicateAsset(hash, 3), original.id),
        eagle.stageAsset(asset("d".repeat(64), 1, source)),
      ]);
      expect(adapter.maximumActiveDuplicates).toBe(1);
      expect(adapter.maximumActiveItemCreations).toBe(1);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

class FakeEagle implements EagleAdapter {
  readonly folders: EagleFolder[] = [];
  readonly items: EagleItem[] = [];
  readonly addCalls: Array<{ path: string; name: string; folders: string[] }> = [];
  readonly duplicateCalls: string[] = [];
  maximumActiveDuplicates = 0;
  maximumActiveItemCreations = 0;
  private activeDuplicates = 0;
  private activeItemCreations = 0;
  readonly trashCalls: string[][] = [];
  constructor(readonly libraryPath: string) {}
  async getLibraryInfo() { return { name: "Mobbin", path: this.libraryPath }; }
  async listFolders() { return structuredClone(this.folders); }
  async listItems() { return structuredClone(this.items); }
  async createFolder(input: { name: string; parent: string | null; description: string; orderBy?: "NAME" }) {
    const folder: EagleFolder = { id: `folder-${this.folders.length + 1}`, children: [], ...input };
    this.folders.push(folder);
    return structuredClone(folder);
  }
  async updateFolder(input: { id: string; name: string; description: string; parent?: string | null; orderBy?: "NAME" }) {
    Object.assign(this.folder(input.id), input);
  }
  async setFolderOrder(ids: string[], orderBy: "NAME", _sortIncrease: boolean) {
    for (const id of ids) this.folder(id).orderBy = orderBy;
  }
  async addItem(input: { path: string; name: string; folders: string[]; tags: string[]; annotation: string }) {
    this.activeItemCreations += 1;
    this.maximumActiveItemCreations = Math.max(this.maximumActiveItemCreations, this.activeItemCreations);
    await Bun.sleep(5);
    const item: EagleItem = { id: `item-${this.items.length + 1}`, ext: "webp", ...structuredClone(input) };
    this.addCalls.push({ path: input.path, name: input.name, folders: [...input.folders] });
    this.items.push(item);
    this.activeItemCreations -= 1;
    return structuredClone(item);
  }
  async duplicateItem(sourceId: string) {
    this.activeDuplicates += 1;
    this.activeItemCreations += 1;
    this.maximumActiveDuplicates = Math.max(this.maximumActiveDuplicates, this.activeDuplicates);
    this.maximumActiveItemCreations = Math.max(this.maximumActiveItemCreations, this.activeItemCreations);
    await Bun.sleep(5);
    const source = this.item(sourceId);
    const item: EagleItem = { ...structuredClone(source), id: `item-${this.items.length + 1}` };
    this.duplicateCalls.push(sourceId);
    this.items.push(item);
    this.activeDuplicates -= 1;
    this.activeItemCreations -= 1;
    return structuredClone(item);
  }
  async updateItem(input: { id: string; name?: string; folders: string[]; tags: string[]; annotation?: string }) {
    Object.assign(this.item(input.id), structuredClone(input));
  }
  async updateItems(inputs: Array<{ id: string; name?: string; folders: string[]; tags: string[]; annotation?: string }>) {
    for (const input of inputs) await this.updateItem(input);
  }
  async moveItemsToTrash(ids: string[]) {
    this.trashCalls.push([...ids]);
    for (const id of ids) this.items.splice(this.items.findIndex((item) => item.id === id), 1);
  }
  async removeFolders(ids: string[]) {
    for (const id of ids) this.folders.splice(this.folders.findIndex((folder) => folder.id === id), 1);
  }
  addExternalFolder(name: string): EagleFolder {
    const folder: EagleFolder = { id: `external-${this.folders.length + 1}`, name, parent: null, children: [], description: "" };
    this.folders.push(folder);
    return folder;
  }
  item(id: string): EagleItem {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Missing item ${id}`);
    return item;
  }
  folderPath(names: string[]): EagleFolder {
    let parent: string | null = null;
    let found: EagleFolder | undefined;
    for (const name of names) {
      found = this.folders.find((folder) => folder.parent === parent && folder.name === name);
      if (!found) throw new Error(`Missing folder ${names.join("/")}`);
      parent = found.id;
    }
    return found!;
  }
  private folder(id: string): EagleFolder {
    const folder = this.folders.find((candidate) => candidate.id === id);
    if (!folder) throw new Error(`Missing folder ${id}`);
    return folder;
  }
}

function asset(hash: string, position: number, sourcePath: string) {
  return { assetIdentity: `${hash}:${position}`, sha256: hash, position, sourcePath, bytes: 6, width: 1179, height: 2556, descriptor: "downloadableSrc" };
}

function duplicateAsset(hash: string, position: number) {
  return { assetIdentity: `${hash}:${position}`, sha256: hash, position, bytes: 6, width: 1179, height: 2556, descriptor: "downloadableSrc" };
}

function version(firstItemId: string, secondItemId: string) {
  return catalog([screen(1, firstItemId), screen(2, secondItemId)]);
}

function versionWithoutFirst(secondItemId: string) {
  return catalog([screen(2, secondItemId)]);
}

function catalog(screens: ReturnType<typeof screen>[]) {
  return versionCatalogSchema.parse({
    schemaVersion: 1,
    generatedAt: "2026-08-27T12:00:00.000Z",
    app: { slug: "luma", name: "Luma", mobbinAppId: "app-1", platform: "ios" },
    version: { mobbinVersionId: "version-1", publishedAt: null },
    flows: [{ mobbinFlowId: "flow-1", name: "Onboarding", group: "onboarding", position: 1, screens }],
  });
}

function screen(position: number, eagleItemId: string) {
  const hash = "a".repeat(64);
  return { mobbinScreenId: `screen-${position}`, position, sha256: hash, bytes: 6, width: 1179, height: 2556, descriptor: "downloadableSrc", assetIdentity: `${hash}:${position}`, eagleItemId };
}
