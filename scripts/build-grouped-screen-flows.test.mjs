import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildGroupedFlows } from "./build-grouped-screen-flows.mjs";

async function writeFlow(sourceRoot, app, folder, flowName) {
  const flowDirectory = join(sourceRoot, app, folder);
  await mkdir(flowDirectory, { recursive: true });
  await writeFile(join(flowDirectory, "flow.json"), `${JSON.stringify({ appName: app, flowName }, null, 2)}\n`);
  await writeFile(join(flowDirectory, "001-screen.webp"), `${app}-${flowName}-${folder}`);
  return flowDirectory;
}

test("builds a replaceable local index grouped by flow name and app", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "grouped-screen-flows-"));
  const sourceRoot = join(testRoot, "screen-flows");
  const outputRoot = join(testRoot, "grouped-flows");

  try {
    const anzFlow = await writeFlow(sourceRoot, "anz-plus", "001-anz-onboarding", "Onboarding");
    await writeFlow(sourceRoot, "meetup", "001-meetup-onboarding", "onboarding");
    await writeFlow(sourceRoot, "meetup", "002-meetup-onboarding-alt", "Onboarding");
    await writeFlow(sourceRoot, "meetup", "003-meetup-home", "Home");

    const first = await buildGroupedFlows({ outputRoot, sourceRoot });

    assert.deepEqual(first, { apps: 2, flowGroups: 2, flows: 4 });
    const anzLink = join(outputRoot, "onboarding", "anz-plus", "001-anz-onboarding");
    assert.equal((await lstat(anzLink)).isSymbolicLink(), true);
    assert.equal(await realpath(anzLink), await realpath(anzFlow));
    assert.equal((await readlink(anzLink)).startsWith("/"), false, "links should be relative");
    assert.equal((await readdir(join(outputRoot, "onboarding", "meetup"))).length, 2);
    assert.equal(await readFile(join(anzFlow, "001-screen.webp"), "utf8"), "anz-plus-Onboarding-001-anz-onboarding");

    await rm(anzFlow, { recursive: true });
    await writeFlow(sourceRoot, "craft", "001-craft-settings", "Settings");
    const second = await buildGroupedFlows({ outputRoot, sourceRoot });

    assert.deepEqual(second, { apps: 2, flowGroups: 3, flows: 4 });
    await assert.rejects(lstat(anzLink), { code: "ENOENT" });
    assert.equal((await lstat(join(outputRoot, "settings", "craft", "001-craft-settings"))).isSymbolicLink(), true);
    assert.deepEqual((await readdir(testRoot)).sort(), ["grouped-flows", "screen-flows"]);
  } finally {
    await rm(testRoot, { force: true, recursive: true });
  }
});
