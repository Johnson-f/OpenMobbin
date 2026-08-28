import { Database } from "bun:sqlite";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../shared/hashing";

interface CookieRow {
  hostKey: string;
  name: string;
  plainValue: string;
  encryptedValue: Uint8Array;
}

interface DiaAuthOptions {
  profileDir: string;
  safeStorageService: string;
  passwordProvider?: (service: string) => Promise<string>;
}

export async function getDiaCookieHeader(options: DiaAuthOptions): Promise<string> {
  const source = join(options.profileDir, "Cookies");
  const tempDir = await mkdtemp(join(tmpdir(), "mobbin-cloud-auth-"));
  const copy = join(tempDir, "Cookies");
  try {
    await copyFile(source, copy);
    const password = await (options.passwordProvider ?? keychainPassword)(options.safeStorageService);
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const database = new Database(copy, { readonly: true, strict: true });
    let rows: CookieRow[];
    try {
      rows = database.query<CookieRow, []>(`
        SELECT
          host_key AS hostKey,
          name,
          COALESCE(value, '') AS plainValue,
          encrypted_value AS encryptedValue
        FROM cookies
        WHERE host_key IN ('mobbin.com', '.mobbin.com')
        ORDER BY host_key, name
      `).all();
    } finally {
      database.close();
    }
    const cookies = rows.flatMap((row) => {
      const encrypted = new Uint8Array(row.encryptedValue ?? []);
      const value = encrypted.byteLength > 0
        ? decryptChromiumCookieValue(row.hostKey, encrypted, key)
        : row.plainValue;
      return row.name && value ? [`${row.name}=${value}`] : [];
    });
    if (cookies.length === 0) throw new Error(`No Mobbin cookies found in ${source}`);
    return cookies.join("; ");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function decryptChromiumCookieValue(hostKey: string, encryptedValue: Uint8Array, key: Uint8Array): string {
  const buffer = Buffer.from(encryptedValue);
  if (buffer.subarray(0, 3).toString() !== "v10") return buffer.toString("utf8");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  let value = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
  const hostHash = sha256Hex(hostKey);
  if (value.length > 32 && value.subarray(0, 32).toString("hex") === hostHash) value = value.subarray(32);
  else if (value.length > 32 && hasBinaryPrefix(value.subarray(0, 32))) value = value.subarray(32);
  return value.toString("utf8");
}

async function keychainPassword(service: string): Promise<string> {
  const process = Bun.spawn(["security", "find-generic-password", "-w", "-s", service], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  if (code !== 0) throw new Error(`Could not read ${service} from macOS Keychain`);
  const password = stdout.trim();
  if (!password) throw new Error(`macOS Keychain returned an empty ${service} value`);
  return password;
}

function hasBinaryPrefix(bytes: Uint8Array): boolean {
  let nonPrintable = 0;
  for (const byte of bytes) if (byte < 0x20 || byte > 0x7e) nonPrintable += 1;
  return nonPrintable > 8;
}
