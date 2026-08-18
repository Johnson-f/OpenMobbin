#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptDir);

const defaults = {
  platform: "ios",
  sort: "popularity",
  outDir: "/Users/user/mobbin-sides/UI-element",
  reportDir: "/Users/user/mobbin-sides/UI-element-reports",
  elementConcurrency: 1,
  screenConcurrency: 12,
};

const uiElements = [
  { group: "Control", name: "Accordion", count: 1464 },
  { group: "Control", name: "Button", count: 32574 },
  { group: "Control", name: "Checkbox", count: 1725 },
  { group: "Control", name: "Color Picker", count: 779 },
  { group: "Control", name: "Date Picker", count: 668 },
  { group: "Control", name: "Floating Action Button", count: 2241 },
  { group: "Control", name: "Radio Button", count: 1355 },
  { group: "Control", name: "Rating Control", count: 380 },
  { group: "Control", name: "Search Bar", count: 5497 },
  { group: "Control", name: "Segmented Control", count: 2289 },
  { group: "Control", name: "Slider", count: 1667 },
  { group: "Control", name: "Stepper", count: 901 },
  { group: "Control", name: "Switch", count: 4070 },
  { group: "Control", name: "Tab", count: 5989 },
  { group: "Control", name: "Text Field", count: 13452 },
  { group: "Control", name: "Tile", count: 3248 },
  { group: "Control", name: "Time Picker", count: 423 },

  { group: "View", name: "Badge", count: 3235 },
  { group: "View", name: "Banner", count: 3432 },
  { group: "View", name: "Card", count: 10325 },
  { group: "View", name: "Carousel", count: 6803 },
  { group: "View", name: "Chip", count: 4096 },
  { group: "View", name: "Divider", count: 5154 },
  { group: "View", name: "Gallery", count: 3071 },
  { group: "View", name: "Loading Indicator", count: 3055 },
  { group: "View", name: "Map Pin", count: 1289 },
  { group: "View", name: "Progress Indicator", count: 4174 },
  { group: "View", name: "Side Navigation", count: 260 },
  { group: "View", name: "Skeleton", count: 471 },
  { group: "View", name: "Stacked List", count: 11568 },
  { group: "View", name: "Status Dot", count: 798 },
  { group: "View", name: "Tab Bar", count: 3626 },
  { group: "View", name: "Table", count: 582 },
  { group: "View", name: "Toolbar", count: 2509 },
  { group: "View", name: "Top Navigation Bar", count: 2849 },

  { group: "Overlay", name: "Action Sheet", count: 177 },
  { group: "Overlay", name: "Bottom Sheet", count: 13876 },
  { group: "Overlay", name: "Coach Marks", count: 1608 },
  { group: "Overlay", name: "Dialog", count: 4242 },
  { group: "Overlay", name: "Drawer", count: 314 },
  { group: "Overlay", name: "Dropdown Menu", count: 955 },
  { group: "Overlay", name: "Full-Screen Overlay", count: 2976 },
  { group: "Overlay", name: "Toast", count: 3083 },
  { group: "Overlay", name: "Tooltip", count: 440 },

  { group: "Imagery", name: "Avatar", count: 7285 },
  { group: "Imagery", name: "Icon", count: 7215 },
  { group: "Imagery", name: "Illustration", count: 6459 },
  { group: "Imagery", name: "Logo", count: 1946 },
  { group: "Imagery", name: "Photo", count: 2316 },
];

const args = parseArgs(process.argv.slice(2));
const platform = String(args.platform || defaults.platform);
const sort = String(args.sort || defaults.sort);
const outDir = String(args["out-dir"] || defaults.outDir);
const reportDir = String(args["report-dir"] || defaults.reportDir);
const elementConcurrency = Number(args["element-concurrency"] || args.concurrency || defaults.elementConcurrency);
const screenConcurrency = Number(args["screen-concurrency"] || defaults.screenConcurrency);
const limitScreens = args.limit ? Number(args.limit) : null;
const dryRun = Boolean(args["dry-run"]);
const force = Boolean(args.force);

await mkdir(outDir, { recursive: true });
await mkdir(reportDir, { recursive: true });

let selected = selectElements(args);
if (args["start-from"]) {
  const startSlug = slugify(String(args["start-from"]));
  const startIndex = selected.findIndex((element) => slugify(element.name) === startSlug);
  if (startIndex < 0) throw new Error(`Unknown --start-from element: ${args["start-from"]}`);
  selected = selected.slice(startIndex);
}
if (args["limit-elements"]) selected = selected.slice(0, Number(args["limit-elements"]));

if (dryRun) {
  console.log(JSON.stringify({ outDir, reportDir, count: selected.length, selected }, null, 2));
  process.exit(0);
}

const aggregate = {
  generatedAt: new Date().toISOString(),
  platform,
  sort,
  outDir,
  reportDir,
  requestedElementCount: selected.length,
  elements: [],
};

let nextIndex = 0;

async function worker(workerIndex) {
  for (;;) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= selected.length) return;
    const element = selected[index];
    const result = await exportElement(element, index, selected.length, workerIndex);
    aggregate.elements[index] = result;
    await writeAggregateReport();
  }
}

await Promise.all(Array.from({ length: Math.max(1, elementConcurrency) }, (_, index) => worker(index + 1)));
await writeAggregateReport();

const summary = summarize(aggregate.elements);
console.log(JSON.stringify({ ...summary, outDir, reportDir }, null, 2));

async function exportElement(element, index, total, workerIndex) {
  const slug = slugify(element.name);
  const imagesDir = join(outDir, slug);
  const elementReportDir = join(reportDir, slug);
  const reportPath = join(elementReportDir, "mobbin-screen-downloadables-report.json");

  if (!force) {
    const existing = await readJsonIfExists(reportPath);
    if (existing && existing.screenCount > 0 && existing.savedImageCount === existing.screenCount) {
      console.error(`[${workerIndex}] ${index + 1}/${total} ${element.name}: already complete`);
      return {
        ...element,
        slug,
        status: "skipped-complete",
        screenCount: existing.screenCount,
        savedImageCount: existing.savedImageCount,
        reportPath,
        imagesDir,
      };
    }
  }

  await mkdir(imagesDir, { recursive: true });
  await mkdir(elementReportDir, { recursive: true });

  const searchUrl = `https://mobbin.com/search/apps/${encodeURIComponent(platform)}?content_type=ui-elements&sort=${encodeURIComponent(sort)}&filter=screenElements.${encodeURIComponent(element.name)}`;
  const childArgs = [
    join(scriptDir, "export-mobbin-screens.mjs"),
    "--search-url",
    searchUrl,
    "--screen-element",
    element.name,
    "--category",
    slug,
    "--images-dir",
    imagesDir,
    "--report-dir",
    elementReportDir,
    "--concurrency",
    String(screenConcurrency),
  ];
  if (limitScreens) childArgs.push("--limit", String(limitScreens));

  console.error(`[${workerIndex}] ${index + 1}/${total} ${element.name}: start`);
  const startedAt = new Date().toISOString();
  const code = await runNode(childArgs, `[${slug}]`);
  const finishedAt = new Date().toISOString();
  const report = await readJsonIfExists(reportPath);

  const result = {
    ...element,
    slug,
    status: code === 0 ? "completed" : "failed",
    exitCode: code,
    startedAt,
    finishedAt,
    screenCount: report?.screenCount ?? null,
    savedImageCount: report?.savedImageCount ?? null,
    uniqueSha256Count: report?.uniqueSha256Count ?? null,
    tinyImageCount: report?.tinyImageCount ?? null,
    reportPath,
    imagesDir,
  };
  console.error(
    `[${workerIndex}] ${index + 1}/${total} ${element.name}: ${result.status} saved=${result.savedImageCount ?? "?"}/${result.screenCount ?? "?"}`,
  );
  return result;
}

function runNode(childArgs, prefix) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, childArgs, {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(prefixLines(prefix, chunk)));
    child.stderr.on("data", (chunk) => process.stderr.write(prefixLines(prefix, chunk)));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function prefixLines(prefix, chunk) {
  return String(chunk)
    .split(/\n/)
    .map((line, index, arr) => (index === arr.length - 1 && line === "" ? "" : `${prefix} ${line}`))
    .join("\n");
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeAggregateReport() {
  const elements = aggregate.elements.filter(Boolean);
  const summary = summarize(elements);
  await writeFile(
    join(reportDir, "ui-elements-export-report.json"),
    JSON.stringify(
      {
        ...aggregate,
        updatedAt: new Date().toISOString(),
        ...summary,
        elements,
      },
      null,
      2,
    ),
  );
}

function summarize(elements) {
  return {
    completedElementCount: elements.filter((element) => element.status === "completed").length,
    skippedCompleteElementCount: elements.filter((element) => element.status === "skipped-complete").length,
    failedElementCount: elements.filter((element) => element.status === "failed").length,
    totalScreenCount: sum(elements.map((element) => element.screenCount)),
    totalSavedImageCount: sum(elements.map((element) => element.savedImageCount)),
  };
}

function selectElements(parsedArgs) {
  const requested = [
    ...splitList(parsedArgs.element),
    ...splitList(parsedArgs.elements),
    ...splitList(parsedArgs["screen-element"]),
  ];
  if (parsedArgs.all || requested.length === 0) return uiElements;

  const bySlug = new Map(uiElements.map((element) => [slugify(element.name), element]));
  return requested.map((name) => {
    const match = bySlug.get(slugify(name));
    if (!match) throw new Error(`Unknown UI element: ${name}`);
    return match;
  });
}

function splitList(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
}
