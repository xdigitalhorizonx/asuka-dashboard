import { NextResponse } from "next/server";
import { invoiceErrorResponse } from "@/lib/invoice/http";
import { createPackage, listPackages } from "@/lib/invoice/packages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/invoices/packages — every saved package (session-gated by proxy.ts). */
export async function GET() {
  try {
    return NextResponse.json({ packages: await listPackages() });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not load the packages");
  }
}

/** POST /api/invoices/packages — save `{ name, lines, project, notes }` as a package. */
export async function POST(req: Request) {
  try {
    const pkg = await createPackage(await req.json().catch(() => null));
    return NextResponse.json({ package: pkg }, { status: 201 });
  } catch (err) {
    return invoiceErrorResponse(err, "Could not save the package");
  }
}
