import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { Inter, Nunito } from "next/font/google";
import { DhMark } from "@/components/DhLogo";
import { seller } from "@/lib/invoice/seller";
import { paymentsStatus, reconcileInvoice, stripePublishableKey } from "@/lib/invoice/payments";
import { getInvoiceWithIntents, isInvoiceId } from "@/lib/invoice/store";
import { cardFeeAllCards, effectiveCardFeePercent } from "@/lib/invoice/validate";
import {
  addPeriod,
  cardFee,
  cardFeeWording,
  depositWording,
  discountLabel,
  fmtLongDate,
  fmtMoney,
  invoiceTotals,
  isCardPayment,
  localYmd,
  offlinePaymentLabel,
  recurringGroups,
  round2,
  savesCard,
  type Invoice,
} from "@/lib/invoice/types";
import { PayBox } from "./PayBox";
import s from "../invoice.module.css";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const inter = Inter({ subsets: ["latin"], variable: "--font-inv", display: "swap" });
const nunito = Nunito({ subsets: ["latin"], weight: ["800"], variable: "--font-logo", display: "swap" });

type Props = { params: Promise<{ id: string }> };

/** One storage read per request, shared by generateMetadata and the page. */
const fetchInvoice = cache((id: string) => getInvoiceWithIntents(id));

async function load(id: string): Promise<Invoice | null> {
  if (!isInvoiceId(id)) return null;
  const found = await fetchInvoice(id);
  if (!found) return null;
  // Catch up on a payment Stripe finished but this page never heard about (closed tab, missed webhook).
  if (found.invoice.status === "open" && found.pis.length > found.invoice.payments.filter(isCardPayment).length) {
    return reconcileInvoice(found.invoice, found.pis).catch(() => found.invoice);
  }
  return found.invoice;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const inv = isInvoiceId(id) ? (await fetchInvoice(id))?.invoice : null;
  return {
    title: inv ? `Invoice ${inv.number} · Digital Horizon` : "Invoice · Digital Horizon",
    description: inv ? `Invoice ${inv.number} for ${inv.client.name} from Digital Horizon.` : "Digital Horizon invoice",
  };
}

function brandName(b?: string): string {
  const map: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", american_express: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay" };
  return b ? map[b] ?? b.charAt(0).toUpperCase() + b.slice(1) : "Card";
}

export default async function InvoicePage({ params }: Props) {
  const { id } = await params;
  const inv = await load(id);
  if (!inv) notFound();

  const me = seller();
  const pay = paymentsStatus();
  const open = inv.status === "open";
  const totals = invoiceTotals(inv.lines, inv.discount);
  const feePct = effectiveCardFeePercent(inv);
  const feeAllCards = cardFeeAllCards();
  // Today's payment: the balance, or a deposit invoice's deposit until it's in.
  const feeCard = cardFee(inv.dueNow, feePct);
  const dueText = inv.dueDate ? `Due ${fmtLongDate(inv.dueDate)}` : "Due on receipt";
  const pdfHref = `/api/public/invoices/${inv.id}/pdf`;
  const depositOwed = open && !!inv.deposit && !inv.deposit.paidAt;
  const depositIn = open && !!inv.deposit?.paidAt;
  // The renewal date is fixed here (Digital Horizon's calendar), not in the browser: the pay box
  // is server-rendered too, and a UTC server + Pacific browser would disagree after 5 pm. Only
  // the payment that starts the subscription (the first) saves the card and mentions renewals.
  const recurring = savesCard(inv)
    ? recurringGroups(inv.lines).map((g) => ({
        interval: g.interval,
        amount: g.amount,
        from: fmtLongDate(localYmd(addPeriod(new Date(), g.interval).toISOString())),
      }))
    : [];
  const per = (i: "month" | "year") => (i === "month" ? "month" : "year");
  // The card the subscription bills: the payment that saved it (a deposit invoice’s balance card isn’t).
  const cards = inv.payments.filter(isCardPayment);
  const cardOnFile = cards.filter((p) => p.customerId).pop() ?? cards[cards.length - 1];

  return (
    <div className={`${s.page} ${inter.variable} ${nunito.variable}`}>
      <div className={open ? s.topbar : `${s.topbar} ${s.topbarSolo}`}>
        <span className={s.brand}>
          <DhMark height={30} />
          <span className={s.wordmark}>Digital Horizon</span>
        </span>
        <div className={s.actions}>
          <a className={s.ghostBtn} href={pdfHref} download>
            ↓ Download PDF
          </a>
          <a className={s.ghostBtn} href={`${pdfHref}?inline=1`} target="_blank" rel="noopener">
            View PDF
          </a>
        </div>
      </div>

      <div className={open ? s.shell : `${s.shell} ${s.shellSolo}`}>
        <main className={s.paper} aria-label={`Invoice ${inv.number}`}>
          <div className={s.stripe} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className={s.paperInner}>
            <div className={s.head}>
              <div>
                <div className={s.eyebrow}>Invoice</div>
                <h1 className={s.number}>{inv.number}</h1>
              </div>
              {inv.status === "paid" ? (
                <span className={`${s.pill} ${s.pillPaid}`}>Paid{inv.paidAt ? ` · ${fmtLongDate(localYmd(inv.paidAt))}` : ""}</span>
              ) : inv.status === "void" ? (
                <span className={`${s.pill} ${s.pillVoid}`}>Void</span>
              ) : depositIn && inv.deposit?.paidAt ? (
                <span className={`${s.pill} ${s.pillOpen}`}>Deposit paid · {fmtLongDate(localYmd(inv.deposit.paidAt))}</span>
              ) : (
                <span className={`${s.pill} ${s.pillOpen}`}>{dueText}</span>
              )}
            </div>

            {open && (
              <div className={s.due}>
                <div>
                  <div className={s.dueLabel}>{depositOwed ? "Deposit due now" : depositIn ? "Balance due" : "Amount due"}</div>
                  <div className={s.dueAmount}>{fmtMoney(inv.dueNow)}</div>
                  <div className={s.dueSub}>
                    {depositOwed && inv.deposit
                      ? `${dueText}. ${depositWording(inv.deposit, inv.lines)}`
                      : depositIn && inv.deposit
                        ? `Deposit of ${fmtMoney(inv.deposit.now)} received — thank you. This is the rest.`
                        : dueText}
                  </div>
                </div>
                <a className={s.jump} href="#pay">
                  Pay by card ↓
                </a>
              </div>
            )}
            {inv.status === "paid" && (
              <div className={s.stamp} role="status">
                <span className={s.stampBig}>✓ Paid in full</span>
                <span>Thank you — nothing is owed on this invoice.</span>
              </div>
            )}
            {inv.status === "void" && (
              <div className={s.voidBox} role="status">
                This invoice has been voided and can no longer be paid. Questions? {me.email}
              </div>
            )}

            <div className={s.meta}>
              <div>
                <div className={s.metaLabel}>Billed to</div>
                <div className={`${s.metaLine} ${s.metaStrong}`}>{inv.client.name}</div>
                {inv.client.email && <div className={s.metaMuted}>{inv.client.email}</div>}
                {inv.client.phone && <div className={s.metaMuted}>{inv.client.phone}</div>}
                {inv.client.address && <div className={s.metaMuted} style={{ whiteSpace: "pre-line" }}>{inv.client.address}</div>}
              </div>
              <div>
                <div className={s.metaLabel}>From</div>
                <div className={`${s.metaLine} ${s.metaStrong}`}>{me.name}</div>
                <div className={s.metaMuted}>{me.city}</div>
                <div className={s.metaMuted}>{me.email}</div>
                <div className={s.metaMuted}>{me.phone}</div>
              </div>
              <div>
                <div className={s.metaLabel}>Details</div>
                <div className={s.metaLine}>Issued {fmtLongDate(inv.issueDate)}</div>
                <div className={s.metaLine}>{dueText}</div>
                <div className={s.metaMuted}>Invoice {inv.number}</div>
              </div>
            </div>

            {inv.project && <p className={s.project}>{inv.project}</p>}

            <div className={s.items} role="table" aria-label="Services">
              <div className={s.itemsHead} role="row">
                <span role="columnheader">Service</span>
                <span role="columnheader">Type</span>
                <span role="columnheader" className={s.right}>
                  Amount
                </span>
              </div>
              {inv.lines.map((l) => (
                <div key={l.id} className={s.item} role="row">
                  <div role="cell">
                    <div className={s.itemName}>{l.name}</div>
                    {l.description && <div className={s.itemDesc}>{l.description}</div>}
                    {l.note && <div className={s.itemNote}>{l.note}</div>}
                  </div>
                  <div role="cell" className={s.itemType}>
                    {l.type}
                  </div>
                  {l.amount > 0 ? (
                    <div role="cell" className={s.itemAmount}>
                      {fmtMoney(l.amount)}
                    </div>
                  ) : (
                    <div role="cell" className={s.itemZero}>
                      {l.zeroLabel || "Included"}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className={s.totals}>
              {inv.discount && totals.discount > 0 && (
                <>
                  <div className={s.totalRow}>
                    <span>Subtotal</span>
                    <strong>{fmtMoney(totals.subtotal)}</strong>
                  </div>
                  <div className={s.totalRow}>
                    <span>{discountLabel(inv.discount)}</span>
                    <strong>−{fmtMoney(totals.discount)}</strong>
                  </div>
                </>
              )}
              <div className={s.totalRow}>
                <span>Total</span>
                <strong>{fmtMoney(inv.total)}</strong>
              </div>
              {inv.paid > 0 && (
                <div className={s.totalRow}>
                  <span>Paid</span>
                  <strong>−{fmtMoney(inv.paid)}</strong>
                </div>
              )}
              {depositOwed && inv.deposit && (
                <div className={s.totalRow}>
                  <span>Balance due later</span>
                  <strong>{fmtMoney(inv.deposit.later)}</strong>
                </div>
              )}
              <div className={s.balanceRow}>
                <span>{depositOwed ? "Deposit due now" : "Balance due"}</span>
                <span>{fmtMoney(depositOwed ? inv.dueNow : inv.balance)}</span>
              </div>
            </div>

            {open && feePct > 0 && <p className={s.feeNote}>{cardFeeWording(feePct, feeAllCards).note(fmtMoney(feeCard))}</p>}
            {open && recurring.length > 0 && (
              <p className={s.feeNote}>
                This invoice covers the first {recurring.map((g) => per(g.interval)).join(" and ")}. After that,{" "}
                {recurring.map((g) => `${fmtMoney(g.amount)}/${per(g.interval)}`).join(" and ")} is charged automatically to the card you pay with — it&rsquo;s
                saved securely by Stripe for that. To change or cancel, email {me.email}.
              </p>
            )}
            {inv.subscriptions.length > 0 && (
              <p className={s.feeNote}>
                {inv.subscriptions
                  .map((sub) => `${fmtMoney(sub.amount)}/${per(sub.interval)} starts ${fmtLongDate(localYmd(sub.startsAt))}`)
                  .join(" · ")}
                , charged automatically to {cardOnFile ? `${brandName(cardOnFile.brand)} ••${cardOnFile.last4 || ""}` : "the card on file"}. To change or cancel, email {me.email}.
              </p>
            )}

            {inv.payments.length > 0 && (
              <section className={s.section} aria-label="Payments">
                <h2 className={s.sectionTitle}>Payments</h2>
                {inv.payments.map((p) => (
                  <div key={p.paymentIntentId} className={s.payment}>
                    <span>
                      {fmtLongDate(localYmd(p.paidAt))} ·{" "}
                      {isCardPayment(p) ? (
                        <>
                          {brandName(p.brand)}
                          {p.funding && p.funding !== "unknown" ? ` ${p.funding}` : ""}
                          {p.last4 ? ` ••${p.last4}` : ""}
                        </>
                      ) : (
                        offlinePaymentLabel(p)
                      )}
                      {p.part ? ` · ${p.part === "deposit" ? "Deposit" : "Balance"}` : ""}
                    </span>
                    <strong>{fmtMoney(p.amount)}</strong>
                    {p.fee > 0 && <span className={s.metaMuted}>Includes {fmtMoney(p.fee)} card fee</span>}
                    {p.receiptUrl && (
                      <a href={p.receiptUrl} target="_blank" rel="noopener noreferrer">
                        Receipt ↗
                      </a>
                    )}
                  </div>
                ))}
              </section>
            )}

            {inv.notes && (
              <section className={s.section}>
                <h2 className={s.sectionTitle}>Notes</h2>
                <p className={s.notes}>{inv.notes}</p>
              </section>
            )}

            <footer className={s.footer}>
              <span>
                {me.name} · {me.city} · {me.domain}
              </span>
              <span>
                Questions? <a href={`mailto:${me.email}`}>{me.email}</a> · <a href={`tel:${me.phone.replace(/[^\d+]/g, "")}`}>{me.phone}</a>
              </span>
            </footer>

            {/* Phones/tablets only (CSS): follows the reader, then parks here above the pay box. */}
            {open && pay.ready && (
              <a className={s.stickyPay} href="#pay">
                {feePct === 0 || feeAllCards ? `Pay ${fmtMoney(round2(inv.dueNow + (feePct > 0 ? feeCard : 0)))} by card` : "Pay by card"}
                <span aria-hidden="true">↓</span>
              </a>
            )}
          </div>
        </main>

        {open && (
          <aside id="pay" className={s.pay} aria-label="Pay this invoice">
            {pay.ready ? (
              <PayBox
                invoiceId={inv.id}
                number={inv.number}
                balance={inv.dueNow}
                part={depositOwed ? "deposit" : depositIn ? "balance" : null}
                later={depositOwed && inv.deposit ? inv.deposit.later : 0}
                cardFeePercent={feePct}
                cardFeeAllCards={feeAllCards}
                publishableKey={stripePublishableKey()}
                testMode={pay.mode === "test"}
                email={inv.client.email}
                name={inv.client.name}
                contactEmail={me.email}
                recurring={recurring}
              />
            ) : (
              <div className={s.payInner}>
                <h2 className={s.payTitle}>Pay online</h2>
                <p className={s.unavailable} style={{ marginTop: 10 }}>
                  Online card payment isn&rsquo;t switched on for this invoice yet. To pay, email <a href={`mailto:${me.email}`}>{me.email}</a> or call{" "}
                  <a href={`tel:${me.phone.replace(/[^\d+]/g, "")}`}>{me.phone}</a>.
                </p>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
