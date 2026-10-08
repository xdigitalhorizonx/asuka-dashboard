"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { tint } from "@/lib/crm";
import { haptic } from "@/lib/haptics";

/**
 * DH Tools — the proposal, audit and flyer engines from Central Dogma on digitalhorizon.dev.
 *
 * Each run goes through /api/dh-tools/<engine>, which relays to the real engine there, so the
 * output (streamed JSON draft → branded PDF in the DH archive → optional email) is identical to
 * the console's. As on the console, all three engines stay mounted: switching the dropdown — or
 * another dock section, see Dashboard — only hides a pane, so a run keeps streaming meanwhile.
 */

type EngineKey = "proposal" | "audit" | "flyer";
type Phase = "idle" | "fetching" | "analyzing" | "drafting" | "parsing" | "rendering" | "uploading" | "emailing" | "done" | "error";
type Email = { sent: boolean; reason?: string; to?: string };
type Result = { headline: string; pdfUrl: string; email: Email };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^(?:https?:\/\/)?[\w.-]+\.[a-z]{2,}/i;

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Ready",
  fetching: "Fetching site",
  analyzing: "Analyzing signals",
  drafting: "Drafting",
  parsing: "Parsing",
  rendering: "Rendering PDF",
  uploading: "Archiving",
  emailing: "Emailing",
  done: "Complete",
  error: "Error",
};

interface EngineDef {
  key: EngineKey;
  label: string;
  steps: Phase[];
  hint: string;
  /** Run in the background — what the dropdown says while this engine is busy and hidden. */
  busyLabel: string;
}

const ENGINES: EngineDef[] = [
  {
    key: "proposal",
    label: "Proposal engine",
    steps: ["drafting", "parsing", "rendering", "uploading", "emailing"],
    hint: "Describe the client and the engagement. Example: “Generate a proposal for Tahoe Luxury, a luxury rental company in Lake Tahoe. Standard web + SEO bundle.”",
    busyLabel: "Proposal — running",
  },
  {
    key: "audit",
    label: "Audit engine",
    steps: ["fetching", "analyzing", "parsing", "rendering", "uploading", "emailing"],
    hint: "Paste a URL. The site gets fetched, scored and emailed to the recipient as a 5-page branded PDF.",
    busyLabel: "Audit — running",
  },
  {
    key: "flyer",
    label: "Flyer engine",
    steps: ["drafting", "parsing", "rendering", "uploading", "emailing"],
    hint: "Describe the audience or offer. Example: “One-sheet flyer for Carson City home-service businesses. Lead with our 7-day launch timeline.”",
    busyLabel: "Flyer — running",
  },
];

const isWorking = (p: Phase) => p !== "idle" && p !== "done" && p !== "error";

export function DhTools() {
  const [engine, setEngine] = useState<EngineKey>("proposal");
  const [busy, setBusy] = useState<Record<EngineKey, boolean>>({ proposal: false, audit: false, flyer: false });
  const onBusy = useCallback((k: EngineKey, b: boolean) => setBusy((cur) => (cur[k] === b ? cur : { ...cur, [k]: b })), []);

  return (
    <section className="card" style={{ padding: 18, display: "grid", gap: 16, boxShadow: `inset 0 2px 0 0 ${tint("var(--color-blue)", 70)}, var(--shadow-card)` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: "1 1 260px" }}>
          <span className="label">Engine</span>
          <select className="input" aria-label="Engine" value={engine} onChange={(e) => { setEngine(e.target.value as EngineKey); haptic("tap"); }} style={{ maxWidth: 280, cursor: "pointer" }}>
            {ENGINES.map((e) => (
              <option key={e.key} value={e.key}>
                {busy[e.key] && e.key !== engine ? e.busyLabel : e.label}
              </option>
            ))}
          </select>
        </label>
        <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
          Runs on digitalhorizon.dev · PDFs land in the Central Dogma archive
        </span>
      </div>

      {ENGINES.map((def) => (
        <div key={def.key} hidden={def.key !== engine}>
          <EnginePane def={def} onBusy={onBusy} />
        </div>
      ))}
    </section>
  );
}

function EnginePane({ def, onBusy }: { def: EngineDef; onBusy: (k: EngineKey, busy: boolean) => void }) {
  const [prompt, setPrompt] = useState("");
  const [url, setUrl] = useState("");
  const [recipient, setRecipient] = useState("");
  const [instructions, setInstructions] = useState("");
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [reached, setReached] = useState<Phase[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const outRef = useRef<HTMLDivElement>(null);
  const audit = def.key === "audit";
  const working = isWorking(phase);

  useEffect(() => onBusy(def.key, working), [def.key, working, onBusy]);
  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [draft]);

  // Same rules as the console: audits need a URL and a recipient; proposals and flyers need a
  // prompt, and an empty recipient falls back to the engine's default inbox.
  const r = recipient.trim();
  const recipientValid = audit ? EMAIL_RE.test(r) : r === "" || EMAIL_RE.test(r);
  const urlValid = URL_RE.test(url.trim());
  const canSubmit = !working && recipientValid && (audit ? urlValid : prompt.trim().length > 0);
  const problem = audit && url.trim() && !urlValid ? "That URL doesn't look right." : r && !EMAIL_RE.test(r) ? "That email doesn't look right." : null;
  const hint = audit && !r ? "Audits need a recipient" : "Ctrl / ⌘ + Enter runs it";

  function advance(next: Phase) {
    setPhase(next);
    if (def.steps.includes(next)) setReached((cur) => (cur.includes(next) ? cur : [...cur, next]));
  }

  async function submit() {
    if (!canSubmit) return;
    haptic("tap");
    setDraft("");
    setResult(null);
    setError(null);
    setReached([]);
    advance(def.steps[0]);

    const body = audit
      ? { url: url.trim(), recipient: r, instructions: instructions.trim() || null }
      : { prompt: prompt.trim(), recipient: r || null };

    let finished = false;
    const handle = (event: string, data: Record<string, unknown>) => {
      if (event === "delta") setDraft((d) => d + (typeof data.text === "string" ? data.text : ""));
      else if (event === "status" && typeof data.phase === "string" && data.phase in PHASE_LABEL) advance(data.phase as Phase);
      else if (event === "done") {
        finished = true;
        const email = (data.email ?? { sent: false, reason: "no email result" }) as Email;
        const pdfUrl = String(data.pdfUrl ?? "");
        const a = data.audit as { clientName?: string; grade?: string } | undefined;
        const p = (data.proposal ?? data.flyer) as { client?: string } | undefined;
        const headline = audit
          ? `${a?.clientName ?? "Site"} — grade ${a?.grade ?? "?"}`
          : `${def.key === "proposal" ? "Proposal" : "Flyer"} for ${p?.client ?? "client"}`;
        setResult({ headline, pdfUrl, email });
        advance("done");
        haptic("save");
        // Ready for the next one; the result card (with its PDF link) stays until the next run.
        setPrompt("");
        setUrl("");
        setDraft("");
      } else if (event === "error") {
        finished = true;
        setError(typeof data.message === "string" ? data.message : "Unknown error");
        setPhase("error");
      }
    };

    try {
      const res = await fetch(`/api/dh-tools/${def.key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        let msg = text;
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j.error) msg = j.error;
        } catch {}
        if (res.status === 401) msg = "Signed out — reload the board and log in again.";
        setError(`${msg || res.statusText} (HTTP ${res.status})`);
        setPhase("error");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Server-sent events: blocks separated by a blank line, `event:` + `data:` lines inside.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) continue;
          try {
            handle(event, JSON.parse(data));
          } catch {}
        }
      }
      if (!finished) {
        setError("The engine stopped before it finished (it may have timed out). Check the archive and inbox before running it again.");
        setPhase("error");
      }
    } catch (err) {
      setError((err as Error).message || "Connection lost");
      setPhase("error");
    }
  }

  function clear() {
    setPrompt("");
    setUrl("");
    setInstructions("");
    setDraft("");
    setResult(null);
    setError(null);
    setReached([]);
    setPhase("idle");
  }

  const onCmdEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  const id = (f: string) => `dh-${def.key}-${f}`;

  return (
    <div className="split split-left" style={{ ["--split-w" as string]: "360px" } as CSSProperties}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={{ display: "grid", gap: 12 }}
      >
        {audit ? (
          <>
            <Field label="Website" htmlFor={id("url")}>
              <input id={id("url")} className="input" type="text" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={onCmdEnter} disabled={working} placeholder="example.com" autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Send to" htmlFor={id("to")}>
              <input id={id("to")} className="input" type="email" value={recipient} onChange={(e) => setRecipient(e.target.value)} onKeyDown={onCmdEnter} disabled={working} placeholder="client@business.com" autoComplete="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" />
            </Field>
            <Field label="Format tweaks" hint="optional" htmlFor={id("notes")}>
              <textarea id={id("notes")} className="input" rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} onKeyDown={onCmdEnter} disabled={working} placeholder="e.g. skip the timeline · casual tone · critical action items only" style={{ resize: "vertical" }} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Send to" hint="optional" htmlFor={id("to")}>
              <input id={id("to")} className="input" type="email" value={recipient} onChange={(e) => setRecipient(e.target.value)} onKeyDown={onCmdEnter} disabled={working} placeholder="Blank = the engine's default inbox" autoComplete="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" />
            </Field>
            <Field label="Prompt" htmlFor={id("prompt")}>
              <textarea id={id("prompt")} className="input" rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onCmdEnter} disabled={working} placeholder={def.key === "proposal" ? "Who's the client, and what are we proposing?" : "Who's it for, and what's the offer?"} style={{ resize: "vertical" }} />
            </Field>
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <span role={problem ? "alert" : undefined} style={{ fontSize: 12, color: problem ? "var(--color-danger)" : "var(--color-muted)" }}>
            {problem ?? hint}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            {(phase === "done" || phase === "error") && (
              <button type="button" className="btn btn-ghost" onClick={clear}>
                Clear
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={!canSubmit} style={{ minWidth: 112 }}>
              {working ? "Working…" : "Generate"}
            </button>
          </div>
        </div>
      </form>

      <div style={{ display: "grid", gap: 12, minWidth: 0, alignContent: "start" }}>
        <Steps def={def} phase={phase} reached={reached} />
        <div
          ref={outRef}
          aria-label="Engine output"
          style={{
            minHeight: 220,
            maxHeight: 360,
            overflowY: "auto",
            padding: 14,
            borderRadius: 14,
            border: "1px solid var(--color-border)",
            background: "color-mix(in srgb, var(--color-blue) 3%, var(--color-bg))",
            fontSize: 12.5,
            lineHeight: 1.55,
          }}
        >
          {!draft && !result && !error && <p style={{ margin: 0, color: "var(--color-muted)" }}>{working ? "Waiting for the first words…" : def.hint}</p>}
          {draft && <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit" }}>{draft}</pre>}
          {error && (
            <p role="alert" style={{ margin: draft ? "10px 0 0" : 0, color: "var(--color-danger)", fontWeight: 500 }}>
              {error}
            </p>
          )}
          {result && <ResultCard result={result} />}
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <label className="label" htmlFor={htmlFor}>
        {label}
        {hint && <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}> · {hint}</span>}
      </label>
      {children}
    </div>
  );
}

/** The engine's pipeline as a row of chips: done ✓, the live step pulses, the rest wait. */
function Steps({ def, phase, reached }: { def: EngineDef; phase: Phase; reached: Phase[] }) {
  const failedAt = phase === "error" ? reached[reached.length - 1] : undefined;
  return (
    <div>
      <ol aria-label="Progress" style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", margin: 0, padding: 0, listStyle: "none" }}>
        {def.steps.map((s) => {
          const current = phase === s;
          const failed = failedAt === s;
          const done = !failed && (phase === "done" || (reached.includes(s) && !current));
          const hue = failed ? "var(--color-danger)" : done ? "var(--color-green)" : current ? "var(--color-blue)" : "var(--color-muted)";
          return (
            <li
              key={s}
              aria-current={current ? "step" : undefined}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 500,
                color: done || current || failed ? hue : "var(--color-muted)",
                background: done || current || failed ? tint(hue, 10) : "transparent",
                border: `1px solid ${done || current || failed ? tint(hue, 30) : "var(--color-border)"}`,
              }}
            >
              <span aria-hidden className={current ? "dh-pulse" : undefined} style={{ width: 7, height: 7, borderRadius: "50%", background: done || current || failed ? hue : "var(--color-border-strong)" }} />
              {PHASE_LABEL[s]}
              {done && <span className="sr-only"> (done)</span>}
              {failed && <span className="sr-only"> (failed)</span>}
            </li>
          );
        })}
      </ol>
      <span role="status" aria-live="polite" className="sr-only">
        {PHASE_LABEL[phase]}
      </span>
    </div>
  );
}

function ResultCard({ result }: { result: Result }) {
  const [copied, setCopied] = useState(false);
  const { email } = result;
  return (
    <div style={{ display: "grid", gap: 10, padding: 14, borderRadius: 12, background: "var(--color-card)", border: `1px solid ${tint("var(--color-green)", 30)}` }}>
      <div style={{ fontWeight: 600, fontSize: 15, color: "var(--color-text)" }}>
        <span style={{ color: "var(--color-green)" }}>✓</span> {result.headline}
      </div>
      <div style={{ fontSize: 13, color: email.sent ? "var(--color-green)" : "var(--color-amber)" }}>
        {email.sent ? `Emailed to ${email.to ?? "the recipient"}` : `Not emailed — ${email.reason ?? "unknown reason"}`}
      </div>
      {result.pdfUrl && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a className="btn btn-primary" href={result.pdfUrl} target="_blank" rel="noreferrer">
            Open PDF ↗
          </a>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(result.pdfUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              } catch {}
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
    </div>
  );
}
