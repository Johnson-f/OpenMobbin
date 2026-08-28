import type { EagleAdapter, EagleFolder, EagleItem } from "../eagle";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

interface EaglePayload<T> {
  status: string;
  data: T;
  message?: string;
}

interface Page<T> {
  data: T[];
  total: number;
}

export class EagleHttpAdapter implements EagleAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl = "http://127.0.0.1:41595") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async getLibraryInfo(): Promise<{ name: string; path: string }> {
    const data = await this.request<{ library: { name: string; path: string } }>("/api/library/info");
    return data.library;
  }

  async listFolders(): Promise<EagleFolder[]> {
    const folders = await this.paginate<Record<string, unknown>>("/api/v2/folder/get", "GET");
    return folders.map(normalizeFolder);
  }

  async listItems(): Promise<EagleItem[]> {
    const items = await this.paginate<Record<string, unknown>>("/api/v2/item/get", "POST", {
      fields: ["id", "name", "ext", "folders", "tags", "annotation"],
    });
    return items.map(normalizeItem);
  }

  async createFolder(input: { name: string; parent: string | null; description: string; orderBy?: "NAME" }): Promise<EagleFolder> {
    const folder = await this.request<Record<string, unknown>>("/api/v2/folder/create", { method: "POST", body: input });
    return normalizeFolder(folder);
  }

  async updateFolder(input: { id: string; name: string; description: string; parent?: string | null; orderBy?: "NAME" }): Promise<void> {
    await this.request("/api/v2/folder/update", { method: "POST", body: input });
  }

  async setFolderOrder(ids: string[], orderBy: "NAME", sortIncrease: boolean): Promise<void> {
    const encodedIds = JSON.stringify(ids);
    const encodedOrder = JSON.stringify(orderBy);
    const script = `(() => { const scope = angular.element("body").scope(); for (const id of ${encodedIds}) { const folder = scope.folderMappings[id]; if (!folder) continue; folder.orderBy = ${encodedOrder}; folder.sortIncrease = ${sortIncrease ? "true" : "false"}; } scope.saveFolder(); scope.$evalAsync(); })()`;
    await this.request("/api/script/inject", { method: "POST", body: { script } });
  }

  async addItem(input: { path: string; name: string; folders: string[]; tags: string[]; annotation: string }): Promise<EagleItem> {
    const item = await this.request<Record<string, unknown>>("/api/v2/item/add", { method: "POST", body: input });
    return normalizeItem(item);
  }

  async duplicateItem(sourceId: string): Promise<EagleItem> {
    const library = await this.getLibraryInfo();
    const imagesRoot = join(library.path, "images");
    const before = new Set((await readdir(imagesRoot)).filter((name) => name.endsWith(".info")));
    const script = `require("electron").ipcRenderer.send("duplicate-file", ${JSON.stringify(sourceId)})`;
    await this.request("/api/script/inject", { method: "POST", body: { script } });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const current = (await readdir(imagesRoot)).filter((name) => name.endsWith(".info"));
      const created = current.find((name) => !before.has(name));
      if (created) {
        const id = created.slice(0, -".info".length);
        for (let attempt = 0; attempt < 60; attempt += 1) {
          try {
            const payload = await this.request<Record<string, unknown>>(`/api/item/info?id=${encodeURIComponent(id)}`);
            return normalizeItem(payload);
          } catch {
            await Bun.sleep(100);
          }
        }
      }
      await Bun.sleep(50);
    }
    throw new Error(`Eagle did not duplicate item ${sourceId}`);
  }

  async updateItem(input: { id: string; name?: string; folders: string[]; tags: string[]; annotation?: string }): Promise<void> {
    await this.request("/api/v2/item/update", { method: "POST", body: input });
  }

  async updateItems(inputs: Array<{ id: string; name?: string; folders: string[]; tags: string[]; annotation?: string }>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const input = inputs[next++];
        if (!input) return;
        await this.updateItem(input);
      }
    };
    await Promise.all(Array.from({ length: Math.min(32, Math.max(1, inputs.length)) }, worker));
  }

  async moveItemsToTrash(ids: string[]): Promise<void> {
    await this.request("/api/item/moveToTrash", { method: "POST", body: { itemIds: ids } });
  }

  async removeFolders(ids: string[]): Promise<void> {
    const encoded = JSON.stringify(ids);
    const script = `(() => { const scope = angular.element("body").scope(); for (const id of ${encoded}) { const folder = scope.folderMappings[id]; if (!folder || folder.imageCount > 0 || folder.children.length > 0) continue; scope.removeFolder(folder, { isDeleteImages: false, ignoreRestore: true }); } scope.$evalAsync(); })()`;
    await this.request("/api/script/inject", { method: "POST", body: { script } });
  }

  private async paginate<T>(path: string, method: "GET" | "POST", body: Record<string, unknown> = {}): Promise<T[]> {
    const items: T[] = [];
    const limit = 1000;
    for (let offset = 0; ; offset += limit) {
      const page = method === "GET"
        ? await this.request<Page<T>>(`${path}?limit=${limit}&offset=${offset}`)
        : await this.request<Page<T>>(path, { method, body: { ...body, limit, offset } });
      items.push(...page.data);
      if (items.length >= page.total || page.data.length === 0) return items;
    }
  }

  private async request<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      });
    } catch (error) {
      throw new Error(`Cannot reach Eagle at ${this.baseUrl}. Open Eagle and try again.`, { cause: error });
    }
    const payload = await response.json().catch(() => null) as EaglePayload<T> | null;
    if (!response.ok || payload?.status !== "success") throw new Error(payload?.message || `Eagle request failed with HTTP ${response.status}`);
    return payload.data;
  }
}

function normalizeFolder(value: Record<string, unknown>): EagleFolder {
  return {
    id: String(value.id),
    name: String(value.name ?? ""),
    parent: typeof value.parent === "string" && value.parent ? value.parent : null,
    description: typeof value.description === "string" ? value.description : "",
    orderBy: value.orderBy === "NAME" ? "NAME" : undefined,
    children: Array.isArray(value.children) ? value.children.map((child) => normalizeFolder(record(child))) : [],
  };
}

function normalizeItem(value: Record<string, unknown>): EagleItem {
  return {
    id: String(value.id),
    name: String(value.name ?? ""),
    ext: String(value.ext ?? "webp"),
    folders: Array.isArray(value.folders) ? value.folders.map(String) : [],
    tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
    annotation: typeof value.annotation === "string" ? value.annotation : "",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
