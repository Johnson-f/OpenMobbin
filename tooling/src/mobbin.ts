import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiaCookieHeader } from "./local/dia-auth";
import { type FetchLike, type FetchedScreen, discoverAppFlows, fetchScreenWebp } from "./local/mobbin-client";
import type { RunPlan, ScreenUploadMetadata } from "./shared/schemas";
import { AppError } from "./shared/errors";

export interface TemporaryScreen {
  path: string;
  metadata: ScreenUploadMetadata;
  dispose(): Promise<void>;
}

interface MobbinReaderOptions {
  cookieProvider: () => Promise<string>;
  fetcher?: FetchLike;
  temporaryRoot?: string;
}

export class MobbinReader {
  private cookie: string | null = null;
  private readonly fetcher: FetchLike;
  private readonly temporaryRoot: string;

  constructor(private readonly options: MobbinReaderOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.temporaryRoot = options.temporaryRoot ?? tmpdir();
  }

  static forDia(options: { profileDir: string; safeStorageService: string; temporaryRoot?: string }): MobbinReader {
    return new MobbinReader({
      temporaryRoot: options.temporaryRoot,
      cookieProvider: () => getDiaCookieHeader({ profileDir: options.profileDir, safeStorageService: options.safeStorageService }),
    });
  }

  async preflight(): Promise<void> {
    const cookie = await this.options.cookieProvider();
    if (!cookie) throw new AppError("MOBBIN_SESSION_REQUIRED", "Dia returned no Mobbin session", 401);
    this.cookie = cookie;
  }

  async discover(url: string): Promise<RunPlan> {
    return discoverAppFlows(url, this.requireCookie(), this.fetcher);
  }

  async fetchScreen(screenId: string): Promise<TemporaryScreen> {
    const directory = await mkdtemp(join(this.temporaryRoot, "mobbin-screen-"));
    await chmod(directory, 0o700);
    const path = join(directory, "screen.webp");
    try {
      const screen: FetchedScreen = await fetchScreenWebp(screenId, this.requireCookie(), this.fetcher);
      await Bun.write(path, screen.bytes);
      await chmod(path, 0o600);
      let disposed = false;
      return {
        path,
        metadata: screen.metadata,
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          await rm(directory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private requireCookie(): string {
    if (!this.cookie) throw new AppError("MOBBIN_SESSION_REQUIRED", "Run Mobbin preflight before discovery or fetching", 401);
    return this.cookie;
  }
}

export type { RunPlan, ScreenUploadMetadata };
