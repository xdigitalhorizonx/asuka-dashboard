export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; next?: string }>;
}) {
  const { e, next } = await searchParams;
  return (
    <main className="stage" style={{ display: "grid", placeItems: "center" }}>
      <form method="post" action="/api/login" className="card" style={{ width: "min(380px, 100%)", padding: 28, display: "grid", gap: 14 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div className="badge-al">AL</div>
          <div style={{ minWidth: 0 }}>
            <div className="label" style={{ color: "var(--color-primary)" }}>Grokbot · Agent</div>
            <div style={{ fontSize: 19, fontWeight: 600, lineHeight: 1.2 }}>Command Center</div>
          </div>
        </div>
        <p style={{ fontSize: 15, color: "var(--color-muted)", margin: 0 }}>Private board. Enter the access password to continue.</p>
        <input type="hidden" name="next" value={next ?? "/"} />
        <input className="input" type="password" name="password" placeholder="Password" autoComplete="current-password" autoFocus required style={{ fontSize: 16 }} />
        {e && <p className="label" style={{ margin: 0, color: "var(--color-danger)" }}>Wrong password</p>}
        <button className="btn btn-primary" style={{ padding: 12 }}>Unlock</button>
      </form>
    </main>
  );
}
