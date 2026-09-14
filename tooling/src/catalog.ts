import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { z } from "zod";

const id = z.string().trim().min(1).max(255);
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const position = z.number().int().min(1).max(999);

export const catalogScreenSchema = z.object({
  mobbinScreenId: id,
  position,
  sha256,
  bytes: z.number().int().positive(),
  width: z.number().int().min(100),
  height: z.number().int().min(100),
  descriptor: z.string().trim().min(1).max(100),
  assetIdentity: z.string().min(66),
  eagleItemId: id,
}).superRefine((screen, context) => {
  if (screen.assetIdentity !== assetIdentity(screen.sha256, screen.position)) {
    context.addIssue({ code: "custom", path: ["assetIdentity"], message: "Asset identity must match SHA-256 and position" });
  }
});

export const catalogFlowSchema = z.object({
  mobbinFlowId: id,
  name: z.string().trim().min(1).max(255),
  group: slug,
  position,
  screens: z.array(catalogScreenSchema).min(1),
});

export const versionCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  app: z.object({ slug, name: id, mobbinAppId: id, platform: id }),
  version: z.object({ mobbinVersionId: id, publishedAt: z.iso.datetime().nullable() }),
  flows: z.array(catalogFlowSchema).min(1),
});

export const appCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  slug,
  name: id,
  mobbinAppId: id,
  platform: id,
  currentVersionId: id,
  versionIds: z.array(id).min(1),
}).superRefine((app, context) => {
  if (!app.versionIds.includes(app.currentVersionId)) {
    context.addIssue({ code: "custom", path: ["currentVersionId"], message: "Current version must be listed" });
  }
  if (new Set(app.versionIds).size !== app.versionIds.length) {
    context.addIssue({ code: "custom", path: ["versionIds"], message: "Version IDs must be unique" });
  }
});

export type AppCatalog = z.infer<typeof appCatalogSchema>;
export type VersionCatalog = z.infer<typeof versionCatalogSchema>;
export type CatalogFlow = z.infer<typeof catalogFlowSchema>;
export type CatalogScreen = z.infer<typeof catalogScreenSchema>;

export interface AssetRecord {
  assetIdentity: string;
  sha256: string;
  position: number;
  eagleItemId: string;
  status: "staged" | "committed";
  bytes: number;
  width: number;
  height: number;
  descriptor: string;
}

export interface ManagedFolderRecord {
  logicalKey: string;
  eagleId: string;
  kind: string;
  parentKey: string | null;
  name: string;
}

export interface ScreenHashRecord {
  screenId: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  descriptor: string;
}

interface CatalogStoreOptions {
  catalogRoot: string;
  statePath: string;
}

interface RunRecord {
  id: string;
  appSlug: string;
  versionId: string;
  planHash: string;
  status: string;
}

export class CatalogStore {
  private constructor(
    readonly catalogRoot: string,
    readonly statePath: string,
    private readonly database: Database,
  ) {}

  static async open(options: CatalogStoreOptions): Promise<CatalogStore> {
    await mkdir(dirname(options.statePath), { recursive: true });
    const database = new Database(options.statePath, { create: true, strict: true });
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = database.query<{ version: number }, [number]>("SELECT version FROM schema_migrations WHERE version = ?").get(1);
    if (!applied) {
      const sql = await Bun.file(join(import.meta.dir, "internal", "migrations", "001_eagle_only.sql")).text();
      const migrate = database.transaction(() => {
        database.exec(sql);
        database.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, new Date().toISOString());
      });
      migrate.immediate();
    }
    return new CatalogStore(options.catalogRoot, options.statePath, database);
  }

  static async rebuild(options: CatalogStoreOptions): Promise<CatalogStore> {
    const store = await CatalogStore.open(options);
    const appsRoot = join(options.catalogRoot, "apps");
    for (const appEntry of await directoryEntries(appsRoot)) {
      if (!appEntry.isDirectory()) continue;
      const app = appCatalogSchema.parse(await Bun.file(join(appsRoot, appEntry.name, "app.json")).json());
      for (const versionId of app.versionIds) {
        const version = versionCatalogSchema.parse(await Bun.file(join(appsRoot, appEntry.name, "versions", `${versionId}.json`)).json());
        const planHash = sha256Text(formatCatalogJson(version));
        const run = store.beginRun({ appSlug: app.slug, versionId, planHash });
        for (const flow of version.flows) {
          for (const screen of flow.screens) {
            store.upsertAsset({
              assetIdentity: screen.assetIdentity,
              sha256: screen.sha256,
              position: screen.position,
              eagleItemId: screen.eagleItemId,
              status: "committed",
              bytes: screen.bytes,
              width: screen.width,
              height: screen.height,
              descriptor: screen.descriptor,
            });
            store.upsertScreenHash(screen.mobbinScreenId, screen);
            store.recordRunAsset(run.id, screen.assetIdentity, "committed");
          }
        }
        store.markRun(run.id, "completed");
      }
    }
    return store;
  }

  beginRun(input: { appSlug: string; versionId: string; planHash: string }): RunRecord {
    const existing = this.database.query<RunRecord, [string, string, string]>(`
      SELECT id, app_slug AS appSlug, version_id AS versionId, plan_hash AS planHash, status
      FROM runs WHERE app_slug = ? AND version_id = ? AND plan_hash = ?
    `).get(input.appSlug, input.versionId, input.planHash);
    if (existing) return existing;
    const run: RunRecord = { id: randomUUID(), ...input, status: "planned" };
    this.database.query("INSERT INTO runs(id, app_slug, version_id, plan_hash, status, started_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(run.id, run.appSlug, run.versionId, run.planHash, run.status, new Date().toISOString());
    return run;
  }

  markRun(runId: string, status: "planned" | "running" | "completed" | "failed", error: string | null = null): void {
    const completedAt = status === "completed" ? new Date().toISOString() : null;
    this.database.query("UPDATE runs SET status = ?, completed_at = ?, error = ? WHERE id = ?").run(status, completedAt, error, runId);
  }

  upsertAsset(asset: AssetRecord): void {
    const existing = this.database.query<{ eagleItemId: string }, [string]>("SELECT eagle_item_id AS eagleItemId FROM assets WHERE asset_identity = ?").get(asset.assetIdentity);
    if (existing && existing.eagleItemId !== asset.eagleItemId) throw new Error(`Asset ${asset.assetIdentity} already belongs to Eagle item ${existing.eagleItemId}`);
    this.database.query(`
      INSERT INTO assets(asset_identity, sha256, position, eagle_item_id, status, bytes, width, height, descriptor, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_identity) DO UPDATE SET status = excluded.status, bytes = excluded.bytes,
        width = excluded.width, height = excluded.height, descriptor = excluded.descriptor, updated_at = excluded.updated_at
    `).run(asset.assetIdentity, asset.sha256, asset.position, asset.eagleItemId, asset.status, asset.bytes, asset.width, asset.height, asset.descriptor, new Date().toISOString());
  }

  getAsset(identity: string): AssetRecord | null {
    return this.database.query<AssetRecord, [string]>(`
      SELECT asset_identity AS assetIdentity, sha256, position, eagle_item_id AS eagleItemId,
        status, bytes, width, height, descriptor FROM assets WHERE asset_identity = ?
    `).get(identity) ?? null;
  }

  listAssets(): AssetRecord[] {
    return this.database.query<AssetRecord, []>(`
      SELECT asset_identity AS assetIdentity, sha256, position, eagle_item_id AS eagleItemId,
        status, bytes, width, height, descriptor FROM assets ORDER BY asset_identity
    `).all();
  }

  deleteAssets(identities: string[]): void {
    const deleteRunAsset = this.database.query("DELETE FROM run_assets WHERE asset_identity = ?");
    const deleteAsset = this.database.query("DELETE FROM assets WHERE asset_identity = ?");
    const transaction = this.database.transaction((values: string[]) => {
      for (const identity of values) {
        deleteRunAsset.run(identity);
        deleteAsset.run(identity);
      }
    });
    transaction.immediate(identities);
  }

  getScreenHash(screenId: string): ScreenHashRecord | null {
    return this.database.query<ScreenHashRecord, [string]>(`
      SELECT screen_id AS screenId, sha256, bytes, width, height, descriptor FROM screen_hashes WHERE screen_id = ?
    `).get(screenId) ?? null;
  }

  recordScreenHash(screenId: string, screen: Pick<ScreenHashRecord, "sha256" | "bytes" | "width" | "height" | "descriptor">): void {
    this.upsertScreenHash(screenId, screen);
  }

  upsertManagedFolder(folder: ManagedFolderRecord): void {
    this.database.query(`
      INSERT INTO managed_folders(logical_key, eagle_id, kind, parent_key, name, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(logical_key) DO UPDATE SET eagle_id = excluded.eagle_id, kind = excluded.kind,
        parent_key = excluded.parent_key, name = excluded.name, updated_at = excluded.updated_at
    `).run(folder.logicalKey, folder.eagleId, folder.kind, folder.parentKey, folder.name, new Date().toISOString());
  }

  getManagedFolder(logicalKey: string): ManagedFolderRecord | null {
    return this.database.query<ManagedFolderRecord, [string]>(`
      SELECT logical_key AS logicalKey, eagle_id AS eagleId, kind, parent_key AS parentKey, name
      FROM managed_folders WHERE logical_key = ?
    `).get(logicalKey) ?? null;
  }

  rekeyManagedLeaf(previousKey: string, nextKey: string): void {
    const result = this.database.query("UPDATE managed_folders SET logical_key = ?, updated_at = ? WHERE logical_key = ? AND kind IN ('app-flow', 'group-flow')")
      .run(nextKey, new Date().toISOString(), previousKey);
    if (result.changes !== 1) throw new Error(`Managed leaf ${previousKey} is missing`);
  }

  listManagedFolders(): ManagedFolderRecord[] {
    return this.database.query<ManagedFolderRecord, []>(`
      SELECT logical_key AS logicalKey, eagle_id AS eagleId, kind, parent_key AS parentKey, name
      FROM managed_folders ORDER BY logical_key
    `).all();
  }

  deleteManagedFolders(logicalKeys: string[]): void {
    const remove = this.database.query("DELETE FROM managed_folders WHERE logical_key = ?");
    const transaction = this.database.transaction((keys: string[]) => {
      for (const key of keys) remove.run(key);
    });
    transaction.immediate(logicalKeys);
  }

  setCheckpoint(name: string, status: string, payload: unknown = {}): void {
    this.database.query(`
      INSERT INTO migration_checkpoints(name, status, payload_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(name, status, JSON.stringify(payload), new Date().toISOString());
  }

  getCheckpoint(name: string): { name: string; status: string; payload: unknown } | null {
    const row = this.database.query<{ name: string; status: string; payloadJson: string }, [string]>(`
      SELECT name, status, payload_json AS payloadJson FROM migration_checkpoints WHERE name = ?
    `).get(name);
    return row ? { name: row.name, status: row.status, payload: JSON.parse(row.payloadJson) as unknown } : null;
  }

  recordRunAsset(runId: string, identity: string, status: "planned" | "staged" | "committed" | "failed", error: string | null = null): void {
    this.database.query(`
      INSERT INTO run_assets(run_id, asset_identity, status, error, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, asset_identity) DO UPDATE SET status = excluded.status, error = excluded.error, updated_at = excluded.updated_at
    `).run(runId, identity, status, error, new Date().toISOString());
  }

  async commitVersion(input: VersionCatalog): Promise<void> {
    const version = versionCatalogSchema.parse(input);
    const appDirectory = join(this.catalogRoot, "apps", version.app.slug);
    const versionsDirectory = join(appDirectory, "versions");
    const versionPath = join(versionsDirectory, `${version.version.mobbinVersionId}.json`);
    await mkdir(versionsDirectory, { recursive: true });
    if (await fileExists(versionPath)) {
      const current = versionCatalogSchema.parse(await Bun.file(versionPath).json());
      if (formatCatalogJson(current) !== formatCatalogJson(version)) throw new Error(`Version ${version.version.mobbinVersionId} is immutable`);
    } else {
      await atomicWrite(versionPath, formatCatalogJson(version));
    }
    const appPath = join(appDirectory, "app.json");
    const existing = await fileExists(appPath) ? appCatalogSchema.parse(await Bun.file(appPath).json()) : null;
    const versionIds = [...new Set([...(existing?.versionIds ?? []), version.version.mobbinVersionId])];
    const app = appCatalogSchema.parse({
      schemaVersion: 1,
      slug: version.app.slug,
      name: version.app.name,
      mobbinAppId: version.app.mobbinAppId,
      platform: version.app.platform,
      currentVersionId: version.version.mobbinVersionId,
      versionIds,
    });
    await atomicWrite(appPath, formatCatalogJson(app));
    for (const flow of version.flows) {
      for (const screen of flow.screens) {
        this.upsertAsset({
          assetIdentity: screen.assetIdentity,
          sha256: screen.sha256,
          position: screen.position,
          eagleItemId: screen.eagleItemId,
          status: "committed",
          bytes: screen.bytes,
          width: screen.width,
          height: screen.height,
          descriptor: screen.descriptor,
        });
        this.upsertScreenHash(screen.mobbinScreenId, screen);
      }
    }
  }

  async readApp(slugValue: string): Promise<AppCatalog> {
    return appCatalogSchema.parse(await Bun.file(join(this.catalogRoot, "apps", slugValue, "app.json")).json());
  }

  async readVersion(slugValue: string, versionId: string): Promise<VersionCatalog> {
    return versionCatalogSchema.parse(await Bun.file(join(this.catalogRoot, "apps", slugValue, "versions", `${versionId}.json`)).json());
  }

  async readCurrentVersions(): Promise<VersionCatalog[]> {
    const versions: VersionCatalog[] = [];
    const appsRoot = join(this.catalogRoot, "apps");
    for (const entry of await directoryEntries(appsRoot)) {
      if (!entry.isDirectory()) continue;
      const app = await this.readApp(entry.name);
      versions.push(await this.readVersion(app.slug, app.currentVersionId));
    }
    return versions.sort((left, right) => left.app.slug.localeCompare(right.app.slug));
  }

  pragmaState(): { foreignKeys: boolean; integrity: string; journalMode: string } {
    const foreignKeys = this.database.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys === 1;
    const integrity = this.database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check ?? "missing";
    const journalMode = this.database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode ?? "missing";
    return { foreignKeys, integrity, journalMode };
  }

  counts(): { assets: number; completedRuns: number; screenHashes: number } {
    const count = (table: string, where = ""): number => this.database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get()?.count ?? 0;
    return { assets: count("assets"), completedRuns: count("runs", "WHERE status = 'completed'"), screenHashes: count("screen_hashes") };
  }

  close(): void {
    this.database.close();
  }

  private upsertScreenHash(screenId: string, screen: Pick<CatalogScreen, "sha256" | "bytes" | "width" | "height" | "descriptor">): void {
    this.database.query(`
      INSERT INTO screen_hashes(screen_id, sha256, bytes, width, height, descriptor, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(screen_id) DO UPDATE SET sha256 = excluded.sha256, bytes = excluded.bytes,
        width = excluded.width, height = excluded.height, descriptor = excluded.descriptor, updated_at = excluded.updated_at
    `).run(screenId, screen.sha256, screen.bytes, screen.width, screen.height, screen.descriptor, new Date().toISOString());
  }
}

export function flowGroup(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

export function flowLeafName(value: number, name: string): string {
  return `${pad(value)} — ${name.trim()}`;
}

export function itemName(value: number, hash: string): string {
  sha256.parse(hash);
  return `${pad(value)} — ${hash.slice(0, 12)}`;
}

export function assetIdentity(hash: string, value: number): string {
  sha256.parse(hash);
  position.parse(value);
  return `${hash}:${value}`;
}

export async function scanForbiddenMedia(root: string): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".webp")) paths.push(relative(root, path));
    }
  };
  await visit(root);
  return paths.sort();
}

function pad(value: number): string {
  position.parse(value);
  return String(value).padStart(3, "0");
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function directoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function formatCatalogJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
