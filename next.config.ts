import type { NextConfig } from "next";

/** Customer-facing invoice pages must never be indexed or leak their tokenised URL as a referrer. */
const privatePublicHeaders = [
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/i/:path*", headers: [...privatePublicHeaders, { key: "X-Frame-Options", value: "DENY" }] },
      { source: "/api/public/:path*", headers: privatePublicHeaders },
    ];
  },
};

export default nextConfig;
