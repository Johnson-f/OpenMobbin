import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobbinReader } from "../src/mobbin";

const appUrl = "https://mobbin.com/apps/luma-ios-11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/flows";

describe("Mobbin module", () => {
  test("requires preflight and cleans owner-only temporary WebPs", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "mobbin-reader-test-"));
    const webp = vp8x(1179, 2556);
    const reader = new MobbinReader({
      cookieProvider: async () => "session=cookie",
      temporaryRoot,
      fetcher: async (input) => {
        const url = String(input);
        if (url.endsWith("/flows")) return new Response(flightHtml({
          partialFlows: [{ id: "flow-1", name: "Onboarding", screens: [{ screenId: "screen-1", order: 1 }] }],
          appVersions: [{ id: "22222222-2222-2222-2222-222222222222" }],
        }));
        if (url.includes("fetch-screen-info")) return Response.json({
          value: { screenCdnImgSources: { downloadableSrc: "https://cdn.invalid/screen.webp" } },
        });
        return new Response(webp, { headers: { "content-type": "image/webp" } });
      },
    });
    try {
      await expect(reader.discover(appUrl)).rejects.toMatchObject({ code: "MOBBIN_SESSION_REQUIRED" });
      await reader.preflight();
      expect((await reader.discover(appUrl)).flows[0]?.name).toBe("Onboarding");
      const screen = await reader.fetchScreen("screen-1");
      expect(screen.metadata).toMatchObject({ width: 1179, height: 2556, bytes: 30 });
      expect((await stat(screen.path)).mode & 0o777).toBe(0o600);
      await screen.dispose();
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

function flightHtml(value: unknown): string {
  return `<html><script>self.__next_f.push(${JSON.stringify([1, JSON.stringify(value)])})</script></html>`;
}

function vp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode("VP8X"), 12);
  write24(bytes, 24, width - 1);
  write24(bytes, 27, height - 1);
  return bytes;
}

function write24(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}
