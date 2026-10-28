import { createHmac, timingSafeEqual } from "crypto";
import { ObjectExistsError, ROOT, listObjects, putObject, readObjectJson } from "./blobstore";

/**
 * Asuka's operations channel: inbound texts from Dialpad.
 *
 * Everything here is write-once objects in Blob storage (see blobstore.ts), never the
 * board's JSON vault, so the browser's whole-board saves can't erase it and two writers
 * never race on one document:
 *
 *   ops/sms-in/<dialpad id>.json     an inbound text from an allowed sender
 *   ops/sms-ack/<dialpad id>.json    Asuka has handled that text
 *
 * Asuka sends texts herself; this deployment only receives them. The webhook secret
 * lives only in a Vercel env var.
 */

const OPS = `${ROOT}/ops`;

// ---------- config ----------

/** E.164 numbers, comma separated. */
function numberList(v: string | undefined): string[] {
  return (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\+\d{8,15}$/.test(s));
}

/** Numbers whose inbound texts Asuka acts on (ASUKA_SMS_OWNERS, normally only Brandon). */
export function smsOwners(): string[] {
  return numberList(process.env.ASUKA_SMS_OWNERS);
}

export function smsStatus() {
  return {
    inboundConfigured: !!process.env.DIALPAD_WEBHOOK_SECRET && smsOwners().length > 0,
  };
}

export class OpsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "OpsError";
  }
}

async function putJsonOnce(pathname: string, value: unknown): Promise<boolean> {
  try {
    await putObject(pathname, JSON.stringify(value), { contentType: "application/json" });
    return true;
  } catch (err) {
    if (err instanceof ObjectExistsError) return false;
    throw err;
  }
}

async function readAll<T>(prefix: string): Promise<{ pathname: string; uploadedAt: string; value: T }[]> {
  const objs = await listObjects(prefix);
  const out: { pathname: string; uploadedAt: string; value: T }[] = [];
  for (const o of objs) {
    const value = await readObjectJson<T>(o);
    if (value) out.push({ pathname: o.pathname, uploadedAt: o.uploadedAt, value });
  }
  return out;
}

// ---------- inbound texts ----------

export interface InboundSms {
  id: string;
  from: string;
  to: string;
  text: string;
  at: string;
  receivedAt: string;
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Verify Dialpad's HS256-signed webhook body and return its payload, or null. */
export function verifyDialpadJwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  try {
    const header = JSON.parse(b64urlDecode(h).toString("utf8")) as { alg?: string };
    if (header.alg !== "HS256") return null;
    const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
    const given = b64urlDecode(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(b64urlDecode(p).toString("utf8"));
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type InboundOutcome = "stored" | "duplicate" | "ignored";

/** Keep an inbound Dialpad SMS event if it's a non-empty text from an owner number. */
export async function recordInbound(event: Record<string, unknown>): Promise<InboundOutcome> {
  const direction = String(event.direction ?? "");
  const from = String(event.from_number ?? "");
  const text = typeof event.text === "string" ? event.text : "";
  const rawId = String(event.id ?? event.message_id ?? "");
  const id = rawId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (direction !== "inbound" || !id || !text.trim() || !smsOwners().includes(from)) return "ignored";
  const toRaw = event.to_number;
  const to = Array.isArray(toRaw) ? String(toRaw[0] ?? "") : String(toRaw ?? "");
  const createdMs = Number(event.created_date);
  const msg: InboundSms = {
    id,
    from,
    to,
    text,
    at: Number.isFinite(createdMs) && createdMs > 0 ? new Date(createdMs).toISOString() : new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  };
  return (await putJsonOnce(`${OPS}/sms-in/${id}.json`, msg)) ? "stored" : "duplicate";
}

/** Inbound texts Asuka hasn't acknowledged yet (or all of them), oldest first. */
export async function smsInbox(includeHandled = false): Promise<(InboundSms & { handled: boolean })[]> {
  const [msgs, acks] = await Promise.all([readAll<InboundSms>(`${OPS}/sms-in/`), listObjects(`${OPS}/sms-ack/`)]);
  const acked = new Set(acks.map((a) => a.pathname.slice(`${OPS}/sms-ack/`.length).replace(/\.json$/, "")));
  return msgs
    .map((m) => ({ ...m.value, handled: acked.has(m.value.id) }))
    .filter((m) => includeHandled || !m.handled)
    .sort((a, b) => (a.at < b.at ? -1 : 1));
}

export async function smsAck(ids: unknown): Promise<string[]> {
  const list = Array.isArray(ids) ? ids : [];
  const done: string[] = [];
  for (const raw of list) {
    const id = String(raw).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (!id) continue;
    await putJsonOnce(`${OPS}/sms-ack/${id}.json`, { id, at: new Date().toISOString() });
    done.push(id);
  }
  return done;
}
