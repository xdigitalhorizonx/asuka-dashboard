import { createHash } from "crypto";
import { deleteObjects, listObjects, ObjectExistsError, putObject, type StoredObject } from "./blobstore";
import { FILES_PREFIX, filePathname, parseFilePathname, type FileEntry } from "./files-shared";
import type { AppState, Attachment } from "./types";

/**
 * Attachments tab storage. Each file is its own immutable object at
 * `asuka-command-center/files/<id>/<name>`; the list of files IS the storage
 * listing, so there is no index to fall out of sync and nothing in the board's
 * JSON vault to overwrite.
 */

export type StoredFile = FileEntry & { obj: StoredObject };

export async function listFiles(): Promise<StoredFile[]> {
  const objs = await listObjects(FILES_PREFIX);
  const out: StoredFile[] = [];
  for (const obj of objs) {
    const p = parseFilePathname(obj.pathname);
    if (p) out.push({ id: p.id, name: p.name, size: obj.size, uploadedAt: obj.uploadedAt, obj });
  }
  return out.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0));
}

export async function findFile(id: string): Promise<StoredFile | null> {
  const objs = await listObjects(`${FILES_PREFIX}${id}/`);
  for (const obj of objs) {
    const p = parseFilePathname(obj.pathname);
    if (p && p.id === id) return { id: p.id, name: p.name, size: obj.size, uploadedAt: obj.uploadedAt, obj };
  }
  return null;
}

export async function deleteFile(id: string): Promise<boolean> {
  const objs = await listObjects(`${FILES_PREFIX}${id}/`);
  if (!objs.length) return false;
  await deleteObjects(objs);
  return true;
}

export async function saveFile(id: string, name: string, bytes: Buffer | Uint8Array, contentType: string): Promise<StoredObject> {
  return putObject(filePathname(id, name), bytes, { contentType: contentType || "application/octet-stream" });
}

function decodeDataUrl(dataUrl: string): { bytes: Buffer; mime: string } | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const bytes = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
  return { bytes, mime };
}

/**
 * The id a legacy vault attachment gets as a file: deterministic (a second run
 * finds the object already there instead of duplicating it) but not guessable
 * from the vault alone, since it is keyed with a server secret.
 */
function legacyFileId(a: Attachment): string {
  const key = process.env.BLOB_READ_WRITE_TOKEN || process.env.ASUKA_SESSION_SECRET || "local";
  const hex = createHash("sha256").update(`${key}:legacy-attachment:${a.id}`).digest("hex");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 32 && id.length < 16; i += 2) id += alphabet[parseInt(hex.slice(i, i + 2), 16) % 62];
  return id;
}

/**
 * Before this fix, attachments were stored as base64 data URLs inside the board's
 * JSON vault. Move any that are still there into file storage. Returns the ids of
 * the vault attachments that are now safely stored as files (the caller removes
 * exactly those from the vault).
 */
export async function migrateLegacyAttachments(state: AppState): Promise<Set<string>> {
  const moved = new Set<string>();
  for (const a of state.attachments) {
    if (typeof a?.dataUrl !== "string") continue;
    const decoded = decodeDataUrl(a.dataUrl);
    if (!decoded) continue;
    try {
      await saveFile(legacyFileId(a), a.name || "attachment", decoded.bytes, a.mime || decoded.mime);
      moved.add(a.id);
    } catch (err) {
      if (err instanceof ObjectExistsError) moved.add(a.id);
      else console.error(`legacy attachment ${a.id} not migrated:`, err);
    }
  }
  return moved;
}
