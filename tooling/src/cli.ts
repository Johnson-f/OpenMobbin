import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CatalogStore } from "./catalog";
import { EagleLibrary } from "./eagle";
import { EagleHttpAdapter } from "./internal/eagle-client";
import { MobbinReader } from "./mobbin";
import { backupEagleLibrary, executeMigration, planMigration } from "./migrate";
import { scrape } from "./scrape";
import { verify } from "./verify";

interface ParsedArguments {
  command: string;
  values: Record<string, string | boolean>;
}

export async function runCli(argv: string[], env: Record<string, string | undefined> = Bun.env): Promise<number> {
  const parsed = parseArguments(argv);
  const repositoryRoot = env.MOBBIN_REPOSITORY_ROOT || dirname(dirname(import.meta.dir));
  const catalogRoot = env.MOBBIN_CATALOG_ROOT || join(repositoryRoot, "catalog");
  const statePath = env.MOBBIN_STATE_PATH || join(repositoryRoot, ".mobbin", "state.sqlite");
  const libraryPath = env.EAGLE_LIBRARY_PATH || join(homedir(), "Mobbin.library");
  const apiUrl = env.EAGLE_API_URL || "http://127.0.0.1:41595";
  if (parsed.command === "migrate:eagle" && parsed.values["dry-run"] === true) {
    const adapter = new EagleHttpAdapter(apiUrl);
    const library = await adapter.getLibraryInfo();
    if (library.path !== libraryPath) throw new Error(`Eagle has ${library.path} open; expected ${libraryPath}`);
    const plan = await planMigration({
      repositoryRoot,
      inventory: { libraryPath: library.path, folders: await adapter.listFolders(), items: await adapter.listItems() },
    });
    console.log(JSON.stringify({ dryRun: true, ...plan.summary, legacyFlowsRootId: plan.legacyFlowsRootId }, null, 2));
    return plan.summary.unresolved === 0 && plan.legacyFlowsRootId ? 0 : 1;
  }
  const store = await CatalogStore.open({ catalogRoot, statePath });
  try {
    const eagle = new EagleLibrary({ adapter: new EagleHttpAdapter(apiUrl), expectedLibraryPath: libraryPath, store });
    if (parsed.command === "scrape") {
      const mobbin = MobbinReader.forDia({
        profileDir: env.DIA_PROFILE_DIR || join(homedir(), "Library", "Application Support", "Dia", "User Data", "Default"),
        safeStorageService: env.DIA_SAFE_STORAGE_SERVICE || "Dia Safe Storage",
      });
      const result = await scrape(stringArg(parsed.values, "url"), { eagle, mobbin, store, concurrency: numberArg(parsed.values, "concurrency") });
      console.log(JSON.stringify(result, null, 2));
      return result.completed ? 0 : 1;
    }
    if (parsed.command === "verify") {
      const report = await verify({ eagle, store, repositoryRoot });
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    if (parsed.command === "migrate:eagle") {
      const plan = await planMigration({ repositoryRoot, inventory: await eagle.inventory() });
      if (plan.summary.unresolved > 0 || !plan.legacyFlowsRootId) {
        console.log(JSON.stringify({ completed: false, ...plan.summary, legacyFlowsRootId: plan.legacyFlowsRootId }, null, 2));
        return 1;
      }
      if (!store.getCheckpoint("migration:backup")) {
        const backup = await backupEagleLibrary({ libraryPath, apiUrl });
        store.setCheckpoint("migration:backup", "completed", backup);
        console.log(JSON.stringify({ phase: "backup", ...backup }));
      }
      const result = await executeMigration({
        plan,
        eagle,
        store,
        progress: ({ phase, current, total }) => {
          if (current === undefined || total === undefined || current === total || current % 100 === 0) console.log(JSON.stringify({ phase, current, total }));
        },
      });
      const report = await verify({ eagle, store, repositoryRoot, allowLegacySources: true });
      console.log(JSON.stringify({ ...result, verification: report }, null, 2));
      return result.completed && report.ok ? 0 : 1;
    }
    throw new Error("Use scrape, verify, or migrate:eagle");
  } finally {
    store.close();
  }
}

export function parseArguments(argv: string[]): ParsedArguments {
  const [command = "", ...rest] = argv;
  const values: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${argument}`);
    const key = argument.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) values[key] = true;
    else {
      values[key] = next;
      index += 1;
    }
  }
  return { command, values };
}

function stringArg(values: Record<string, string | boolean>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || !value) throw new Error(`--${key} is required`);
  return value;
}

function numberArg(values: Record<string, string | boolean>, key: string): number | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`--${key} requires a number`);
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`--${key} requires an integer`);
  return number;
}

if (import.meta.main) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(JSON.stringify({ error: { code: "COMMAND_FAILED", message: error instanceof Error ? error.message : "Unknown error" } }, null, 2));
    process.exitCode = 1;
  }
}
