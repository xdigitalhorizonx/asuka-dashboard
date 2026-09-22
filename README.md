# Asuka Langley Command Center

Dark-mode ops dashboard for conversations with the Asuka Langley Grokbot agent.

- Reminders (add / complete / remove) — synced with Asuka SMS
- Calendar of due dates **and lead appointments**
- Notes
- Attachments
- CRM kanban: New Lead, **Appointment Set**, Proposal Sent, Closed/Won, Lost — SMS leads land in **New Lead**
  - per-lead timestamped **note log** (add / delete), editable background block, lead search
  - leads in Appointment Set carry an appointment date/time that shows on the Calendar and the Overview
- **Customers** tab: company, contact, address, phone, email, website, notes; per-customer
  transactions (**+** → check / cash / card) with all-time and month totals
  - **⟳ SYNC STRIPE** pulls Stripe customers + succeeded charges (`STRIPE_SECRET_KEY`); it only
    fills blank fields and dedupes by Stripe id, so manual corrections are never overwritten
  - **Real-time**: Stripe calls `POST /api/stripe/webhook` (signature-verified with
    `STRIPE_WEBHOOK_SECRET`) on charge succeeded/updated/refunded and customer created/updated,
    so a sale shows up on the board within seconds; a daily Vercel Cron (`vercel.json`, 02:15 PT)
    re-runs the full sync as a safety net (`CRON_SECRET`)
- **Password gate**: set `ASUKA_DASHBOARD_PASSWORD` and the whole board (UI + `/api/state`) requires
  a login; `/api/sync` keeps its own bearer token so the Asuka bot is unaffected
- JSON export / import (local backup) + Vercel Blob server vault

```bash
npm install
npm run dev     # without BLOB_READ_WRITE_TOKEN it persists to ./.asuka-local-state.json (gitignored)
```

## Env vars (Vercel)

- `BLOB_READ_WRITE_TOKEN` — Vercel Blob read/write token (the vault)
- `ASUKA_SYNC_TOKEN` — shared secret for Asuka → dashboard sync (also accepted as a bearer on `/api/state`)
- `ASUKA_DASHBOARD_PASSWORD` — enables the login gate; leave unset to run the board open
- `ASUKA_SESSION_SECRET` — signs the session cookie (falls back to the password if unset)
- `STRIPE_SECRET_KEY` — Digital Horizon Stripe key (a restricted key with Customers + Charges read is enough) for **⟳ SYNC STRIPE**
- `STRIPE_WEBHOOK_SECRET` — signing secret of the Stripe webhook endpoint pointed at `/api/stripe/webhook`
- `CRON_SECRET` — lets Vercel Cron call `/api/stripe/sync` through the gate

## Local dev

`.env.local` (gitignored) is the place for local values, e.g. `ASUKA_DASHBOARD_PASSWORD=localtest`.
If your shell already exports a production `BLOB_READ_WRITE_TOKEN`, clear it for the dev server so you
don't write to the live vault: `set BLOB_READ_WRITE_TOKEN=&& npm run dev` (cmd).

## Sync API (Asuka)

Base URL: your deployment origin.

### Health

```bash
curl -X POST "$DASHBOARD_URL/api/sync" \
  -H "Authorization: Bearer $ASUKA_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"ping"}'
```

### Replace all reminders (full sync from Asuka)

```bash
curl -X POST "$DASHBOARD_URL/api/sync" \
  -H "Authorization: Bearer $ASUKA_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"replace_reminders","reminders":[{"id":"r6","title":"Setup Bev","notes":"","dueAt":"2026-09-11","time":"09:30","priority":"medium","done":false,"createdAt":"2026-09-10T19:10:18Z","source":"asuka"}]}'
```

### Upsert one reminder

```bash
curl -X POST "$DASHBOARD_URL/api/sync" \
  -H "Authorization: Bearer $ASUKA_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"upsert_reminder","reminder":{"id":"r11","title":"Call chamber","notes":"","dueAt":"2026-09-12","time":"09:30","priority":"medium","done":false,"createdAt":"2026-09-11T16:00:00Z","source":"asuka"}}'
```

### Resolve / remove

```bash
curl -X POST "$DASHBOARD_URL/api/sync" \
  -H "Authorization: Bearer $ASUKA_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"resolve_reminder","id":"r6"}'
```

### Upsert CRM lead (SMS → New Lead)

Text pattern Asuka understands:

`Lead: Jane Doe, Acme Co, jane@acme.com, 775-555-0100`

The upsert is **partial**: fields you don't send are kept from the existing record, so a re-sync never
wipes dashboard-side `noteLog`, `stage`, or `appointmentAt`.

```bash
curl -X POST "$DASHBOARD_URL/api/sync" \
  -H "Authorization: Bearer $ASUKA_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"upsert_lead","lead":{"id":"l_jane","name":"Jane Doe","company":"Acme Co","email":"jane@acme.com","phone":"775-555-0100","value":0,"stage":"new_lead","notes":"via SMS","createdAt":"2026-09-10T20:00:00Z","updatedAt":"2026-09-10T20:00:00Z"}}'
```

Lead shape: `{ id, name, company, email, phone, value, stage, notes, noteLog: [{id, body, createdAt}], appointmentAt?: "YYYY-MM-DDTHH:MM", createdAt, updatedAt }`.
Stages: `new_lead | appointment_set | proposal_sent | closed_won | lost`.

Customer shape: `{ id, company, contact, address, phone, email, website, notes, transactions: [{id, amount, method: "check"|"cash"|"card", date: "YYYY-MM-DD", memo, createdAt, stripeId?}], stripeCustomerId?, createdAt, updatedAt }`.

Browser UI uses same-origin `GET/POST /api/state` (session cookie, or `Authorization: Bearer $ASUKA_SYNC_TOKEN` for scripts) and polls about every 20s while the tab is visible.
