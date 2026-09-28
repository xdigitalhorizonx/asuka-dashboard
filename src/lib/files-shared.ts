/**
 * Attachment naming rules shared by the browser (which picks the upload path) and
 * the server (which only signs upload tokens for paths that follow them).
 */

export const FILES_PREFIX = "asuka-command-center/files/";
/** Per-file cap for the Attachments tab. */
export const FILE_MAX_BYTES = 100 * 1024 * 1024;
/** Files bigger than this go up in parallel parts. */
export const MULTIPART_OVER_BYTES = 8 * 1024 * 1024;

const ID_RE = /^[A-Za-z0-9]{16}$/;
const PATH_RE = /^asuka-command-center\/files\/([A-Za-z0-9]{16})\/([^/]{1,120})$/;

export interface FileEntry {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
}

/**
 * A storage-safe version of a file name: accents folded, anything outside
 * letters/digits/space/._()- replaced with "-", extension kept, ≤120 chars.
 * The result is also what the Attachments list displays.
 */
export function safeFileName(name: string): string {
  const cleaned = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ._()-]+/g, "-")
    // Tidy runs left behind: "a - - b" → "a - b", "a--b" → "a-b", "a  b" → "a b".
    .replace(/[\s-]{2,}/g, (run) => (/\s/.test(run) ? (run.includes("-") ? " - " : " ") : "-"))
    .trim()
    .replace(/^[.\- ]+/, "");
  if (!cleaned) return "file";
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 120 - ext.length).trimEnd() + ext;
}

export function isFileId(id: string): boolean {
  return ID_RE.test(id);
}

export function filePathname(id: string, name: string): string {
  return `${FILES_PREFIX}${id}/${safeFileName(name)}`;
}

/** null unless the pathname is exactly `<prefix><16-char id>/<safe name>`. */
export function parseFilePathname(p: string): { id: string; name: string } | null {
  const m = PATH_RE.exec(p);
  if (!m || safeFileName(m[2]) !== m[2]) return null;
  return { id: m[1], name: m[2] };
}

/** 16 random URL-safe characters from the browser's or Node's CSPRNG. */
export function newFileId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < 16) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < 248 && out.length < 16) out += alphabet[b % 62];
    }
  }
  return out;
}
