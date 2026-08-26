import { lstat, mkdir, readFile, readdir, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function buildGroupedFlows({ outputRoot, sourceRoot }) {
  const flows = await discoverFlows(sourceRoot);
  const parent = dirname(outputRoot);
  const temporaryRoot = join(parent, `.${basename(outputRoot)}.tmp-${process.pid}-${Date.now()}`);
  const previousRoot = join(parent, `.${basename(outputRoot)}.previous-${process.pid}-${Date.now()}`);
  let movedPrevious = false;

  await mkdir(temporaryRoot, { recursive: true });
  try {
    for (const flow of flows) {
      const appRoot = join(temporaryRoot, flow.group, flow.app);
      await mkdir(appRoot, { recursive: true });
      const linkPath = join(appRoot, flow.folder);
      await symlink(relative(appRoot, flow.path), linkPath, "dir");
    }

    if (await pathExists(outputRoot)) {
      await rename(outputRoot, previousRoot);
      movedPrevious = true;
    }
    await rename(temporaryRoot, outputRoot);
    if (movedPrevious) await rm(previousRoot, { force: true, recursive: true });
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    if (movedPrevious && !(await pathExists(outputRoot))) await rename(previousRoot, outputRoot);
    throw error;
  }

  return {
    apps: new Set(flows.map((flow) => flow.app)).size,
    flowGroups: new Set(flows.map((flow) => flow.group)).size,
    flows: flows.length,
  };
}

async function discoverFlows(sourceRoot) {
  const flows = [];
  const apps = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const app of apps) {
    const appPath = join(sourceRoot, app.name);
    const entries = (await readdir(appPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    for (const entry of entries) {
      const flowPath = join(appPath, entry.name);
      const metadata = JSON.parse(await readFile(join(flowPath, "flow.json"), "utf8"));
      if (!metadata.flowName) throw new Error(`Missing flowName in ${join(flowPath, "flow.json")}`);
      flows.push({
        app: app.name,
        folder: entry.name,
        group: slugify(metadata.flowName),
        path: flowPath,
      });
    }
  }
  return flows;
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unnamed";
}

async function pathExists(path) {
  return lstat(path).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = await buildGroupedFlows({
    outputRoot: join(repositoryRoot, "grouped-flows"),
    sourceRoot: join(repositoryRoot, "screen-flows"),
  });
  console.log(`Grouped ${result.flows} flows from ${result.apps} apps into ${result.flowGroups} folders.`);
}
