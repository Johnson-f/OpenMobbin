import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EagleInventory } from "../src/eagle";
import { CatalogStore } from "../src/catalog";
import { executeMigration, planMigration, type MigrationEagle } from "../src/migrate";

const screenHash = createHash("sha256").update("screen").digest("hex");

describe("legacy migration", () => {
  test("expands pure hashes by position and reuses one existing Eagle item per hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobbin-migration-plan-"));
    try {
      await writeLegacyFlow(root, "luma", "001-luma-onboarding-flow-1", "flow-1", "Onboarding", 1);
      await writeLegacyFlow(root, "luma", "002-luma-home-flow-2", "flow-2", "Home", 2);
      const statePath = join(root, ".eagle-sync-state.json");
      await writeFile(statePath, JSON.stringify({
        version: 1,
        sourceRoot: join(root, "screen-flows"),
        libraryPath: "/tmp/Mobbin.library",
        sourceFiles: {},
        eagleItems: { "item-existing": { sha256: screenHash, name: "001-old", ext: "webp", folders: ["old-flow"] } },
      }));
      const inventory: EagleInventory = {
        libraryPath: "/tmp/Mobbin.library",
        folders: [{ id: "flows", name: "Flows", parent: null, children: [], description: "" }],
        items: [{ id: "item-existing", name: "001-old", ext: "webp", folders: ["old-flow"], tags: ["mobbin-flow"], annotation: "" }],
      };

      const plan = await planMigration({ repositoryRoot: root, inventory, legacyStatePath: statePath });

      expect(plan.summary).toEqual({ apps: 1, flows: 2, references: 2, contentHashes: 1, assetIdentities: 2, reusedItems: 1, imports: 0, duplicates: 1, unresolved: 0 });
      expect(plan.assets.find((asset) => asset.position === 1)?.eagleItemId).toBe("item-existing");
      expect(plan.assets.find((asset) => asset.position === 2)?.sourcePath).toEndWith("002-screen.webp");
      expect(plan.versions[0]?.flows.map((flow) => flow.group)).toEqual(["onboarding", "home"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("applies once and resumes a completed migration with zero mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobbin-migration-apply-"));
    const store = await CatalogStore.open({ catalogRoot: join(root, "catalog"), statePath: join(root, "state.sqlite") });
    try {
      await writeLegacyFlow(root, "luma", "001-luma-onboarding-flow-1", "flow-1", "Onboarding", 1);
      await writeLegacyFlow(root, "luma", "002-luma-home-flow-2", "flow-2", "Home", 2);
      const statePath = join(root, ".eagle-sync-state.json");
      await writeFile(statePath, JSON.stringify({ eagleItems: { existing: { sha256: screenHash, name: "001-old", ext: "webp", folders: [] } } }));
      const inventory: EagleInventory = {
        libraryPath: "/tmp/Mobbin.library",
        folders: [{ id: "flows", name: "Flows", parent: null, children: [], description: "" }],
        items: [{ id: "existing", name: "001-old", ext: "webp", folders: [], tags: ["mobbin-flow"], annotation: "" }],
      };
      const plan = await planMigration({ repositoryRoot: root, inventory, legacyStatePath: statePath });
      const eagle = new FakeMigrationEagle(store);

      const first = await executeMigration({ plan, eagle, store, now: () => new Date("2026-08-27T12:00:00.000Z") });
      const second = await executeMigration({ plan, eagle, store, now: () => new Date("2026-08-27T12:00:00.000Z") });

      expect(first).toMatchObject({ completed: true, importedItems: 0, duplicatedItems: 1, reusedItems: 1 });
      expect(second).toMatchObject({ completed: true, mutations: 0 });
      expect((await store.readApp("luma")).currentVersionId).toBe("version-1");
      expect(eagle.duplicateCalls).toBe(1);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

class FakeMigrationEagle implements MigrationEagle {
  stageCalls = 0;
  duplicateCalls = 0;
  constructor(private readonly store: CatalogStore) {}
  async claimLegacyFlowsRoot() {}
  async preflight() {}
  async stageAsset(input: Parameters<MigrationEagle["stageAsset"]>[0]) {
    this.stageCalls += 1;
    const id = `imported-${this.stageCalls}`;
    this.store.upsertAsset({ ...input, eagleItemId: id, status: "staged" });
    return { id };
  }
  async duplicateAsset(input: Parameters<MigrationEagle["duplicateAsset"]>[0]) {
    this.duplicateCalls += 1;
    const id = `duplicated-${this.duplicateCalls}`;
    this.store.upsertAsset({ ...input, eagleItemId: id, status: "staged" });
    return { id };
  }
  async clearLegacyFlowsDescendants() { return { updatedItems: 1, removedFolders: 1 }; }
  async reconcile() { return { createdFolders: 1, updatedItems: 1, trashedItems: 0, removedFolders: 0 }; }
}

async function writeLegacyFlow(root: string, app: string, folder: string, flowId: string, flowName: string, position: number): Promise<void> {
  const directory = join(root, "screen-flows", app, folder);
  await mkdir(directory, { recursive: true });
  const image = join(directory, `${String(position).padStart(3, "0")}-screen.webp`);
  await writeFile(image, "screen");
  await writeFile(join(directory, "flow.json"), `${JSON.stringify({
    flowId,
    flowName,
    appId: "app-1",
    appName: "Luma",
    appVersionId: "version-1",
    appVersionPublishedAt: null,
    platform: "ios",
    screens: [{
      screenId: `screen-${position}`,
      index: position,
      descriptor: "downloadableSrc",
      bytes: 6,
      sha256: screenHash,
      dimensions: { width: 1179, height: 2556 },
      savedPath: image,
    }],
  }, null, 2)}\n`);
}
