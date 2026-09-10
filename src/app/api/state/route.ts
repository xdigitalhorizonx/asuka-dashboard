import { NextResponse } from "next/server";
import type { AppState } from "@/lib/types";
import { readState, writeState } from "@/lib/server-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = await readState();
    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read state" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { state?: AppState };
    if (!body?.state || typeof body.state !== "object") {
      return NextResponse.json({ error: "state required" }, { status: 400 });
    }
    const state = await writeState(body.state);
    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to write state" },
      { status: 500 }
    );
  }
}
