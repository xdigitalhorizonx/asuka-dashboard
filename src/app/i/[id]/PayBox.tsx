"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { loadStripe, type Stripe, type StripeElements, type Appearance } from "@stripe/stripe-js";
import { DhMark } from "@/components/DhLogo";
import { cardFeeWording } from "@/lib/invoice/types";
import s from "../invoice.module.css";

type Quote = { base: number; fee: number; total: number; feePercent: number; funding: string; brand: string; last4: string; part?: "deposit" | "balance" | "" };
type Phase = "loading" | "entering" | "reviewing" | "paying" | "done" | "processing" | "unavailable";

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cents = (n: number) => Math.round(n * 100);
const PER = { month: "month", year: "year" } as const;
/** `from` = when the first renewal lands if paid today, already formatted by the server. */
type Recurring = { interval: "month" | "year"; amount: number; from: string };

/** "$94.99/month from October 28, 2026" (+ " and $120.00/year from …") — what keeps billing after today. */
function recurringText(r: Recurring[]): string {
  return r.map((g) => `${money(g.amount)}/${PER[g.interval]} from ${g.from}`).join(" and ");
}

/** Digital Horizon's pastel brand inside Stripe's card form. */
const APPEARANCE: Appearance = {
  theme: "stripe",
  variables: {
    colorPrimary: "#E85C97",
    colorBackground: "#FFFFFF",
    colorText: "#3A2A36",
    colorTextSecondary: "#6E6470",
    colorDanger: "#D64564",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    fontSizeBase: "15px",
    borderRadius: "12px",
    spacingUnit: "4px",
  },
  rules: {
    ".Input": { border: "1px solid #EADFE7", boxShadow: "none" },
    ".Input:focus": { border: "1px solid #4F93DA", boxShadow: "0 0 0 3px rgba(79,147,218,0.18)" },
    ".Label": { color: "#6E6470", fontWeight: "600" },
    ".Tab": { border: "1px solid #EADFE7" },
    ".Tab--selected": { borderColor: "#E85C97", boxShadow: "0 0 0 1px #E85C97" },
  },
};

function brandLabel(b: string): string {
  const map: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", american_express: "American Express", discover: "Discover", diners: "Diners Club", diners_club: "Diners Club", jcb: "JCB", unionpay: "UnionPay", union_pay: "UnionPay" };
  return map[b] ?? (b ? b.charAt(0).toUpperCase() + b.slice(1) : "Card");
}

async function post<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, status: res.status, data };
}

export function PayBox(props: {
  invoiceId: string;
  number: string;
  /** What this payment covers (before any card fee): the balance, or a deposit invoice's deposit. */
  balance: number;
  /** Deposit invoices: which of the two payments this is. */
  part: "deposit" | "balance" | null;
  /** Deposit invoices, before the deposit: what's left for the second payment. */
  later: number;
  cardFeePercent: number;
  /** Every card pays the fee (debit too), not just credit cards. */
  cardFeeAllCards: boolean;
  publishableKey: string;
  testMode: boolean;
  email: string;
  name: string;
  contactEmail: string;
  /** Recurring lines billed by a subscription after today; non-empty → the card is saved. */
  recurring: Recurring[];
}) {
  const { invoiceId, balance, part, later, cardFeePercent, cardFeeAllCards, publishableKey, testMode, email, name, contactEmail, recurring } = props;
  const saveCard = recurring.length > 0;
  const router = useRouter();
  const mountRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [tokenId, setTokenId] = useState<string | null>(null);
  /**
   * What the success note says, fixed when the payment goes through: the page refreshes right
   * after, and a deposit invoice then re-renders this box for the balance (no renewal, no "later").
   */
  const [receipt, setReceipt] = useState<{ total: number; saved: string; later: number } | null>(null);
  const api = `/api/public/invoices/${invoiceId}`;

  const finish = useCallback(
    async (paymentIntentId: string) => {
      const r = await post<{ status: string; message?: string; invoice?: { balance: number } }>(`${api}/finalize`, { paymentIntentId });
      if (r.ok && r.data.status === "succeeded") {
        setPhase("done");
        router.refresh();
      } else if (r.ok && r.data.status === "processing") {
        setPhase("processing");
      } else {
        setError(r.data.message || r.data.error || "The payment didn't go through. Please try again.");
        setPhase("entering");
      }
    },
    [api, router]
  );

  // Mount Stripe's card form (deferred-intent mode: nothing is created until the customer confirms).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stripe = await loadStripe(publishableKey);
        if (cancelled) return;
        if (!stripe) throw new Error("Stripe failed to load");
        stripeRef.current = stripe;

        // Back from a bank redirect (3-D Secure fallback): finish that payment first.
        const qs = new URLSearchParams(window.location.search);
        const returning = qs.get("payment_intent");
        if (returning) {
          window.history.replaceState(null, "", window.location.pathname);
          setPhase("paying");
          await finish(returning);
          if (cancelled) return;
        }

        const elements = stripe.elements({
          mode: "payment",
          amount: cents(balance),
          currency: "usd",
          paymentMethodTypes: ["card"],
          // Monthly/yearly lines: keep the card on file for the subscription (must match the server's PaymentIntent).
          ...(saveCard ? { setupFutureUsage: "off_session" as const } : {}),
          // Phones zoom into any field under 16px on focus (iOS), so card fields are 16px there.
          appearance: window.matchMedia("(max-width: 979px), (pointer: coarse)").matches
            ? { ...APPEARANCE, variables: { ...APPEARANCE.variables, fontSizeBase: "16px" } }
            : APPEARANCE,
          fonts: [{ cssSrc: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" }],
        });
        elementsRef.current = elements;
        const card = elements.create("payment", {
          layout: "tabs",
          // No Link sign-up: it adds a required phone field when the card is being saved, and a
          // Link payment hides the card's funding type (debit vs credit) that the pricing needs.
          wallets: { link: "never" },
          defaultValues: { billingDetails: { ...(email ? { email } : {}), ...(name ? { name } : {}) } },
        });
        card.on("ready", () => !cancelled && setReady(true));
        card.on("change", () => !cancelled && setError(null));
        if (mountRef.current) card.mount(mountRef.current);
        setPhase((p) => (p === "loading" ? "entering" : p));
      } catch {
        if (!cancelled) setPhase("unavailable");
      }
    })();
    return () => {
      cancelled = true;
      elementsRef.current?.getElement("payment")?.destroy();
      elementsRef.current = null;
    };
  }, [publishableKey, balance, email, name, finish, saveCard]);

  async function review() {
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (!stripe || !elements) return;
    setError(null);
    setPhase("paying");
    const submitted = await elements.submit();
    if (submitted.error) {
      setError(submitted.error.message || "Please check the card details.");
      setPhase("entering");
      return;
    }
    const { error: ctErr, confirmationToken } = await stripe.createConfirmationToken({
      elements,
      params: { return_url: `${window.location.origin}/i/${invoiceId}` },
    });
    if (ctErr || !confirmationToken) {
      setError(ctErr?.message || "The card details couldn't be read. Please try again.");
      setPhase("entering");
      return;
    }
    // `part`: the server refuses (409 → reload) if the deposit/balance shown here is stale.
    const r = await post<{ quote: Quote }>(`${api}/quote`, { confirmationTokenId: confirmationToken.id, part: part ?? "" });
    if (!r.ok) {
      setError(r.data.error || "This card couldn't be priced. Please try again.");
      setPhase("entering");
      if (r.status === 409) router.refresh();
      return;
    }
    setTokenId(confirmationToken.id);
    setQuote(r.data.quote);
    setPhase("reviewing");
  }

  async function payNow() {
    const stripe = stripeRef.current;
    if (!stripe || !tokenId || !quote) return;
    setError(null);
    setPhase("paying");
    const r = await post<{ status: string; clientSecret?: string; paymentIntentId?: string; message?: string; quote?: Quote }>(`${api}/pay`, {
      confirmationTokenId: tokenId,
      expectedTotalCents: cents(quote.total),
      part: part ?? "",
    });
    if (!r.ok) {
      if (r.status === 409 && r.data.quote) {
        // The amount changed since review (e.g. the invoice was updated): show the new total.
        setQuote(r.data.quote);
        setError(r.data.error || "The amount changed — please review the new total.");
        setPhase("reviewing");
        return;
      }
      setError(r.data.error || "The payment couldn't be started. Please try again.");
      setTokenId(null);
      setQuote(null);
      setPhase("entering");
      if (r.status === 409) router.refresh();
      return;
    }
    const d = r.data;
    if (d.status === "succeeded") {
      setReceipt({ total: quote.total, saved: saveCard ? recurringText(recurring) : "", later });
      setPhase("done");
      router.refresh();
      return;
    }
    if (d.status === "processing") {
      setPhase("processing");
      return;
    }
    if (d.status === "requires_action" && d.clientSecret && d.paymentIntentId) {
      const next = await stripe.handleNextAction({ clientSecret: d.clientSecret });
      if (next.error) {
        setError(next.error.message || "Your bank couldn't verify the payment. Please try again or use another card.");
        setTokenId(null);
        setQuote(null);
        setPhase("entering");
        return;
      }
      setReceipt({ total: quote.total, saved: saveCard ? recurringText(recurring) : "", later });
      await finish(d.paymentIntentId);
      return;
    }
    setError(d.message || "The card was declined. Please try another card.");
    setTokenId(null);
    setQuote(null);
    setPhase("entering");
  }

  const busy = phase === "paying";
  const feeText = cardFeePercent > 0 ? cardFeeWording(cardFeePercent, cardFeeAllCards).hint : "No card fee.";
  const renewal = saveCard
    ? `Then ${recurringText(recurring)}, charged automatically to this card. To change or cancel, email ${contactEmail}.`
    : "";

  return (
    <>
      {testMode && <div className={s.testBanner}>TEST MODE · NO REAL CHARGE</div>}
      <div className={s.payInner}>
        <div className={s.payHead}>
          <h2 className={s.payTitle}>Pay online</h2>
          <span className={s.lock} title="Card details go straight to Stripe and never touch our servers">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
              <rect x="4" y="11" width="16" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            Secure
          </span>
        </div>

        {phase === "done" ? (
          <div className={s.success} role="status" aria-live="polite">
            <div className={s.successMark}>✓</div>
            <p style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Payment received</p>
            <p className={s.payHint} style={{ margin: "6px 0 0" }}>
              {receipt ? `${money(receipt.total)} paid. ` : ""}Thank you! A receipt is on its way{email ? ` to ${email}` : ""}.
            </p>
            {receipt?.saved && (
              <p className={s.payHint} style={{ margin: "6px 0 0" }}>
                Your card is saved for {receipt.saved}.
              </p>
            )}
            {!!receipt?.later && (
              <p className={s.payHint} style={{ margin: "6px 0 0" }}>
                The remaining {money(receipt.later)} is due later — pay it from this same link.
              </p>
            )}
          </div>
        ) : phase === "processing" ? (
          <div className={s.success} role="status" aria-live="polite">
            <p style={{ fontSize: 17, fontWeight: 800, margin: 0 }}>Payment processing</p>
            <p className={s.payHint} style={{ margin: "6px 0 0" }}>
              Your bank is still confirming it. This page will show it as paid once it clears — no need to pay again.
            </p>
          </div>
        ) : phase === "unavailable" ? (
          <p className={s.unavailable} style={{ marginTop: 10 }}>
            The card form couldn&rsquo;t load. Refresh the page, or email <a href={`mailto:${contactEmail}`}>{contactEmail}</a> to pay another way.
          </p>
        ) : (
          <>
            {part && <p className={s.payHint} style={{ margin: "0 0 2px", fontWeight: 700 }}>{part === "deposit" ? "Deposit due now" : "Remaining balance"}</p>}
            <div className={s.payAmount}>{money(balance)}</div>
            <p className={s.payHint}>{feeText}</p>
            {saveCard && (
              <p className={s.payHint} data-testid="renewal-note">
                {renewal}
              </p>
            )}

            <div ref={mountRef} className={s.element} hidden={phase === "reviewing"} aria-busy={!ready} />
            {!ready && phase !== "reviewing" && <p className={s.payHint}>Loading secure card form…</p>}

            {phase === "reviewing" && quote && (
              <div className={s.review} aria-live="polite">
                <div className={s.cardChip}>
                  {brandLabel(quote.brand)} {quote.funding !== "unknown" ? quote.funding : ""} ••{quote.last4}
                </div>
                <div className={s.reviewRow}>
                  <span>{quote.part === "deposit" ? "Deposit · invoice" : quote.part === "balance" ? "Balance · invoice" : "Invoice"} {props.number}</span>
                  <span>{money(quote.base)}</span>
                </div>
                {quote.fee > 0 ? (
                  <div className={s.reviewRow}>
                    <span>{cardFeeWording(quote.feePercent, cardFeeAllCards).label}</span>
                    <span>{money(quote.fee)}</span>
                  </div>
                ) : (
                  <div className={s.reviewRow} style={{ color: "var(--green-ink)" }}>
                    <span>{cardFeePercent > 0 && (quote.funding === "debit" || quote.funding === "prepaid") ? `${quote.funding === "debit" ? "Debit" : "Prepaid"} card — no card fee` : "No card fee"}</span>
                    <span>$0.00</span>
                  </div>
                )}
                <div className={s.reviewTotal}>
                  <span>Total today</span>
                  <span>{money(quote.total)}</span>
                </div>
                {saveCard && (
                  <div className={s.reviewRow} style={{ marginTop: 6, fontSize: 13 }}>
                    <span>
                      Then {recurringText(recurring)}
                    </span>
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className={s.error} role="alert">
                {error}
              </div>
            )}

            {phase === "reviewing" && quote ? (
              <>
                <button type="button" className={s.payBtn} onClick={payNow} disabled={busy}>
                  Pay {money(quote.total)}
                </button>
                <div style={{ textAlign: "center", marginTop: 6 }}>
                  <button
                    type="button"
                    className={s.linkBtn}
                    onClick={() => {
                      setQuote(null);
                      setTokenId(null);
                      setError(null);
                      setPhase("entering");
                    }}
                  >
                    Use a different card
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className={s.payBtn} onClick={review} disabled={!ready || busy}>
                {busy ? (
                  <>
                    <span className={s.spinner} aria-hidden="true" />
                    Working…
                  </>
                ) : (
                  "Review payment"
                )}
              </button>
            )}
          </>
        )}

        <p className={s.fine}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 700, color: "var(--ink)" }}>
            <DhMark height={12} /> Digital Horizon
          </span>{" "}
          · Payments processed securely by Stripe. Your card number never touches our servers.
        </p>
      </div>
    </>
  );
}
