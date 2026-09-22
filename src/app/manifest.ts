import type { MetadataRoute } from "next";

/**
 * Web app manifest (served at /manifest.webmanifest). Safari on iOS reads
 * short_name / icons as a fallback to the apple-* tags in layout.tsx; Android
 * and desktop Chrome use it for the install prompt. Kept open in proxy.ts —
 * the manifest is fetched without cookies, so it can't sit behind the login.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Central Dogma",
    short_name: "Central Dogma",
    description: "Asuka Langley's ops board — reminders, calendar, notes, CRM, customers.",
    start_url: "/",
    display: "standalone",
    background_color: "#141327",
    theme_color: "#141327",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
