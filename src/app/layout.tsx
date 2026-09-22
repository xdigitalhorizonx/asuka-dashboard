import type { Metadata, Viewport } from "next";
import { DM_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const dmMono = DM_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const APP_NAME = "Central Dogma";

export const metadata: Metadata = {
  title: APP_NAME,
  applicationName: APP_NAME,
  description:
    "Reminders, calendar, notes, attachments, and CRM for conversations with Asuka Langley.",
  // iOS "Add to Home Screen" reads these: the label under the icon comes from
  // apple-mobile-web-app-title, the icon from apple-touch-icon.
  appleWebApp: {
    title: APP_NAME,
    capable: true,
    statusBarStyle: "black",
  },
  icons: {
    icon: [
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#100e17",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${dmMono.variable} h-full dark`}>
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
