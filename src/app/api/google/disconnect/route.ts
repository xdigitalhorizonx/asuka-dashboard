import { NextResponse } from "next/server";
import { readState, writeState } from "@/lib/server-state";
import { decryptToken, googleStatus, revokeToken } from "@/lib/google";
import { clientPayload, errorMessage, listReminders } from "@/lib/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/google/disconnect — revoke the vault-stored grant and forget it.
 * A token supplied through GOOGLE_TASKS_REFRESH_TOKEN can only be removed in Vercel.
 */
export async function POST() {
  try {
    const current = await readState();
    if (current.google) {
      try {
        await revokeToken(await decryptToken(current.google.refreshTokenEnc));
      } catch {
        // undecryptable (key changed) — forgetting it is still the right outcome
      }
    }
    const { google: _dropped, ...rest } = current;
    void _dropped;
    const state = await writeState(rest);
    return NextResponse.json(clientPayload(state, await listReminders(state), { google: googleStatus(state) }));
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) || "disconnect failed" }, { status: 500 });
  }
}
