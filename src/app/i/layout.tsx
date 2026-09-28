import type { Metadata, Viewport } from "next";

/**
 * Everything under /i is seen by Digital Horizon's clients, not by the board's owner:
 * Digital Horizon's icon and name instead of the dashboard's (Central Dogma / Asuka),
 * never indexed, never sent as a referrer.
 */
export const metadata: Metadata = {
  title: "Invoice · Digital Horizon",
  applicationName: "Digital Horizon",
  icons: { icon: [{ url: "/i/icon.svg", type: "image/svg+xml" }] },
  appleWebApp: { title: "Digital Horizon", capable: false },
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export const viewport: Viewport = { themeColor: "#ffffff", colorScheme: "light" };

export default function InvoiceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
