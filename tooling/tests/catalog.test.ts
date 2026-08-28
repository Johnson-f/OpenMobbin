import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appCatalogSchema,
  assetIdentity,
  CatalogStore,
  flowGroup,
  flowLeafName,
  itemName,
  scanForbiddenMedia,
  versionCatalogSchema,
} from "../src/catalog";

describe("catalog contract", () => {
  test("builds stable Eagle identities and visible names", () => {
    const hash = "a1b2c3d4e5f6" + "0".repeat(52);
    expect(flowGroup("  Onboarding & Setup  ")).toBe("onboarding-and-setup");
    expect(flowLeafName(1, "Onboarding")).toBe("001 — Onboarding");
    expect(itemName(1, hash)).toBe("001 — a1b2c3d4e5f6");
    expect(assetIdentity(hash, 1)).toBe(`${hash}:1`);
  });

  test("validates app and version catalogs", () => {
    const hash = "a".repeat(64);
    const version = versionCatalogSchema.parse({
      schemaVersion: 1,
      generatedAt: "2026-08-27T12:00:00.000Z",
      app: { slug: "luma", name: "Luma", mobbinAppId: "app-1", platform: "ios" },
      version: { mobbinVersionId: "version-1", publishedAt: null },
      flows: [{
        mobbinFlowId: "flow-1",
        name: "Onboarding",
        group: "onboarding",
        position: 1,
        screens: [{
          mobbinScreenId: "screen-1",
          position: 1,
          sha256: hash,
          bytes: 30,
          width: 1179,
          height: 2556,
          descriptor: "downloadableSrc",
          assetIdentity: `${hash}:1`,
          eagleItemId: "item-1",
        }],
      }],
    });
    expect(version.flows[0]?.screens[0]?.assetIdentity).toBe(`${hash}:1`);
    expect(appCatalogSchema.parse({
      schemaVersion: 1,
      slug: "luma",
      name: "Luma",
      mobbinAppId: "app-1",
      platform: "ios",
      currentVersionId: "version-1",
      versionIds: ["version-1"],
    }).currentVersionId).toBe("version-1");
    expect(versionCatalogSchema.safeParse({ ...version, schemaVersion: 2 }).success).toBeFalse();
  });

  test("finds project media but ignores dependency and git caches", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobbin-media-guard-"));
    try {
      await mkdir(join(root, "catalog"), { recursive: true });
      await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
      await mkdir(join(root, ".git", "objects"), { recursive: true });
      await writeFile(join(root, "catalog", "bad.webp"), "bad");
      await writeFile(join(root, "node_modules", "fixture", "allowed.webp"), "dependency");
      await writeFile(join(root, ".git", "objects", "allowed.webp"), "git");
      expect(await scanForbiddenMedia(root)).toEqual(["catalog/bad.webp"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("commits version history and resumes identical plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobbin-catalog-store-"));
    const catalogRoot = join(root, "catalog");
    const statePath = join(root, "state.sqlite");
    const store = await CatalogStore.open({ catalogRoot, statePath });
    try {
      expect(store.pragmaState()).toEqual({ foreignKeys: true, integrity: "ok", journalMode: "wal" });
      const first = store.beginRun({ appSlug: "luma", versionId: "version-1", planHash: "1".repeat(64) });
      const resumed = store.beginRun({ appSlug: "luma", versionId: "version-1", planHash: "1".repeat(64) });
      expect(resumed.id).toBe(first.id);
      store.upsertAsset({
        assetIdentity: `${"a".repeat(64)}:1`,
        sha256: "a".repeat(64),
        position: 1,
        eagleItemId: "item-1",
        status: "staged",
        bytes: 30,
        width: 1179,
        height: 2556,
        descriptor: "downloadableSrc",
      });
      store.recordRunAsset(first.id, `${"a".repeat(64)}:1`, "staged");
      store.markRun(first.id, "completed");
      await store.commitVersion(versionFixture("version-1", "item-1"));
      await store.commitVersion(versionFixture("version-2", "item-2"));
      const app = await store.readApp("luma");
      expect(app).toMatchObject({ currentVersionId: "version-2", versionIds: ["version-1", "version-2"] });
      expect((await store.readVersion("luma", "version-1")).version.mobbinVersionId).toBe("version-1");
      expect(JSON.parse(await readFile(join(catalogRoot, "apps", "luma", "app.json"), "utf8"))).toEqual(app);
    } finally {
      store.close();
    }

    const rebuilt = await CatalogStore.rebuild({ catalogRoot, statePath: join(root, "rebuilt.sqlite") });
    try {
      expect(rebuilt.counts()).toMatchObject({ assets: 2, completedRuns: 2, screenHashes: 1 });
      expect(rebuilt.pragmaState().integrity).toBe("ok");
    } finally {
      rebuilt.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function versionFixture(versionId: string, eagleItemId: string) {
  const hash = (versionId === "version-1" ? "a" : "b").repeat(64);
  return versionCatalogSchema.parse({
    schemaVersion: 1,
    generatedAt: "2026-08-27T12:00:00.000Z",
    app: { slug: "luma", name: "Luma", mobbinAppId: "app-1", platform: "ios" },
    version: { mobbinVersionId: versionId, publishedAt: null },
    flows: [{
      mobbinFlowId: "flow-1",
      name: "Onboarding",
      group: "onboarding",
      position: 1,
      screens: [{
        mobbinScreenId: "screen-1",
        position: 1,
        sha256: hash,
        bytes: 30,
        width: 1179,
        height: 2556,
        descriptor: "downloadableSrc",
        assetIdentity: `${hash}:1`,
        eagleItemId,
      }],
    }],
  });
}
