import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogStore, versionCatalogSchema } from "../src/catalog";
import type { EagleFolder, EagleInventory, EagleItem } from "../src/eagle";
import { verify, type VerifyEagle } from "../src/verify";

describe("verification", () => {
  test("passes a clean catalog and reports an exact Eagle hash mismatch", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "mobbin-verify-repo-"));
    const libraryRoot = await mkdtemp(join(tmpdir(), "mobbin-verify-library-"));
    const store = await CatalogStore.open({ catalogRoot: join(repositoryRoot, "catalog"), statePath: join(repositoryRoot, ".mobbin", "state.sqlite") });
    const hash = "a".repeat(64);
    const itemPath = join(libraryRoot, "item.webp");
    await writeFile(itemPath, "screen");
    const folders = folderFixture();
    const item: EagleItem = { id: "item-1", name: "001 — aaaaaaaaaaaa", ext: "webp", folders: ["app-flow", "group-flow"], tags: ["mobbin-managed"], annotation: `Mobbin asset ${hash}:1` };
    const eagle: VerifyEagle = {
      preflight: async () => {},
      inventory: async (): Promise<EagleInventory> => ({ libraryPath: libraryRoot, folders, items: [item] }),
      itemFilePath: () => itemPath,
    };
    try {
      for (const folder of folders) store.upsertManagedFolder({ logicalKey: folder.logicalKey, eagleId: folder.id, kind: folder.kind, parentKey: folder.parentKey, name: folder.name });
      store.upsertAsset({ assetIdentity: `${hash}:1`, sha256: hash, position: 1, eagleItemId: "item-1", status: "committed", bytes: 6, width: 1179, height: 2556, descriptor: "downloadableSrc" });
      const run = store.beginRun({ appSlug: "luma", versionId: "version-1", planHash: "1".repeat(64) });
      store.markRun(run.id, "completed");
      await store.commitVersion(version(hash));
      const clean = await verify({ eagle, store, repositoryRoot, hashFile: async () => hash });
      expect(clean).toMatchObject({ ok: true, failures: [], references: 1, assets: 1 });

      const broken = await verify({ eagle, store, repositoryRoot, hashFile: async () => "b".repeat(64) });
      expect(broken.ok).toBeFalse();
      expect(broken.failures.map((failure) => failure.code)).toContain("EAGLE_HASH_MISMATCH");
    } finally {
      store.close();
      await rm(repositoryRoot, { recursive: true, force: true });
      await rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

function version(hash: string) {
  return versionCatalogSchema.parse({
    schemaVersion: 1,
    generatedAt: "2026-08-27T12:00:00.000Z",
    app: { slug: "luma", name: "Luma", mobbinAppId: "app-1", platform: "ios" },
    version: { mobbinVersionId: "version-1", publishedAt: null },
    flows: [{
      mobbinFlowId: "flow-1",
      name: "Onboarding",
      group: "onboarding",
      position: 1,
      screens: [{ mobbinScreenId: "screen-1", position: 1, sha256: hash, bytes: 6, width: 1179, height: 2556, descriptor: "downloadableSrc", assetIdentity: `${hash}:1`, eagleItemId: "item-1" }],
    }],
  });
}

function folderFixture(): Array<EagleFolder & { logicalKey: string; kind: string; parentKey: string | null }> {
  return [
    { id: "apps", logicalKey: "root:apps", kind: "root", parentKey: null, name: "Apps", parent: null, description: "Managed by Mobbin tooling", children: [] },
    { id: "flows", logicalKey: "root:flows", kind: "root", parentKey: null, name: "Flows", parent: null, description: "Managed by Mobbin tooling", children: [] },
    { id: "staging", logicalKey: "root:staging", kind: "root", parentKey: null, name: "_Mobbin Staging", parent: null, description: "Managed by Mobbin tooling", children: [] },
    { id: "app", logicalKey: "app:luma", kind: "app", parentKey: "root:apps", name: "luma", parent: "apps", description: "Managed by Mobbin tooling", children: [] },
    { id: "app-flow", logicalKey: "app-flow:luma:flow-1", kind: "app-flow", parentKey: "app:luma", name: "001 — Onboarding", parent: "app", description: "Managed by Mobbin tooling", orderBy: "NAME", children: [] },
    { id: "group", logicalKey: "group:onboarding", kind: "group", parentKey: "root:flows", name: "onboarding", parent: "flows", description: "Managed by Mobbin tooling", children: [] },
    { id: "group-flow", logicalKey: "group-flow:onboarding:luma:flow-1", kind: "group-flow", parentKey: "group:onboarding", name: "luma — 001 — Onboarding", parent: "group", description: "Managed by Mobbin tooling", orderBy: "NAME", children: [] },
  ];
}
