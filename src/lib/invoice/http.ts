import { NextResponse } from "next/server";
import { InvoiceConflictError } from "./store";
import { InvoiceInputError } from "./validate";
import { PayError } from "./payments";
import { errorMessage } from "../reminders";

/** Map invoice-layer errors to JSON responses with honest messages. */
export function invoiceErrorResponse(err: unknown, fallback: string): NextResponse {
  if (err instanceof PayError) return NextResponse.json({ error: err.message, ...err.extra }, { status: err.status });
  if (err instanceof InvoiceInputError) return NextResponse.json({ error: err.message }, { status: 400 });
  if (err instanceof InvoiceConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
  console.error(fallback, err);
  return NextResponse.json({ error: errorMessage(err) || fallback }, { status: 502 });
}

/** Where share links point: INVOICE_PUBLIC_ORIGIN if set, else the host this request came in on. */
export function publicOrigin(req: Request): string {
  const configured = (process.env.INVOICE_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
  if (/^https?:\/\/[^/]+$/.test(configured)) return configured;
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || u.host;
  const proto = req.headers.get("x-forwarded-proto") || u.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function invoiceUrl(origin: string, id: string): string {
  return `${origin}/i/${id}`;
}
