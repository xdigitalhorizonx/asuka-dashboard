import { NextResponse } from "next/server";
import { recordInbound, verifyDialpadJwt } from "@/lib/ops";
import { errorMessage } from "@/lib/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dialpad SMS webhook target (open in proxy.ts). Dialpad signs each event as an HS256
 * JWT with the webhook's secret (DIALPAD_WEBHOOK_SECRET); anything that doesn't verify
 * is refused. Only non-empty inbound texts from ASUKA_SMS_OWNERS are kept; Asuka
 * picks them up through /api/sync `sms_inbox`.
 */
export async function POST(req: Request) {
  const secret = process.env.DIALPAD_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "inbound texting is not configured" }, { status: 503 });
  const body = (await req.text()).trim();
  const event = verifyDialpadJwt(body, secret);
  if (!event) return NextResponse.json({ error: "bad signature" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, outcome: await recordInbound(event) });
  } catch (err) {
    // 5xx so Dialpad retries; recordInbound is idempotent per message id.
    return NextResponse.json({ error: errorMessage(err) || "store failed" }, { status: 500 });
  }
}
