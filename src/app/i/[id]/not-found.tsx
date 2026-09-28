import { DhMark } from "@/components/DhLogo";
import s from "../invoice.module.css";

export default function InvoiceNotFound() {
  return (
    <div className={s.page}>
      <div className={s.shell} style={{ maxWidth: 560 }}>
        <main className={s.paper}>
          <div className={s.stripe} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className={s.paperInner} style={{ textAlign: "center" }}>
            <DhMark height={40} />
            <h1 className={s.number} style={{ marginTop: 14 }}>
              Invoice not found
            </h1>
            <p className={s.metaMuted} style={{ marginTop: 10 }}>
              This invoice link isn&rsquo;t valid any more. If you were expecting an invoice from Digital Horizon, reply to the email it came in and
              we&rsquo;ll send a fresh link.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
