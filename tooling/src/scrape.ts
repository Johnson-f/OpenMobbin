import { createHash } from "node:crypto";
import { type AssetRecord, type CatalogStore, type VersionCatalog, assetIdentity, flowGroup, versionCatalogSchema } from "./catalog";
import type { RunPlan, TemporaryScreen } from "./mobbin";

export interface ScrapeMobbin {
  preflight(): Promise<void>;
  discover(url: string): Promise<RunPlan>;
  fetchScreen(screenId: string): Promise<TemporaryScreen>;
}

export interface ScrapeEagle {
  preflight(): Promise<void>;
  hasItem(itemId: string): boolean;
  stageAsset(input: Omit<AssetRecord, "eagleItemId" | "status"> & { sourcePath: string }): Promise<{ id: string }>;
  duplicateAsset(input: Omit<AssetRecord, "eagleItemId" | "status">, sourceItemId: string): Promise<{ id: string }>;
  reconcile(versions: VersionCatalog[], options?: { removeObsolete?: boolean }): Promise<{
    createdFolders: number;
    updatedItems: number;
    trashedItems: number;
    removedFolders: number;
  }>;
}

interface ScrapeDependencies {
  eagle: ScrapeEagle;
  mobbin: ScrapeMobbin;
  store: CatalogStore;
  concurrency?: number;
  now?: () => Date;
}

export interface ScrapeResult {
  completed: boolean;
  runId: string;
  app: string;
  flows: number;
  discovered: number;
  uniqueReferences: number;
  fetched: number;
  staged: number;
  reused: number;
  createdFolders: number;
  updatedItems: number;
  trashedItems: number;
  removedFolders: number;
}

interface ResolvedScreen {
  mobbinScreenId: string;
  position: number;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  descriptor: string;
  assetIdentity: string;
  eagleItemId: string;
}

export async function scrape(url: string, dependencies: ScrapeDependencies): Promise<ScrapeResult> {
  const concurrency = dependencies.concurrency ?? 6;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error("Scrape concurrency must be between 1 and 12");
  await dependencies.eagle.preflight();
  await dependencies.mobbin.preflight();
  const plan = await dependencies.mobbin.discover(url);
  const currentApp = (await dependencies.store.readCurrentVersions()).find((version) => version.app.slug === plan.appSlug)?.app;
  if (currentApp && (currentApp.platform !== plan.platform || currentApp.mobbinAppId !== plan.mobbinAppId)) {
    throw new Error(`Catalog identity conflict for ${plan.appSlug}: this name already belongs to another app or platform`);
  }
  const planHash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  const run = dependencies.store.beginRun({ appSlug: plan.appSlug, versionId: plan.version.mobbinVersionId, planHash });
  const discovered = plan.flows.reduce((sum, flow) => sum + flow.screens.length, 0);
  const references = [...new Map(plan.flows.flatMap((flow) => flow.screens).map((screen) => [`${screen.mobbinScreenId}\0${screen.position}`, screen])).values()];
  if (run.status === "completed") {
    return {
      completed: true,
      runId: run.id,
      app: plan.appSlug,
      flows: plan.flows.length,
      discovered,
      uniqueReferences: references.length,
      fetched: 0,
      staged: 0,
      reused: references.length,
      createdFolders: 0,
      updatedItems: 0,
      trashedItems: 0,
      removedFolders: 0,
    };
  }
  dependencies.store.markRun(run.id, "running");
  const resolved = new Map<string, ResolvedScreen>();
  let fetched = 0;
  let staged = 0;
  let reused = 0;
  let next = 0;
  let firstError: unknown;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const reference = references[index];
      if (!reference || firstError) return;
      const key = `${reference.mobbinScreenId}\0${reference.position}`;
      try {
        const known = dependencies.store.getScreenHash(reference.mobbinScreenId);
        const knownIdentity = known ? assetIdentity(known.sha256, reference.position) : null;
        const existing = knownIdentity ? dependencies.store.getAsset(knownIdentity) : null;
        if (known && existing && dependencies.eagle.hasItem(existing.eagleItemId)) {
          resolved.set(key, { ...known, mobbinScreenId: reference.mobbinScreenId, position: reference.position, assetIdentity: knownIdentity!, eagleItemId: existing.eagleItemId });
          dependencies.store.recordRunAsset(run.id, knownIdentity!, "committed");
          reused += 1;
          continue;
        }
        if (existing?.status === "staged") dependencies.store.deleteAssets([existing.assetIdentity]);
        if (existing?.status === "committed") throw new Error(`Committed Eagle item ${existing.eagleItemId} is missing`);
        const sameHash = known
          ? dependencies.store.listAssets()
            .filter((asset) => asset.sha256 === known.sha256 && dependencies.eagle.hasItem(asset.eagleItemId))
            .sort((left, right) => Number(right.status === "committed") - Number(left.status === "committed"))[0] ?? null
          : null;
        if (known && sameHash) {
          const identity = assetIdentity(known.sha256, reference.position);
          const item = await dependencies.eagle.duplicateAsset({ ...known, position: reference.position, assetIdentity: identity }, sameHash.eagleItemId);
          dependencies.store.recordRunAsset(run.id, identity, "staged");
          resolved.set(key, { ...known, mobbinScreenId: reference.mobbinScreenId, position: reference.position, assetIdentity: identity, eagleItemId: item.id });
          staged += 1;
          continue;
        }
        let temporary: TemporaryScreen | null = null;
        try {
          temporary = await dependencies.mobbin.fetchScreen(reference.mobbinScreenId);
          fetched += 1;
          const metadata = temporary.metadata;
          const identity = assetIdentity(metadata.sha256, reference.position);
          dependencies.store.recordScreenHash(reference.mobbinScreenId, metadata);
          const exact = dependencies.store.getAsset(identity);
          if (exact && dependencies.eagle.hasItem(exact.eagleItemId)) {
            dependencies.store.recordRunAsset(run.id, identity, exact.status);
            resolved.set(key, { ...metadata, position: reference.position, assetIdentity: identity, eagleItemId: exact.eagleItemId });
            reused += 1;
            continue;
          }
          if (exact?.status === "staged") dependencies.store.deleteAssets([identity]);
          if (exact?.status === "committed") throw new Error(`Committed Eagle item ${exact.eagleItemId} is missing`);
          const source = dependencies.store.listAssets()
            .filter((asset) => asset.sha256 === metadata.sha256 && dependencies.eagle.hasItem(asset.eagleItemId))
            .sort((left, right) => Number(right.status === "committed") - Number(left.status === "committed"))[0] ?? null;
          const input = {
            assetIdentity: identity,
            sha256: metadata.sha256,
            position: reference.position,
            bytes: metadata.bytes,
            width: metadata.width,
            height: metadata.height,
            descriptor: metadata.descriptor,
          };
          const item = source
            ? await dependencies.eagle.duplicateAsset(input, source.eagleItemId)
            : await dependencies.eagle.stageAsset({ ...input, sourcePath: temporary.path });
          dependencies.store.recordRunAsset(run.id, identity, "staged");
          resolved.set(key, {
            mobbinScreenId: reference.mobbinScreenId,
            position: reference.position,
            sha256: metadata.sha256,
            bytes: metadata.bytes,
            width: metadata.width,
            height: metadata.height,
            descriptor: metadata.descriptor,
            assetIdentity: identity,
            eagleItemId: item.id,
          });
          staged += 1;
        } finally {
          await temporary?.dispose();
        }
      } catch (error) {
        firstError = error;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, references.length)) }, worker));
  if (firstError) {
    dependencies.store.markRun(run.id, "failed", firstError instanceof Error ? firstError.message : "Screen resolution failed");
    throw firstError;
  }

  const generatedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const version = versionCatalogSchema.parse({
    schemaVersion: 1,
    generatedAt,
    app: { slug: plan.appSlug, name: plan.appName, mobbinAppId: plan.mobbinAppId, platform: plan.platform },
    version: { mobbinVersionId: plan.version.mobbinVersionId, publishedAt: plan.version.publishedAt },
    flows: plan.flows.map((flow, flowIndex) => ({
      mobbinFlowId: flow.mobbinFlowId,
      name: flow.name,
      group: flowGroup(flow.name),
      position: flowIndex + 1,
      screens: flow.screens.map((screen) => resolved.get(`${screen.mobbinScreenId}\0${screen.position}`)),
    })),
  });
  try {
    const current = (await dependencies.store.readCurrentVersions()).filter((candidate) => candidate.app.slug !== version.app.slug);
    const desired = [...current, version].sort((left, right) => left.app.slug.localeCompare(right.app.slug));
    const committed = await dependencies.eagle.reconcile(desired, { removeObsolete: false });
    await dependencies.store.commitVersion(version);
    const cleaned = await dependencies.eagle.reconcile(desired, { removeObsolete: true });
    dependencies.store.markRun(run.id, "completed");
    return {
      completed: true,
      runId: run.id,
      app: plan.appSlug,
      flows: plan.flows.length,
      discovered,
      uniqueReferences: references.length,
      fetched,
      staged,
      reused,
      createdFolders: committed.createdFolders + cleaned.createdFolders,
      updatedItems: committed.updatedItems + cleaned.updatedItems,
      trashedItems: cleaned.trashedItems,
      removedFolders: cleaned.removedFolders,
    };
  } catch (error) {
    dependencies.store.markRun(run.id, "failed", error instanceof Error ? error.message : "Commit failed");
    throw error;
  }
}
