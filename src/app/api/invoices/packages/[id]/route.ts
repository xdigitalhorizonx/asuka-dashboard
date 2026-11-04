import { NextResponse } from "next/server";
import { invoiceErrorResponse } from "@/lib/invoice/http";
import { deletePackage } from "@/lib/invoice/packages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/invoices/packages/<id> — remove a saved package. Invoices made from it are untouched. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!(await deletePackage(id))) return NextResponse.json({ error: "That package is already gone." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not delete the package");
  }
}
