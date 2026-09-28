import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { Inter, Nunito } from "next/font/google";
import { DhMark } from "@/components/DhLogo";
import { seller } from "@/lib/invoice/seller";
import { paymentsStatus, reconcileInvoice, stripePublishableKey } from "@/lib/invoice/payments";
import { getInvoiceWithIntents, isInvoiceId } from "@/lib/invoice/store";
import { cardFee, fmtLongDate, fmtMoney, type Invoice } from "@/lib/invoice/types";
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
  if (found.invoice.status === "open" && found.pis.length > found.invoice.payments.length) {
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
  const feeCredit = cardFee(inv.balance, inv.cardFeePercent);
  const dueText = inv.dueDate ? `Due ${fmtLongDate(inv.dueDate)}` : "Due on receipt";
  const pdfHref = `/api/public/invoices/${inv.id}/pdf`;

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
                <span className={`${s.pill} ${s.pillPaid}`}>Paid{inv.paidAt ? ` · ${fmtLongDate(inv.paidAt.slice(0, 10))}` : ""}</span>
              ) : inv.status === "void" ? (
                <span className={`${s.pill} ${s.pillVoid}`}>Void</span>
              ) : (
                <span className={`${s.pill} ${s.pillOpen}`}>{dueText}</span>
              )}
            </div>

            {open && (
              <div className={s.due}>
                <div>
                  <div className={s.dueLabel}>Amount due</div>
                  <div className={s.dueAmount}>{fmtMoney(inv.balance)}</div>
                  <div className={s.dueSub}>{dueText}</div>
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
              <div className={s.balanceRow}>
                <span>Balance due</span>
                <span>{fmtMoney(inv.balance)}</span>
              </div>
            </div>

            {open && inv.cardFeePercent > 0 && (
              <p className={s.feeNote}>
                Paying by credit card adds a {inv.cardFeePercent}% card processing fee ({fmtMoney(feeCredit)}). Debit cards pay no fee. You&rsquo;ll see the exact
                total before you confirm.
              </p>
            )}

            {inv.payments.length > 0 && (
              <section className={s.section} aria-label="Payments">
                <h2 className={s.sectionTitle}>Payments</h2>
                {inv.payments.map((p) => (
                  <div key={p.paymentIntentId} className={s.payment}>
                    <span>
                      {fmtLongDate(p.paidAt.slice(0, 10))} · {brandName(p.brand)}
                      {p.funding && p.funding !== "unknown" ? ` ${p.funding}` : ""}
                      {p.last4 ? ` ••${p.last4}` : ""}
                    </span>
                    <strong>{fmtMoney(p.amount)}</strong>
                    {p.fee > 0 && <span className={s.metaMuted}>Includes {fmtMoney(p.fee)} credit card fee</span>}
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
          </div>
        </main>

        {open && (
          <aside id="pay" className={s.pay} aria-label="Pay this invoice">
            {pay.ready ? (
              <PayBox
                invoiceId={inv.id}
                number={inv.number}
                balance={inv.balance}
                cardFeePercent={inv.cardFeePercent}
                publishableKey={stripePublishableKey()}
                testMode={pay.mode === "test"}
                email={inv.client.email}
                name={inv.client.name}
                contactEmail={me.email}
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
