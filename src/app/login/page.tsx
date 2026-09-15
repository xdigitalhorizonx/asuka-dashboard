import type { CSSProperties } from "react";
import { MONO } from "@/lib/crm";

const inp: CSSProperties = {
  width: "100%",
  borderRadius: 7,
  border: "1px solid var(--color-border)",
  background: "var(--color-bg)",
  padding: "10px 12px",
  fontSize: 14,
  outline: "none",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; next?: string }>;
}) {
  const { e, next } = await searchParams;
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--color-bg)", color: "var(--color-text)", padding: 24 }}>
      <form method="post" action="/api/login" className="card" style={{ width: "min(360px, 100%)", padding: 28, display: "grid", gap: 14 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: "var(--color-primary)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 11, fontWeight: 500 }}>AL</div>
          <div>
            <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--color-primary)", fontFamily: MONO }}>GROKBOT · AGENT</div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Command Center</div>
          </div>
        </div>
        <p style={{ fontSize: 12, color: "var(--color-muted)", margin: 0 }}>Private board. Enter the access password to continue.</p>
        <input type="hidden" name="next" value={next ?? "/"} />
        <input type="password" name="password" placeholder="Password" autoComplete="current-password" autoFocus required style={inp} />
        {e && <p style={{ margin: 0, fontSize: 11, letterSpacing: "0.08em", color: "var(--color-primary)", fontFamily: MONO }}>WRONG PASSWORD</p>}
        <button className="btn btn-primary" style={{ padding: 10 }}>UNLOCK</button>
      </form>
    </main>
  );
}
