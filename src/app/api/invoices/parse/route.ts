import { NextResponse } from "next/server";
import { putObject, randomId } from "@/lib/blobstore";
import { safeFileName } from "@/lib/files-shared";
import { invoiceErrorResponse } from "@/lib/invoice/http";
import { PROPOSALS_PREFIX, type InvoiceInput } from "@/lib/invoice/store";
import { defaultCardFeePercent } from "@/lib/invoice/validate";
import { draftInvoiceLines } from "@/lib/proposal/draft";
import { parseProposalPdf } from "@/lib/proposal/parse";
import { readState } from "@/lib/server-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PDF_BYTES = 15 * 1024 * 1024;

/** Today in the board's home time zone (Pacific), as "YYYY-MM-DD". */
function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Pull contact details for the proposal's client from Customers (first) or the CRM. */
async function matchClient(client: string): Promise<{ kind: "customer" | "lead"; label: string; email: string; phone: string; address: string } | null> {
  const want = norm(client);
  if (want.length < 3) return null;
  const same = (v: string) => {
    const n = norm(v);
    return !!n && (n === want || (n.length >= 6 && want.length >= 6 && (n.includes(want) || want.includes(n))));
  };
  const state = await readState();
  const c = state.customers.find((x) => same(x.company) || same(x.contact));
  if (c) return { kind: "customer", label: c.company || c.contact, email: c.email, phone: c.phone, address: c.address };
  const l = state.leads.find((x) => same(x.company) || same(x.name));
  if (l) return { kind: "lead", label: l.company || l.name, email: l.email, phone: l.phone, address: "" };
  return null;
}

/**
 * POST /api/invoices/parse — body: the proposal PDF (raw bytes; `x-file-name` header).
 * Stores the PDF with the invoice-to-be, reads it, and answers with a ready-to-review
 * draft billing the proposal's initial investment. Session-gated by proxy.ts.
 */
export async function POST(req: Request) {
  try {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.byteLength) return NextResponse.json({ error: "The file was empty." }, { status: 400 });
    if (bytes.byteLength > MAX_PDF_BYTES) return NextResponse.json({ error: "That PDF is over 15 MB." }, { status: 413 });
    if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
      return NextResponse.json({ error: "That file isn't a PDF — upload the proposal PDF." }, { status: 415 });
    }

    const rawName = decodeURIComponent(req.headers.get("x-file-name") || "proposal.pdf");
    const fileName = /\.pdf$/i.test(safeFileName(rawName)) ? safeFileName(rawName) : `${safeFileName(rawName)}.pdf`;
    const path = `${PROPOSALS_PREFIX}${randomId(16)}/${fileName}`;
    await putObject(path, bytes, { contentType: "application/pdf" });

    const parsed = await parseProposalPdf(bytes);
    const source = { fileName, path, proposalDate: parsed.proposalDate || "" };
    const base: InvoiceInput = {
      issueDate: today(),
      dueDate: "",
      client: { name: parsed.client || "", email: "", phone: "", address: "" },
      project: parsed.summary || "",
      lines: [],
      cardFeePercent: defaultCardFeePercent(),
      notes: "",
      source,
    };

    if (!parsed.ok) {
      return NextResponse.json({ ok: false, reason: parsed.reason || "This doesn't look like a Digital Horizon proposal.", draft: base, warnings: parsed.warnings, total: 0 });
    }

    const d = draftInvoiceLines(parsed);
    const match = parsed.client ? await matchClient(parsed.client) : null;
    const draft: InvoiceInput = {
      ...base,
      client: { name: parsed.client, email: match?.email || "", phone: match?.phone || "", address: match?.address || "" },
      lines: d.lines,
      notes: d.notes,
    };
    return NextResponse.json({
      ok: true,
      draft,
      total: d.total,
      warnings: [...parsed.warnings, ...d.warnings],
      match: match ? { kind: match.kind, label: match.label } : null,
      proposal: {
        client: parsed.client,
        proposalDate: parsed.proposalDate,
        services: parsed.services.length,
        totals: parsed.totals,
      },
    });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not read that proposal");
  }
}
