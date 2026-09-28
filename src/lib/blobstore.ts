import { BlobError, del, get, head, list, put } from "@vercel/blob";
import { promises as fs } from "fs";
import path from "path";

/**
 * Object storage for everything that is NOT the board's one JSON vault:
 * attachments, invoices, payment records and uploaded proposals.
 *
 * Rules that keep this safe on Vercel Blob's CDN:
 *  - objects are written once and never overwritten (a change is a NEW object),
 *    so a CDN-cached read can never be stale;
 *  - "what exists" always comes from `list()` (the Blob API, not the CDN);
 *  - every pathname carries a random id, and blob URLs never leave the server —
 *    files reach the browser only through session-gated or token-gated routes.
 *
 * Without BLOB_READ_WRITE_TOKEN (local dev) objects live under
 * ./.asuka-local-blobs (gitignored), mirroring the same semantics.
 */

export const ROOT = "asuka-command-center";

export type StoreMode = "vercel" | "local" | "none";

export interface StoredObject {
  pathname: string;
  size: number;
  uploadedAt: string;
  /** Vercel Blob URL (server-side only; never sent to a browser). */
  url?: string;
}

export class ObjectExistsError extends Error {
  constructor(pathname: string) {
    super(`object already exists: ${pathname}`);
    this.name = "ObjectExistsError";
  }
}

const blobToken = () => process.env.BLOB_READ_WRITE_TOKEN || "";
const LOCAL_DIR = path.join(process.cwd(), ".asuka-local-blobs");

export function storeMode(): StoreMode {
  if (blobToken()) return "vercel";
  return process.env.NODE_ENV !== "production" ? "local" : "none";
}

function requireMode(): Exclude<StoreMode, "none"> {
  const mode = storeMode();
  if (mode === "none") throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  return mode;
}

/** Pathnames are built by this app only; still refuse anything that could escape the local dir. */
function assertSafePathname(p: string) {
  if (!p.startsWith(`${ROOT}/`) || p.includes("..") || p.includes("\\") || p.includes("\0") || p.endsWith("/")) {
    throw new Error(`unsafe storage pathname: ${p}`);
  }
}

function localPath(p: string): string {
  assertSafePathname(p);
  return path.join(LOCAL_DIR, ...p.split("/"));
}

const META_SUFFIX = ".__meta.json";

export async function putObject(
  pathname: string,
  body: Buffer | Uint8Array | string,
  opts: { contentType: string }
): Promise<StoredObject> {
  assertSafePathname(pathname);
  const mode = requireMode();
  if (mode === "local") {
    const file = localPath(pathname);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(file, body, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new ObjectExistsError(pathname);
      throw err;
    }
    const uploadedAt = new Date().toISOString();
    await fs.writeFile(file + META_SUFFIX, JSON.stringify({ contentType: opts.contentType, uploadedAt }));
    const size = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
    return { pathname, size, uploadedAt };
  }
  try {
    const r = await put(pathname, typeof body === "string" ? body : Buffer.from(body), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: opts.contentType,
      token: blobToken(),
    });
    const size = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
    return { pathname: r.pathname, size, uploadedAt: new Date().toISOString(), url: r.url };
  } catch (err) {
    // The API's "already exists" answer isn't a dedicated error class; confirm with head().
    if (err instanceof BlobError && (await existsVercel(pathname))) throw new ObjectExistsError(pathname);
    throw err;
  }
}

async function existsVercel(pathname: string): Promise<boolean> {
  try {
    await head(pathname, { token: blobToken() });
    return true;
  } catch {
    return false;
  }
}

/** Every object under `prefix` (paginated), oldest first by pathname. */
export async function listObjects(prefix: string): Promise<StoredObject[]> {
  if (!prefix.startsWith(`${ROOT}/`) || prefix.includes("..")) throw new Error(`unsafe prefix: ${prefix}`);
  const mode = requireMode();
  const out: StoredObject[] = [];
  if (mode === "local") {
    // Walk the directory the prefix lives in, then filter by the full prefix.
    const dirPart = prefix.slice(0, prefix.lastIndexOf("/"));
    await walkLocal(path.join(LOCAL_DIR, ...dirPart.split("/")), out);
    return out
      .filter((o) => o.pathname.startsWith(prefix))
      .sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
  }
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const r = await list({ prefix, cursor, limit: 1000, token: blobToken() });
    for (const b of r.blobs) {
      out.push({ pathname: b.pathname, size: b.size, uploadedAt: new Date(b.uploadedAt).toISOString(), url: b.url });
    }
    if (!r.hasMore || !r.cursor) break;
    cursor = r.cursor;
  }
  return out.sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
}

async function walkLocal(dir: string, out: StoredObject[]) {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkLocal(full, out);
    } else if (!e.name.endsWith(META_SUFFIX)) {
      const rel = path.relative(LOCAL_DIR, full).split(path.sep).join("/");
      const stat = await fs.stat(full);
      let uploadedAt = stat.mtime.toISOString();
      try {
        uploadedAt = (JSON.parse(await fs.readFile(full + META_SUFFIX, "utf8")) as { uploadedAt?: string }).uploadedAt || uploadedAt;
      } catch {
        // no sidecar — mtime is close enough
      }
      out.push({ pathname: rel, size: stat.size, uploadedAt });
    }
  }
}

export interface ObjectBody {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  size: number;
}

/** Stream an object's bytes (for downloads). null when it no longer exists. */
export async function openObject(obj: StoredObject): Promise<ObjectBody | null> {
  const mode = requireMode();
  if (mode === "local") {
    const file = localPath(obj.pathname);
    let buf: Buffer;
    try {
      buf = await fs.readFile(file);
    } catch {
      return null;
    }
    let contentType = "application/octet-stream";
    try {
      contentType = (JSON.parse(await fs.readFile(file + META_SUFFIX, "utf8")) as { contentType?: string }).contentType || contentType;
    } catch {
      // keep the generic type
    }
    return {
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(buf));
          c.close();
        },
      }),
      contentType,
      size: buf.byteLength,
    };
  }
  const r = await get(obj.url || obj.pathname, { access: "public", token: blobToken() });
  if (!r || r.statusCode !== 200) return null;
  return { stream: r.stream, contentType: r.blob.contentType, size: r.blob.size || obj.size };
}

/** Whole object as a Buffer (small JSON documents, proposal PDFs). */
export async function readObjectBytes(obj: StoredObject): Promise<Buffer | null> {
  const body = await openObject(obj);
  if (!body) return null;
  return Buffer.from(await new Response(body.stream).arrayBuffer());
}

export async function readObjectJson<T>(obj: StoredObject): Promise<T | null> {
  const bytes = await readObjectBytes(obj);
  if (!bytes) return null;
  return JSON.parse(bytes.toString("utf8")) as T;
}

export async function deleteObjects(objs: StoredObject[]): Promise<void> {
  if (!objs.length) return;
  const mode = requireMode();
  if (mode === "local") {
    for (const o of objs) {
      const file = localPath(o.pathname);
      await fs.rm(file, { force: true });
      await fs.rm(file + META_SUFFIX, { force: true });
    }
    return;
  }
  await del(
    objs.map((o) => o.url || o.pathname),
    { token: blobToken() }
  );
}

/** URL-safe random id from a CSPRNG (62-symbol alphabet, rejection-sampled so it stays uniform). */
export function randomId(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const out: string[] = [];
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < 248 && out.length < length) out.push(alphabet[b % 62]);
    }
  }
  return out.join("");
}
