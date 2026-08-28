export const MAX_WEBP_BYTES = 64 * 1024 * 1024;

export interface ImageDimensions {
  width: number;
  height: number;
}

export function webpDimensions(bytes: Uint8Array): ImageDimensions {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    throw new Error("Invalid WebP container");
  }

  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    return { width: 1 + uint24(bytes, 24), height: 1 + uint24(bytes, 27) };
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8),
      height: 1 + ((bytes[22]! & 0xc0) >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10),
    };
  }
  throw new Error(`Unsupported WebP chunk ${chunk || "unknown"}`);
}

export function validateWebp(bytes: Uint8Array): ImageDimensions {
  if (bytes.byteLength > MAX_WEBP_BYTES) throw new Error("WebP exceeds 64 MiB");
  const dimensions = webpDimensions(bytes);
  if (dimensions.width < 100 || dimensions.height < 100) throw new Error("WebP is smaller than 100x100");
  return dimensions;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}
