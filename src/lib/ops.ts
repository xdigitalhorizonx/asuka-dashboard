import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { ObjectExistsError, ROOT, listObjects, putObject, randomId, readObjectJson } from "./blobstore";

/**
 * Asuka's operations channel: texting (Dialpad) and the PIN-gated PC command queue.
 *
 * Everything here is write-once objects in Blob storage (see blobstore.ts), never the
 * board's JSON vault, so the browser's whole-board saves can't erase it and two writers
 * never race on one document:
 *
 *   ops/sms-in/<dialpad id>.json     an inbound text from an allowed sender
 *   ops/sms-ack/<dialpad id>.json    Asuka has handled that text
 *   ops/sms-out/<ts>-<rand>.json     an outbound text and Dialpad's answer
 *   ops/pc/<id>/cmd.json             a queued PC command (PIN kept only as a scrypt hash)
 *   ops/pc/<id>/claim.json           the PC agent picked it up (first claimer wins)
 *   ops/pc/<id>/result.json          what the PC agent reported back
 *
 * Secrets (Dialpad key, webhook secret, PC token) live only in Vercel env vars.
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

/** Numbers Asuka may text (ASUKA_SMS_TO, e.g. Brandon and Jeff). */
export function smsRecipients(): string[] {
  return numberList(process.env.ASUKA_SMS_TO);
}

/** Numbers whose inbound texts Asuka acts on (ASUKA_SMS_OWNERS, normally only Brandon). */
export function smsOwners(): string[] {
  return numberList(process.env.ASUKA_SMS_OWNERS);
}

export function smsStatus() {
  return {
    sendConfigured: !!(process.env.DIALPAD_API_KEY && process.env.DIALPAD_FROM && process.env.DIALPAD_USER_ID),
    inboundConfigured: !!process.env.DIALPAD_WEBHOOK_SECRET && smsOwners().length > 0,
    recipients: smsRecipients().length,
    pcConfigured: !!process.env.ASUKA_PC_TOKEN,
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

// ---------- outbound texts ----------

export interface SentSms {
  to: string;
  text: string;
  at: string;
  status: number | null;
  id: string | null;
  messageStatus: string | null;
  error: string | null;
}

const MAX_SMS_CHARS = 1600;

/** Send one text from Asuka's Dialpad line to an allowed recipient. */
export async function sendSms(to: string, text: string): Promise<SentSms> {
  const key = process.env.DIALPAD_API_KEY;
  const from = process.env.DIALPAD_FROM;
  const userId = process.env.DIALPAD_USER_ID;
  if (!key || !from || !userId) throw new OpsError("texting is not configured on this deployment", 503);
  if (!smsRecipients().includes(to)) throw new OpsError("recipient is not on ASUKA_SMS_TO", 403);
  const body = typeof text === "string" ? text.trim() : "";
  if (!body) throw new OpsError("text required");
  if (body.length > MAX_SMS_CHARS) throw new OpsError(`text over ${MAX_SMS_CHARS} characters; split it`);

  const base = (process.env.DIALPAD_API_BASE || "https://dialpad.com").replace(/\/+$/, "");
  let status: number | null = null;
  let resp: Record<string, unknown> = {};
  let error: string | null = null;
  try {
    const res = await fetch(`${base}/api/v2/sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        from_number: from,
        to_numbers: [to],
        user_id: Number(userId),
        text: body,
        infer_country_code: false,
      }),
    });
    status = res.status;
    const raw = await res.text();
    try {
      resp = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      resp = {};
    }
    if (!res.ok) error = raw.slice(0, 300) || `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const sent: SentSms = {
    to,
    text: body,
    at: new Date().toISOString(),
    status,
    id: resp.id != null ? String(resp.id) : null,
    messageStatus: typeof resp.message_status === "string" ? resp.message_status : null,
    error,
  };
  await putJsonOnce(`${OPS}/sms-out/${sent.at.replace(/[:.]/g, "-")}-${randomId(8)}.json`, sent);
  return sent;
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

export async function smsSent(limit = 50): Promise<SentSms[]> {
  const sent = await readAll<SentSms>(`${OPS}/sms-out/`);
  return sent
    .map((s) => s.value)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, limit);
}

// ---------- PC command queue ----------

export interface PcCommand {
  id: string;
  command: string;
  /** scrypt(pin, salt) — the PIN itself is never stored. */
  salt: string;
  hash: string;
  kdf: { N: number; r: number; p: number; keylen: number };
  createdAt: string;
  expiresAt: string;
}

export interface PcResult {
  id: string;
  status: "ok" | "error" | "rejected";
  output: string;
  at: string;
}

const KDF = { N: 1 << 15, r: 8, p: 1, keylen: 32 };
const PC_TTL_MS = 10 * 60 * 1000;
const COMMAND_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PIN_RE = /^\d{4,12}$/;

export function pinHash(pin: string, salt: Buffer, kdf = KDF): Buffer {
  return scryptSync(pin, salt, kdf.keylen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2 });
}

/** Queue a named command for the PC agent. The PC checks the PIN against its own local copy. */
export async function pcEnqueue(command: unknown, pin: unknown): Promise<{ id: string; command: string; expiresAt: string }> {
  const name = String(command ?? "").trim().toLowerCase();
  const code = String(pin ?? "").trim();
  if (!COMMAND_RE.test(name)) throw new OpsError("command must be a short name like `lock` or `status`");
  if (!PIN_RE.test(code)) throw new OpsError("pin must be 4 to 12 digits");
  const salt = randomBytes(16);
  const now = Date.now();
  const cmd: PcCommand = {
    id: `${new Date(now).toISOString().replace(/[:.]/g, "-")}-${randomId(10)}`,
    command: name,
    salt: salt.toString("base64"),
    hash: pinHash(code, salt).toString("base64"),
    kdf: KDF,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PC_TTL_MS).toISOString(),
  };
  await putJsonOnce(`${OPS}/pc/${cmd.id}/cmd.json`, cmd);
  return { id: cmd.id, command: cmd.command, expiresAt: cmd.expiresAt };
}

async function pcIndex() {
  const objs = await listObjects(`${OPS}/pc/`);
  const byId = new Map<string, Set<string>>();
  for (const o of objs) {
    const rest = o.pathname.slice(`${OPS}/pc/`.length).split("/");
    if (rest.length !== 2) continue;
    if (!byId.has(rest[0])) byId.set(rest[0], new Set());
    byId.get(rest[0])!.add(rest[1]);
  }
  return { objs, byId };
}

/** For the PC agent: claim every unexpired command nobody has claimed yet. */
export async function pcClaim(): Promise<PcCommand[]> {
  const { objs, byId } = await pcIndex();
  const out: PcCommand[] = [];
  for (const [id, files] of byId) {
    if (!files.has("cmd.json") || files.has("claim.json") || files.has("result.json")) continue;
    const obj = objs.find((o) => o.pathname === `${OPS}/pc/${id}/cmd.json`);
    const cmd = obj ? await readObjectJson<PcCommand>(obj) : null;
    if (!cmd || Date.parse(cmd.expiresAt) < Date.now()) continue;
    if (await putJsonOnce(`${OPS}/pc/${id}/claim.json`, { id, at: new Date().toISOString() })) out.push(cmd);
  }
  return out;
}

export async function pcReport(raw: unknown): Promise<PcResult> {
  const r = (raw ?? {}) as Partial<PcResult>;
  const id = String(r.id ?? "");
  if (!/^[A-Za-z0-9-]{10,80}$/.test(id)) throw new OpsError("id required");
  const status = r.status === "ok" || r.status === "error" || r.status === "rejected" ? r.status : null;
  if (!status) throw new OpsError("status must be ok, error or rejected");
  const { byId } = await pcIndex();
  if (!byId.get(id)?.has("claim.json")) throw new OpsError("unknown or unclaimed command", 404);
  const result: PcResult = { id, status, output: String(r.output ?? "").slice(0, 2000), at: new Date().toISOString() };
  if (!(await putJsonOnce(`${OPS}/pc/${id}/result.json`, result))) throw new OpsError("result already reported", 409);
  return result;
}

/** Recent commands with their state, newest first (for Asuka to report back). */
export async function pcStatus(limit = 20) {
  const { objs, byId } = await pcIndex();
  const ids = [...byId.keys()].sort().reverse().slice(0, limit);
  const out = [];
  for (const id of ids) {
    const files = byId.get(id)!;
    const cmdObj = objs.find((o) => o.pathname === `${OPS}/pc/${id}/cmd.json`);
    const resObj = objs.find((o) => o.pathname === `${OPS}/pc/${id}/result.json`);
    const cmd = cmdObj ? await readObjectJson<PcCommand>(cmdObj) : null;
    const res = resObj ? await readObjectJson<PcResult>(resObj) : null;
    const expired = !!cmd && !files.has("claim.json") && Date.parse(cmd.expiresAt) < Date.now();
    out.push({
      id,
      command: cmd?.command ?? null,
      createdAt: cmd?.createdAt ?? null,
      state: res ? res.status : files.has("claim.json") ? "claimed" : expired ? "expired" : "pending",
      output: res?.output ?? null,
    });
  }
  return out;
}
