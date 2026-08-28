import { describe, expect, test } from "bun:test";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { decryptChromiumCookieValue } from "../../src/local/dia-auth";
import { discoverAppFlows, fetchScreenWebp } from "../../src/local/mobbin-client";
import { parseAppPageHtml, parseMobbinAppUrl } from "../../src/local/mobbin-page";
import { chooseBestImageSource } from "../../src/local/screen-source";
import { sha256Hex } from "../../src/shared/hashing";

const url = "https://mobbin.com/apps/anz-plus-ios-11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/screens";

describe("Mobbin reader", () => {
  test("normalizes an app URL", () => {
    expect(parseMobbinAppUrl(url)).toEqual({
      slug: "anz-plus",
      name: "ANZ Plus",
      id: "11111111-1111-1111-1111-111111111111",
      versionId: "22222222-2222-2222-2222-222222222222",
      platform: "ios",
      flowsUrl: "https://mobbin.com/apps/anz-plus-ios-11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/flows",
    });
  });

  test("parses flows and canonical screen order", () => {
    const app = parseMobbinAppUrl(url);
    const html = flightHtml({
      partialFlows: [{
        id: "flow-1",
        name: "Onboarding",
        screens: [
          { screenId: "screen-2", order: 20, width: 1179, height: 2556 },
          { screenId: "screen-1", order: 10, width: 1179, height: 2556 },
        ],
      }],
      appVersions: [{ id: app.versionId, publishedAt: "2026-08-20T10:00:00.000Z" }],
    });
    const plan = parseAppPageHtml(html, app);
    expect(plan.flows[0]?.screens.map((screen) => screen.mobbinScreenId)).toEqual(["screen-1", "screen-2"]);
    expect(plan.flows[0]?.screens.map((screen) => screen.position)).toEqual([1, 2]);
    expect(plan.version.publishedAt).toBe("2026-08-20T10:00:00.000Z");
  });

  test("prefers the full-size source", () => {
    expect(chooseBestImageSource({
      downloadableSrc: "https://cdn.invalid/original",
      srcSet: [{ url: "https://cdn.invalid/720", descriptor: "720w" }],
    })?.descriptor).toBe("downloadableSrc");
    expect(chooseBestImageSource({
      srcSet: [{ url: "small", descriptor: "320w" }, { url: "large", descriptor: "1440w" }],
    })?.url).toBe("large");
  });

  test("decrypts Chromium v10 cookies with a host hash", () => {
    const key = pbkdf2Sync("password", "saltysalt", 1003, 16, "sha1");
    const plain = Buffer.concat([Buffer.from(sha256Hex(".mobbin.com"), "hex"), Buffer.from("session-value")]);
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
    expect(decryptChromiumCookieValue(".mobbin.com", encrypted, key)).toBe("session-value");
  });

  test("discovers metadata and fetches a validated WebP", async () => {
    const app = parseMobbinAppUrl(url);
    const webp = vp8x(1179, 2556);
    const fetcher = (async (input: string | URL | Request) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/flows")) return new Response(flightHtml({
        partialFlows: [{ id: "flow", name: "Onboarding", screens: [{ screenId: "screen", order: 1 }] }],
        appVersions: [{ id: app.versionId }],
      }), { status: 200, headers: { "content-type": "text/html" } });
      if (requestUrl.includes("fetch-screen-info")) return Response.json({
        value: { screenCdnImgSources: { downloadableSrc: "https://cdn.invalid/signed" } },
      });
      return new Response(webp, { status: 200, headers: { "content-type": "image/webp" } });
    });
    expect((await discoverAppFlows(url, "cookie", fetcher)).flows).toHaveLength(1);
    const screen = await fetchScreenWebp("screen", "cookie", fetcher);
    expect(screen.metadata).toMatchObject({ width: 1179, height: 2556, bytes: 30 });
    expect(screen.metadata.sha256).toBe(sha256Hex(webp));
  });

  test("stops on a challenge", async () => {
    const fetcher = async () => new Response("captcha", { status: 403 });
    await expect(discoverAppFlows(url, "cookie", fetcher)).rejects.toMatchObject({ code: "MOBBIN_AUTH_REQUIRED" });
  });

  test("identifies Mobbin's authenticated-data-free fallback", async () => {
    const fetcher = async () => new Response(flightHtml({ buildId: "public-shell" }), { status: 200 });
    await expect(discoverAppFlows(url, "cookie", fetcher)).rejects.toMatchObject({ code: "MOBBIN_ACCESS_REQUIRED" });
  });
});

function flightHtml(value: unknown): string {
  const payload = JSON.stringify(value);
  return `<html><script>self.__next_f.push(${JSON.stringify([1, payload])})</script></html>`;
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
