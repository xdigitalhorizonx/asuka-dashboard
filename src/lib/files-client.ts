"use client";

import { useEffect, useSyncExternalStore } from "react";
import { upload } from "@vercel/blob/client";
import { filePathname, MULTIPART_OVER_BYTES, newFileId, safeFileName, type FileEntry } from "./files-shared";

/**
 * Attachments in the browser: one shared snapshot (the Overview tile and the
 * Attachments tab read the same list) plus the upload queue with progress.
 * Files are uploaded straight to storage, then the list is re-read from the server —
 * nothing about a file is kept only in this tab.
 */

export type FilesMode = "vercel" | "local" | "none" | "unknown";

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  /** 0–100 */
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
}

export interface FilesSnapshot {
  files: FileEntry[];
  mode: FilesMode;
  maxBytes: number;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  uploads: UploadItem[];
}

const INITIAL: FilesSnapshot = { files: [], mode: "unknown", maxBytes: 0, loaded: false, loading: false, error: null, uploads: [] };
let snap: FilesSnapshot = INITIAL;
let loadedAt = 0;
const listeners = new Set<() => void>();

function set(patch: Partial<FilesSnapshot> | ((s: FilesSnapshot) => Partial<FilesSnapshot>)) {
  snap = { ...snap, ...(typeof patch === "function" ? patch(snap) : patch) };
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function refreshFiles(): Promise<void> {
  set({ loading: true });
  try {
    const res = await fetch("/api/files", { cache: "no-store" });
    const j = (await res.json().catch(() => ({}))) as { files?: FileEntry[]; mode?: FilesMode; maxBytes?: number; error?: string };
    loadedAt = Date.now();
    set({
      files: Array.isArray(j.files) ? j.files : snap.files,
      mode: j.mode ?? snap.mode,
      maxBytes: j.maxBytes ?? snap.maxBytes,
      loaded: true,
      loading: false,
      error: res.ok ? null : j.error || `HTTP ${res.status}`,
    });
  } catch {
    set({ loading: false, loaded: true, error: "offline" });
  }
}

/** The shared list; re-read from the server when the caller mounts and the copy is over a minute old. */
export function useFiles(): FilesSnapshot {
  const s = useSyncExternalStore(subscribe, () => snap, () => INITIAL);
  useEffect(() => {
    if (Date.now() - loadedAt > 60_000) void refreshFiles();
  }, []);
  return s;
}

function patchUpload(key: string, patch: Partial<UploadItem>) {
  set((s) => ({ uploads: s.uploads.map((u) => (u.key === key ? { ...u, ...patch } : u)) }));
}

async function uploadOne(file: File, key: string): Promise<void> {
  const id = newFileId();
  if (snap.mode === "vercel") {
    await upload(filePathname(id, file.name), file, {
      access: "public",
      handleUploadUrl: "/api/files/upload",
      multipart: file.size > MULTIPART_OVER_BYTES,
      ...(file.type ? { contentType: file.type } : {}),
      onUploadProgress: ({ percentage }) => patchUpload(key, { progress: Math.min(99, Math.round(percentage)) }),
    });
    return;
  }
  // Local dev: the bytes go through the app's own route.
  const res = await fetch("/api/files", {
    method: "POST",
    headers: { "x-file-id": id, "x-file-name": encodeURIComponent(file.name), "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `HTTP ${res.status}`);
  }
}

/** Upload files (three at a time), then refresh the list from the server. */
export async function uploadFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  if (!snap.loaded || snap.mode === "unknown") await refreshFiles();
  const items: UploadItem[] = files.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, size: f.size, progress: 0, status: "uploading" }));
  set((s) => ({ uploads: [...items, ...s.uploads.filter((u) => u.status === "uploading")] }));

  const queue = files.map((f, i) => ({ file: f, key: items[i].key }));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { file, key } = job;
      if (snap.mode === "none") {
        patchUpload(key, { status: "error", error: "File storage isn't configured on this deployment" });
        continue;
      }
      if (snap.maxBytes && file.size > snap.maxBytes) {
        patchUpload(key, { status: "error", error: `Too large — max ${Math.round(snap.maxBytes / 1024 / 1024)} MB` });
        continue;
      }
      try {
        await uploadOne(file, key);
        patchUpload(key, { status: "done", progress: 100 });
      } catch (err) {
        patchUpload(key, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  await refreshFiles();
  // Finished rows linger briefly as confirmation; failures stay until dismissed.
  window.setTimeout(() => set((s) => ({ uploads: s.uploads.filter((u) => !(u.status === "done" && items.some((i) => i.key === u.key))) })), 2500);
}

export function dismissUpload(key: string) {
  set((s) => ({ uploads: s.uploads.filter((u) => u.key !== key) }));
}

/** Delete on the server first; the row only disappears once storage confirms. */
export async function removeFile(id: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      return j.error || `HTTP ${res.status}`;
    }
    set((s) => ({ files: s.files.filter((f) => f.id !== id) }));
    return null;
  } catch {
    return "offline";
  }
}

export type LegacyAttachment = { name: string; mime: string; size: number; dataUrl: string };

/** Turn old-format attachments (base64 data URLs) back into real uploads. */
export async function uploadDataUrls(items: Omit<LegacyAttachment, "size">[]): Promise<void> {
  const files: File[] = [];
  for (const a of items) {
    try {
      const blob = await (await fetch(a.dataUrl)).blob();
      files.push(new File([blob], a.name || "attachment", { type: a.mime || blob.type }));
    } catch {
      // skip an unreadable entry
    }
  }
  await uploadFiles(files);
}

/**
 * Upload attachments that only ever lived in this browser's localStorage, skipping
 * any already in storage (same safe name + size — e.g. moved there from the vault).
 */
export async function rescueLocalAttachments(items: LegacyAttachment[]): Promise<void> {
  await refreshFiles();
  if (snap.error || snap.mode === "none") return;
  const have = new Set(snap.files.map((f) => `${f.name}\u0000${f.size}`));
  const missing = items.filter((a) => !have.has(`${safeFileName(a.name)}\u0000${a.size}`));
  if (missing.length) await uploadDataUrls(missing);
}
