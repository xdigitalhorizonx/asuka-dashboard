/** Shared bits of the connect / callback pair. */
export const OAUTH_STATE_COOKIE = "google_oauth_state";

/**
 * The redirect URI Google must send the browser back to. Behind Vercel the
 * public host arrives in x-forwarded-host; GOOGLE_REDIRECT_URI overrides it
 * (e.g. when the board is served from a custom domain).
 */
export function redirectUriFor(req: Request): string {
  const fixed = process.env.GOOGLE_REDIRECT_URI;
  if (fixed) return fixed;
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
  return `${proto}://${host}/api/google/callback`;
}

/** Where the browser lands after the flow, with a short status for the Reminders tab. */
export function doneUrl(req: Request, status: string): URL {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
  return new URL(`${proto}://${host}/?google=${encodeURIComponent(status)}#reminders`);
}
