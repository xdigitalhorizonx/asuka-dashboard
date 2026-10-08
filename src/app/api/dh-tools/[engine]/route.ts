import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The audit engine alone may run 180 s on digitalhorizon.dev; this relay has to outlive it.
export const maxDuration = 300;

const ENGINES = new Set(["proposal", "audit", "flyer"]);
const MAX_BODY = 64 * 1024;

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/dh-tools/<proposal|audit|flyer> — session-gated by proxy.ts.
 *
 * Relays the request to the matching document engine on digitalhorizon.dev
 * (/api/centraldogma/<engine>) with the shared DH_TOOLS_TOKEN, and streams its
 * server-sent events straight back. The engines themselves — prompts, PDF
 * templates, archive and email — live only in the digital-horizon repo, so
 * this tab and the Central Dogma console always run the same code.
 */
export async function POST(req: Request, { params }: { params: Promise<{ engine: string }> }) {
  const { engine } = await params;
  if (!ENGINES.has(engine)) return fail(404, "unknown engine");

  const token = process.env.DH_TOOLS_TOKEN || "";
  if (!token) return fail(503, "DH_TOOLS_TOKEN is not set on this deployment");
  const origin = (process.env.DH_TOOLS_ORIGIN || "https://digitalhorizon.dev").replace(/\/+$/, "");

  const body = await req.text();
  if (body.length > MAX_BODY) return fail(413, "request too large");

  let upstream: Response;
  try {
    upstream = await fetch(`${origin}/api/centraldogma/${engine}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
      cache: "no-store",
      // A redirect would drop the Authorization header; report it instead of following it.
      redirect: "manual",
    });
  } catch (err) {
    return fail(502, `Couldn't reach ${origin}: ${(err as Error).message}`);
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    return fail(502, `${origin} redirected to ${upstream.headers.get("location") ?? "?"} — set DH_TOOLS_ORIGIN to the final host`);
  }
  if (upstream.status === 401) {
    return fail(502, "digitalhorizon.dev refused the DH Tools token — DH_TOOLS_TOKEN must match on both Vercel projects");
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    let message = text.slice(0, 500);
    try {
      const j = JSON.parse(text) as { error?: unknown };
      if (typeof j.error === "string") message = j.error; // the engines answer { error } before streaming starts
    } catch {}
    return fail(upstream.status >= 400 ? upstream.status : 502, message || `engine answered ${upstream.status}`);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
