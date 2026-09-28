/**
 * Digital Horizon's own details, printed on every invoice and on the public page.
 * Defaults are the contact lines on Digital Horizon's proposals; env vars override.
 * Server-side only — read at call time so a changed env var needs no code change.
 */
export interface Seller {
  name: string;
  city: string;
  domain: string;
  email: string;
  phone: string;
}

export function seller(): Seller {
  return {
    name: "Digital Horizon",
    city: "Carson City, NV",
    domain: "digitalhorizon.dev",
    email: process.env.INVOICE_FROM_EMAIL || "brandon@digitalhorizon.dev",
    phone: process.env.INVOICE_FROM_PHONE || "775.443.3880",
  };
}
