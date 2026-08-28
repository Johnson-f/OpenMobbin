import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogStore, type AssetRecord } from "../src/catalog";
import type { RunPlan, TemporaryScreen } from "../src/mobbin";
import { scrape, type ScrapeEagle, type ScrapeMobbin } from "../src/scrape";

describe("scrape transaction", () => {
  test("preflights before discovery and resumes a staged failure without downloading again", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobbin-scrape-transaction-"));
    const store = await CatalogStore.open({ catalogRoot: join(root, "catalog"), statePath: join(root, "state.sqlite") });
    const events: string[] = [];
    const mobbin = new FakeMobbin(root, events);
    const eagle = new FakeEagle(store, events);
    eagle.failFirstReconcile = true;
    try {
      await expect(scrape(appUrl(), { eagle, mobbin, store, now: () => new Date("2026-08-27T12:00:00.000Z") })).rejects.toThrow("reconcile stopped");
      expect(events.slice(0, 3)).toEqual(["eagle:preflight", "mobbin:preflight", "mobbin:discover"]);
      expect(mobbin.fetchCalls).toBe(1);
      expect(store.counts().assets).toBe(1);

      const result = await scrape(appUrl(), { eagle, mobbin, store, now: () => new Date("2026-08-27T12:00:00.000Z") });

      expect(result).toMatchObject({ completed: true, discovered: 1, fetched: 0, reused: 1, staged: 0, app: "luma", flows: 1 });
      expect(mobbin.fetchCalls).toBe(1);
      expect((await store.readApp("luma")).currentVersionId).toBe("version-1");
      expect(eagle.reconcileCalls.map((call) => call.removeObsolete)).toEqual([false, false, true]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces a stale staged asset instead of reusing its missing Eagle item", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobbin-scrape-stale-"));
    const store = await CatalogStore.open({ catalogRoot: join(root, "catalog"), statePath: join(root, "state.sqlite") });
    const events: string[] = [];
    const mobbin = new FakeMobbin(root, events);
    const eagle = new FakeEagle(store, events);
    const hash = "a".repeat(64);
    const identity = `${hash}:1`;
    store.recordScreenHash("screen-1", { sha256: hash, bytes: 6, width: 1179, height: 2556, descriptor: "downloadableSrc" });
    store.upsertAsset({ assetIdentity: identity, sha256: hash, position: 1, eagleItemId: "missing-item", status: "staged", bytes: 6, width: 1179, height: 2556, descriptor: "downloadableSrc" });
    try {
      const result = await scrape(appUrl(), { eagle, mobbin, store, now: () => new Date("2026-08-27T12:00:00.000Z") });

      expect(result).toMatchObject({ completed: true, fetched: 1, staged: 1, reused: 0 });
      expect(store.getAsset(identity)?.eagleItemId).toBe("item-1");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("duplicates an existing hash after discovering it from a new screen", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobbin-scrape-deduplicate-"));
    const store = await CatalogStore.open({ catalogRoot: join(root, "catalog"), statePath: join(root, "state.sqlite") });
    const events: string[] = [];
    const mobbin = new FakeMobbin(root, events);
    const eagle = new FakeEagle(store, events);
    const hash = "a".repeat(64);
    store.upsertAsset({ assetIdentity: `${hash}:2`, sha256: hash, position: 2, eagleItemId: "existing-item", status: "committed", bytes: 6, width: 1179, height: 2556, descriptor: "downloadableSrc" });
    eagle.itemIds.add("existing-item");
    try {
      const result = await scrape(appUrl(), { eagle, mobbin, store, now: () => new Date("2026-08-27T12:00:00.000Z") });

      expect(result).toMatchObject({ completed: true, fetched: 1, staged: 1, reused: 0 });
      expect(eagle.duplicateSources).toEqual(["existing-item"]);
      expect(events.some((event) => event.startsWith("eagle:stage:"))).toBe(false);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

class FakeMobbin implements ScrapeMobbin {
  fetchCalls = 0;
  constructor(private readonly root: string, private readonly events: string[]) {}
  async preflight() { this.events.push("mobbin:preflight"); }
  async discover() { this.events.push("mobbin:discover"); return plan(); }
  async fetchScreen(screenId: string): Promise<TemporaryScreen> {
    this.events.push(`mobbin:fetch:${screenId}`);
    this.fetchCalls += 1;
    const path = join(this.root, `temporary-${this.fetchCalls}.webp`);
    await writeFile(path, "screen");
    return {
      path,
      metadata: { mobbinScreenId: screenId, sha256: "a".repeat(64), bytes: 6, width: 1179, height: 2556, contentType: "image/webp", descriptor: "downloadableSrc" },
      dispose: async () => { await rm(path, { force: true }); },
    };
  }
}

class FakeEagle implements ScrapeEagle {
  failFirstReconcile = false;
  readonly reconcileCalls: Array<{ removeObsolete: boolean }> = [];
  readonly itemIds = new Set<string>();
  readonly duplicateSources: string[] = [];
  constructor(private readonly store: CatalogStore, private readonly events: string[]) {}
  async preflight() { this.events.push("eagle:preflight"); }
  hasItem(itemId: string) { return this.itemIds.has(itemId); }
  async stageAsset(input: Omit<AssetRecord, "eagleItemId" | "status"> & { sourcePath: string }) {
    this.events.push(`eagle:stage:${input.assetIdentity}`);
    const eagleItemId = `item-${input.position}`;
    this.store.upsertAsset({ ...input, eagleItemId, status: "staged" });
    this.itemIds.add(eagleItemId);
    return { id: eagleItemId };
  }
  async duplicateAsset(input: Omit<AssetRecord, "eagleItemId" | "status">, sourceItemId: string) {
    this.duplicateSources.push(sourceItemId);
    const eagleItemId = `duplicate-${input.position}`;
    this.store.upsertAsset({ ...input, eagleItemId, status: "staged" });
    this.itemIds.add(eagleItemId);
    return { id: eagleItemId };
  }
  async reconcile(_versions: unknown[], options: { removeObsolete?: boolean } = {}) {
    const removeObsolete = options.removeObsolete !== false;
    this.reconcileCalls.push({ removeObsolete });
    if (this.failFirstReconcile) {
      this.failFirstReconcile = false;
      throw new Error("reconcile stopped");
    }
    return { createdFolders: 0, updatedItems: 0, trashedItems: 0, removedFolders: 0 };
  }
}

function plan(): RunPlan {
  return {
    appSlug: "luma",
    appName: "Luma",
    mobbinAppId: "app-1",
    platform: "ios",
    version: { mobbinVersionId: "version-1", publishedAt: null, metadata: {} },
    flows: [{
      mobbinFlowId: "flow-1",
      name: "Onboarding",
      restricted: false,
      metadata: {},
      screens: [{ mobbinScreenId: "screen-1", position: 1, restricted: false, metadata: {} }],
    }],
  };
}

function appUrl(): string {
  return "https://mobbin.com/apps/luma-ios-11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/flows";
}
