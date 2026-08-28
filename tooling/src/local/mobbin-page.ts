import { AppError } from "../shared/errors";
import type { RunPlan } from "../shared/schemas";

export interface ParsedMobbinApp {
  slug: string;
  name: string;
  id: string;
  versionId: string;
  platform: string;
  flowsUrl: string;
}

interface RawScreen {
  id?: string;
  screenId?: string;
  order?: number;
  restricted?: boolean;
  width?: number;
  height?: number;
}

interface RawFlow {
  id?: string;
  name?: string;
  appVersionPublishedAt?: string;
  restricted?: boolean;
  screens?: RawScreen[];
}

interface RawVersion {
  id?: string;
  createdAt?: string;
  publishedAt?: string;
}

export function parseMobbinAppUrl(pageUrl: string): ParsedMobbinApp {
  const url = new URL(pageUrl);
  const match = url.pathname.match(/^\/apps\/(.+)-([a-z]+)-([0-9a-f-]{36})\/([0-9a-f-]{36})\/(?:screens|ui-elements|flows)\/?$/i);
  if (!match) throw new AppError("INVALID_MOBBIN_URL", `Could not parse Mobbin app URL: ${pageUrl}`);
  const [, slug, platform, id, versionId] = match as [string, string, string, string, string];
  const flowsUrl = new URL(url);
  flowsUrl.pathname = `/apps/${slug}-${platform}-${id}/${versionId}/flows`;
  flowsUrl.search = "";
  flowsUrl.hash = "";
  return { slug, name: titleFromSlug(slug), id, versionId, platform, flowsUrl: flowsUrl.toString() };
}

export function parseAppPageHtml(html: string, app: ParsedMobbinApp): RunPlan {
  const chunks = extractNextFlightChunks(html);
  if (chunks.length === 0) throw new AppError("MOBBIN_AUTH_OR_PAYLOAD", "Mobbin returned no authenticated page payload", 401);
  const payload = chunks.join("\n");
  const rawFlows = findArrays<RawFlow>(payload, '"partialFlows":[{')
    .flat()
    .filter((flow) => flow.id && Array.isArray(flow.screens));
  const flows = [...new Map(rawFlows.map((flow) => [flow.id!, flow])).values()];
  if (flows.length === 0) {
    const authenticatedMarkers = payload.includes('"partialFlows":') || payload.includes('"appVersions":');
    if (!authenticatedMarkers) throw new AppError("MOBBIN_ACCESS_REQUIRED", "The Dia session lacks access to this Mobbin app; check login and plan access", 403);
    throw new AppError("MOBBIN_PAYLOAD_CHANGED", "Mobbin returned no flows for this app", 502);
  }

  const versions = findArrays<RawVersion>(payload, '"appVersions":[{').flat();
  const version = versions.find((candidate) => candidate.id === app.versionId);
  const publishedAt = version?.publishedAt ?? version?.createdAt ?? flows[0]?.appVersionPublishedAt ?? null;

  return {
    appSlug: app.slug,
    appName: app.name,
    mobbinAppId: app.id,
    platform: app.platform,
    version: {
      mobbinVersionId: app.versionId,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
      metadata: {},
    },
    flows: flows.map((flow) => {
      const ordered = [...(flow.screens ?? [])].sort((left, right) => Number(left.order ?? 0) - Number(right.order ?? 0));
      return {
        mobbinFlowId: flow.id!,
        name: String(flow.name || "Untitled flow"),
        restricted: Boolean(flow.restricted),
        metadata: {},
        screens: ordered.map((screen, index) => {
          const screenId = screen.screenId ?? screen.id;
          if (!screenId) throw new AppError("MOBBIN_PAYLOAD_CHANGED", `Flow ${flow.id} contains a screen without an ID`, 502);
          return {
            mobbinScreenId: screenId,
            position: index + 1,
            restricted: Boolean(screen.restricted ?? flow.restricted),
            metadata: {
              declaredWidth: screen.width ?? null,
              declaredHeight: screen.height ?? null,
            },
          };
        }),
      };
    }),
  };
}

export function extractNextFlightChunks(html: string): string[] {
  const chunks: string[] = [];
  const scriptRegex = /<script[^>]*>(self\.__next_f\.push\([\s\S]*?\))<\/script>/g;
  for (const match of html.matchAll(scriptRegex)) {
    const expression = match[1];
    if (!expression) continue;
    const jsonText = expression.slice("self.__next_f.push(".length, -1);
    try {
      const parsed = JSON.parse(jsonText) as unknown[];
      if (typeof parsed[1] === "string") chunks.push(parsed[1]);
    } catch {
      continue;
    }
  }
  return chunks;
}

function findArrays<T>(payload: string, marker: string): T[][] {
  const arrays: T[][] = [];
  let offset = 0;
  for (;;) {
    const markerIndex = payload.indexOf(marker, offset);
    if (markerIndex < 0) return arrays;
    const start = payload.indexOf("[", markerIndex);
    try {
      const parsed = JSON.parse(extractJsonArray(payload, start)) as T[];
      if (Array.isArray(parsed)) arrays.push(parsed);
    } catch {
      // Multiple Flight chunks can contain escaped partial copies.
    }
    offset = markerIndex + marker.length;
  }
}

function extractJsonArray(text: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaping) escaping = false;
      else if (character === "\\") escaping = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[") depth += 1;
    else if (character === "]" && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error("Could not find end of JSON array");
}

function titleFromSlug(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}
