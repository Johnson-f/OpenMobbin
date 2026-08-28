import { AppError } from "../shared/errors";
import { sha256Hex } from "../shared/hashing";
import { validateWebp } from "../shared/image";
import type { RunPlan, ScreenUploadMetadata } from "../shared/schemas";
import { parseAppPageHtml, parseMobbinAppUrl } from "./mobbin-page";
import { chooseBestImageSource } from "./screen-source";

const userAgent = "Mozilla/5.0 (compatible; MobbinCloudExporter/1.0)";
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FetchedScreen {
  bytes: Uint8Array;
  metadata: ScreenUploadMetadata;
}

export async function discoverAppFlows(pageUrl: string, cookie: string, fetcher: FetchLike = fetch): Promise<RunPlan> {
  const app = parseMobbinAppUrl(pageUrl);
  const response = await fetchWithNetworkRetry(app.flowsUrl, {
    redirect: "follow",
    cache: "no-store",
    headers: { cookie, "user-agent": userAgent, accept: "text/html,application/xhtml+xml" },
  }, fetcher);
  const html = await response.text();
  classifyMobbinResponse(response, html);
  return parseAppPageHtml(html, app);
}

export async function fetchScreenWebp(screenId: string, cookie: string, fetcher: FetchLike = fetch): Promise<FetchedScreen> {
  const infoResponse = await fetcher("https://mobbin.com/api/screen/fetch-screen-info", {
    method: "POST",
    cache: "no-store",
    headers: { cookie, "user-agent": userAgent, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ screenId }),
  });
  const info = await readJson(infoResponse);
  if (!infoResponse.ok || isRecord(info.error)) {
    throw mobbinHttpError("SCREEN_INFO_FAILED", infoResponse.status, errorMessage(info));
  }
  const value = isRecord(info.value) ? info.value : {};
  const source = chooseBestImageSource(isRecord(value.screenCdnImgSources) ? value.screenCdnImgSources : null);
  if (!source) throw new AppError("SCREEN_SOURCE_MISSING", `Mobbin returned no full-size image for screen ${screenId}`, 502);

  const imageResponse = await fetcher(source.url, {
    redirect: "follow",
    cache: "no-store",
    headers: { "user-agent": userAgent, accept: "image/webp,image/*" },
  });
  if (!imageResponse.ok) throw mobbinHttpError("SCREEN_FETCH_FAILED", imageResponse.status, imageResponse.statusText);
  const contentType = (imageResponse.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (contentType !== "image/webp") throw new AppError("SCREEN_NOT_WEBP", `Expected image/webp for screen ${screenId}`, 502);
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  const dimensions = validateWebp(bytes);
  return {
    bytes,
    metadata: {
      mobbinScreenId: screenId,
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
      width: dimensions.width,
      height: dimensions.height,
      contentType: "image/webp",
      descriptor: source.descriptor,
    },
  };
}

async function fetchWithNetworkRetry(url: string, init: RequestInit, fetcher: FetchLike): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetcher(url, init);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await Bun.sleep(250 * attempt);
    }
  }
  throw lastError;
}

function classifyMobbinResponse(response: Response, html: string): void {
  if (response.status === 429) throw new AppError("MOBBIN_RATE_LIMIT", "Mobbin rate limited the request", 429, true);
  if (response.status === 401 || response.status === 403) throw new AppError("MOBBIN_AUTH_REQUIRED", "Dia's Mobbin session is no longer authorized", 401);
  if (!response.ok) throw new AppError("MOBBIN_PAGE_FAILED", `Mobbin page request failed with ${response.status}`, 502, response.status >= 500);
  const path = response.url ? new URL(response.url).pathname : "";
  if (/sign[-_]?in|login/i.test(path) || /cf-chl-|turnstile|captcha/i.test(html)) {
    throw new AppError("MOBBIN_CHALLENGE", "Mobbin requires browser authentication or a challenge", 401);
  }
}

function mobbinHttpError(code: string, status: number, detail: string): AppError {
  if (status === 429) return new AppError("MOBBIN_RATE_LIMIT", "Mobbin rate limited the request", 429, true);
  if (status === 401 || status === 403) return new AppError("MOBBIN_AUTH_REQUIRED", "Dia's Mobbin session is no longer authorized", 401);
  return new AppError(code, `${code}: ${status}${detail ? ` ${detail}` : ""}`, 502, status >= 500);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    throw new AppError("MOBBIN_INVALID_JSON", `Mobbin returned invalid JSON with ${response.status}`, 502);
  }
}

function errorMessage(payload: Record<string, unknown>): string {
  const error = isRecord(payload.error) ? payload.error : {};
  return typeof error.message === "string" ? error.message : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
