export interface ScreenSource {
  url: string;
  descriptor: string;
}

interface SourceSetItem {
  url?: string;
  descriptor?: string;
}

interface Sources {
  downloadableSrc?: string;
  src?: string;
  srcSet?: SourceSetItem[];
}

export function chooseBestImageSource(sources: Sources | null | undefined): ScreenSource | null {
  if (!sources) return null;
  if (typeof sources.downloadableSrc === "string") return { url: sources.downloadableSrc, descriptor: "downloadableSrc" };
  const best = Array.isArray(sources.srcSet)
    ? [...sources.srcSet].sort((left, right) => rank(right.descriptor) - rank(left.descriptor))[0]
    : undefined;
  if (best?.url) return { url: best.url, descriptor: best.descriptor || "srcSet" };
  if (typeof sources.src === "string") return { url: sources.src, descriptor: "src" };
  return null;
}

function rank(descriptor: string | undefined): number {
  const width = /^(\d+)w$/.exec(descriptor ?? "")?.[1];
  if (width) return Number(width);
  if (descriptor === "downloadableSrc") return 10_000;
  if (descriptor === "src") return 720;
  return 0;
}
