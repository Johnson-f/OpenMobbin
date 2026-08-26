import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EagleClient,
  processListHasActiveFlowExporter,
  syncScreenFlows,
} from "./sync-screen-flows-to-eagle.mjs";

class FakeEagleClient {
  constructor(libraryPath) {
    this.libraryPath = libraryPath;
    this.folders = [];
    this.items = [];
    this.addCalls = [];
    this.removeFolderCalls = [];
    this.trashCalls = [];
    this.updateCalls = [];
  }

  async getLibraryInfo() {
    return { name: "Mobbin", path: this.libraryPath };
  }

  async listFolders() {
    return structuredClone(this.folders);
  }

  async listItems() {
    return structuredClone(this.items);
  }

  async createFolder({ name, parent }) {
    const folder = {
      id: `folder-${this.folders.length + 1}`,
      name,
      parent: parent || null,
      children: [],
    };
    this.folders.push(folder);
    return structuredClone(folder);
  }

  async addItem(item) {
    const created = {
      id: `item-${this.items.length + 1}`,
      name: item.name,
      ext: "webp",
      folders: [...item.folders],
      tags: [...item.tags],
    };
    this.addCalls.push(structuredClone(item));
    this.items.push(created);
    return structuredClone(created);
  }

  async updateItem(update) {
    this.updateCalls.push(structuredClone(update));
    const item = this.items.find((candidate) => candidate.id === update.id);
    assert.ok(item, `missing fake Eagle item ${update.id}`);
    item.folders = [...update.folders];
    item.tags = [...update.tags];
    return structuredClone(item);
  }

  async moveItemsToTrash(itemIds) {
    this.trashCalls.push([...itemIds]);
    this.items = this.items.filter((item) => !itemIds.includes(item.id));
  }

  async removeFolders(folderIds) {
    this.removeFolderCalls.push([...folderIds]);
    this.folders = this.folders.filter((folder) => !folderIds.includes(folder.id));
  }
}

async function writeScreen(sourceRoot, app, flow, filename, bytes) {
  const flowDirectory = join(sourceRoot, app, flow);
  await mkdir(flowDirectory, { recursive: true });
  const path = join(flowDirectory, filename);
  await writeFile(path, bytes);
  return path;
}

test("syncs incrementally and links duplicate content into every flow without adding another item", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "mobbin-eagle-sync-"));
  const sourceRoot = join(testRoot, "screen-flows");
  const stateFile = join(testRoot, "state.json");
  const libraryPath = join(testRoot, "Mobbin.library");
  const eagle = new FakeEagleClient(libraryPath);
  const hashCalls = [];
  const hashFile = async (path) => {
    hashCalls.push(path);
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(await readFile(path)).digest("hex");
  };

  try {
    const firstPath = await writeScreen(sourceRoot, "craft", "001-first-flow", "001-a.webp", "same-screen");
    await writeScreen(sourceRoot, "craft", "002-second-flow", "001-a-copy.webp", "same-screen");
    await writeScreen(sourceRoot, "craft", "002-second-flow", "002-b.webp", "different-screen");

    const first = await syncScreenFlows({ eagle, hashFile, libraryPath, sourceRoot, stateFile });

    assert.equal(first.sourceFiles, 3);
    assert.equal(first.uniqueImages, 2);
    assert.equal(first.addedItems, 2);
    assert.equal(first.updatedItems, 0);
    assert.equal(eagle.addCalls.length, 2);
    assert.equal(eagle.addCalls.find((call) => call.path === firstPath).folders.length, 2);
    assert.equal(hashCalls.length, 3);

    hashCalls.length = 0;
    const second = await syncScreenFlows({ eagle, hashFile, libraryPath, sourceRoot, stateFile });

    assert.equal(second.addedItems, 0);
    assert.equal(second.updatedItems, 0);
    assert.equal(eagle.addCalls.length, 2);
    assert.equal(hashCalls.length, 0, "unchanged source files should use cached hashes");

    await writeScreen(sourceRoot, "craft", "003-third-flow", "001-a-again.webp", "same-screen");
    hashCalls.length = 0;
    const third = await syncScreenFlows({ eagle, hashFile, libraryPath, sourceRoot, stateFile });

    assert.equal(third.addedItems, 0);
    assert.equal(third.updatedItems, 1);
    assert.equal(eagle.addCalls.length, 2);
    assert.equal(eagle.updateCalls.length, 1);
    assert.equal(eagle.updateCalls[0].folders.length, 3);
    assert.equal(hashCalls.length, 1);

    await writeFile(firstPath, "replacement-screen");
    hashCalls.length = 0;
    const fourth = await syncScreenFlows({ eagle, hashFile, libraryPath, sourceRoot, stateFile });

    assert.equal(fourth.addedItems, 1);
    assert.equal(fourth.updatedItems, 1, "the old content should lose the replaced flow link");
    assert.equal(eagle.items.length, 3);
    assert.equal(hashCalls.length, 1, "a modified source file should be re-hashed");

    await unlink(firstPath);
    const fifth = await syncScreenFlows({ eagle, hashFile, libraryPath, sourceRoot, stateFile });

    assert.equal(fifth.addedItems, 0);
    assert.equal(fifth.updatedItems, 0);
    assert.equal(fifth.trashedItems, 1);
    assert.equal(fifth.removedFolders, 1);
    assert.deepEqual(eagle.trashCalls, [["item-3"]]);
    assert.deepEqual(eagle.removeFolderCalls, [["folder-3"]]);
    assert.equal(eagle.items.length, 2, "an orphaned Mobbin item should move to Eagle Trash");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("removes obsolete Flows links but preserves orphaned items linked outside Flows", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "mobbin-eagle-sync-external-"));
  const sourceRoot = join(testRoot, "screen-flows");
  const stateFile = join(testRoot, "state.json");
  const libraryPath = join(testRoot, "Mobbin.library");
  const eagle = new FakeEagleClient(libraryPath);

  try {
    const sourcePath = await writeScreen(sourceRoot, "craft", "001-first-flow", "001-a.webp", "shared-screen");
    await syncScreenFlows({ eagle, libraryPath, sourceRoot, stateFile });
    const syncedItem = eagle.items[0];
    const externalFolder = { children: [], id: "external-folder", name: "Favorites", parent: null };
    eagle.folders.push(externalFolder);
    syncedItem.folders.push(externalFolder.id);

    await unlink(sourcePath);
    const result = await syncScreenFlows({ eagle, libraryPath, sourceRoot, stateFile });

    assert.equal(result.trashedItems, 0);
    assert.equal(result.updatedItems, 1);
    assert.equal(result.removedFolders, 2);
    assert.deepEqual(eagle.trashCalls, []);
    assert.deepEqual(eagle.removeFolderCalls, [["folder-3", "folder-2"]]);
    assert.deepEqual(eagle.items[0].folders, [externalFolder.id]);
    assert.deepEqual(eagle.folders.map((folder) => folder.id).sort(), ["external-folder", "folder-1"]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("EagleClient uses the v2 folder and multi-folder item contracts", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push({ body, method: request.method, pathname: url.pathname, search: url.search });

    const send = (data) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data, status: "success" }));
    };

    if (url.pathname === "/api/library/info") return send({ library: { name: "Mobbin", path: "/tmp/Mobbin.library" } });
    if (url.pathname === "/api/v2/folder/get") return send({ data: [{ children: [], id: "flows", name: "Flows" }], total: 1 });
    if (url.pathname === "/api/v2/item/get") {
      return send({
        data: [{ ext: "webp", folders: ["flow-a"], id: "item-1", name: "screen", tags: ["mobbin-flow"] }],
        total: 1,
      });
    }
    if (url.pathname === "/api/v2/folder/create") return send({ children: [], id: "new-folder", ...body });
    if (url.pathname === "/api/v2/item/add") return send({ ext: "webp", id: "new-item", ...body });
    if (url.pathname === "/api/v2/item/update") return send(body);
    if (url.pathname === "/api/item/moveToTrash") return send(null);
    if (url.pathname === "/api/script/inject") return send(null);
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const client = new EagleClient(`http://127.0.0.1:${address.port}`);

  try {
    assert.deepEqual(await client.getLibraryInfo(), { name: "Mobbin", path: "/tmp/Mobbin.library" });
    assert.equal((await client.listFolders()).length, 1);
    assert.equal((await client.listItems()).length, 1);
    assert.equal((await client.createFolder({ name: "Craft", parent: "flows" })).id, "new-folder");
    assert.equal((await client.addItem({ folders: ["flow-a", "flow-b"], name: "screen", path: "/tmp/screen.webp", tags: ["mobbin-flow"] })).id, "new-item");
    await client.updateItem({ folders: ["flow-a", "flow-b"], id: "item-1", tags: ["mobbin-flow"] });
    await client.moveItemsToTrash(["item-1"]);
    await client.removeFolders(["flow-b", "flow-a"]);

    assert.deepEqual(requests.find((entry) => entry.pathname === "/api/v2/item/get").body.folders, undefined);
    assert.deepEqual(requests.find((entry) => entry.pathname === "/api/v2/item/add").body.folders, ["flow-a", "flow-b"]);
    assert.deepEqual(requests.find((entry) => entry.pathname === "/api/v2/item/update").body.folders, ["flow-a", "flow-b"]);
    assert.deepEqual(requests.find((entry) => entry.pathname === "/api/item/moveToTrash").body.itemIds, ["item-1"]);
    assert.match(requests.find((entry) => entry.pathname === "/api/script/inject").body.script, /flow-b.*flow-a/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("detects an active flow exporter without matching unrelated commands", () => {
  assert.equal(
    processListHasActiveFlowExporter("node scripts/export-mobbin-flows.mjs --category meetup\n"),
    true,
  );
  assert.equal(
    processListHasActiveFlowExporter("node scripts/sync-screen-flows-to-eagle.mjs\nrg export-mobbin-flows.mjs\n"),
    false,
  );
});
