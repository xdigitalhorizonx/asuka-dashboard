#!/usr/bin/env node
/**
 * Alternative to the in-app "Connect Google" button: mint the Google refresh token
 * that lets Central Dogma read and write brandon@digitalhorizon.dev's Google Tasks
 * and read his Google Calendar, for GOOGLE_TASKS_REFRESH_TOKEN.
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-tasks-auth.mjs
 *   node scripts/google-tasks-auth.mjs --client-id ... --client-secret ... [--account you@example.com]
 *
 * Needs an OAuth client of type "Desktop app" in a Google Cloud project with the
 * Tasks API enabled (see README → "Reminders = Google Tasks"). The script opens the
 * consent screen, catches the redirect on a loopback port, exchanges the code, and
 * prints the three env vars to paste into Vercel. Nothing is written to disk.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const clientId = flag("--client-id") || process.env.GOOGLE_CLIENT_ID;
const clientSecret = flag("--client-secret") || process.env.GOOGLE_CLIENT_SECRET;
const account = flag("--account") || "brandon@digitalhorizon.dev";

if (!clientId || !clientSecret) {
  console.error("Missing OAuth client. Pass GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (env or --client-id / --client-secret).");
  process.exit(1);
}

const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/tasks", "https://www.googleapis.com/auth/calendar.events"];
const state = randomBytes(16).toString("hex");

const server = http.createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: SCOPES.join(" "),
  access_type: "offline",
  prompt: "consent",
  login_hint: account,
  state,
}).toString();

console.log(`\nSign in as ${account} and approve access to Google Tasks and Calendar.\nIf a browser didn't open, paste this URL into one:\n\n${authUrl}\n`);
openBrowser(authUrl.toString());

const code = await new Promise((resolve, reject) => {
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== "/callback") {
      res.statusCode = 404;
      res.end();
      return;
    }
    const error = url.searchParams.get("error");
    if (error || url.searchParams.get("state") !== state) {
      res.statusCode = 400;
      res.end("Authorisation failed — check the terminal.");
      reject(new Error(error || "state mismatch"));
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<p style=\"font-family:system-ui;padding:32px\">Central Dogma is connected to Google Tasks. You can close this tab.</p>");
    resolve(url.searchParams.get("code"));
  });
});
server.close();

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
});
const tok = await tokenRes.json();
if (!tokenRes.ok || !tok.refresh_token) {
  console.error("Token exchange failed:", JSON.stringify(tok, null, 2));
  console.error("If there is no refresh_token, revoke the app at https://myaccount.google.com/permissions and run this again.");
  process.exit(1);
}

const email = tok.id_token ? JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString("utf8")).email : "(unknown)";
if (email !== account) {
  console.warn(`\nWARNING: you signed in as ${email}, not ${account}. Re-run and pick the right account if that is not what you wanted.`);
}

const listsRes = await fetch("https://tasks.googleapis.com/tasks/v1/users/@me/lists", {
  headers: { Authorization: `Bearer ${tok.access_token}` },
});
const lists = await listsRes.json();
console.log(`\nConnected as ${email}. Task lists on this account:`);
for (const l of lists.items ?? []) console.log(`  ${l.id}  ${l.title}`);

console.log(`\nAdd these to Vercel → Project → Settings → Environment Variables (Production), then redeploy:\n`);
console.log(`GOOGLE_CLIENT_ID=${clientId}`);
console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
console.log(`GOOGLE_TASKS_REFRESH_TOKEN=${tok.refresh_token}`);
console.log(`# optional — which list the board uses; default @default = "My Tasks"`);
console.log(`# GOOGLE_TASKS_LIST=<an id from the list above>\n`);
console.log("Keep the refresh token out of git. It stays valid until you revoke the app or change the account password.");

function openBrowser(url) {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* best effort — the URL is printed above */
  });
}
