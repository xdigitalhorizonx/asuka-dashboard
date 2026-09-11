# Asuka Langley Command Center

Dark-mode ops dashboard for conversations with the Asuka Langley Grokbot agent.

- Reminders (add / complete / remove) — synced with Asuka SMS
- Calendar of due dates
- Notes
- Attachments
- CRM kanban: New Lead, Proposal Sent, Closed/Won, Lost — SMS leads land in **New Lead**
- Lead call notes: timestamped notes on a lead (newest first), persisted with CRM state
- JSON export / import (local backup) + Vercel Blob server vault

```bash
npm install
npm run dev
```

## Env vars (Vercel)

- `BLOB_READ_WRITE_TOKEN` — Vercel Blob read/write token
- `ASUKA_SYNC_TOKEN` — shared secret for Asuka → dashboard sync

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

```bash
curl -X POST "$DASHBOARD_URL/api/sync" \
  -H "Authorization: Bearer $ASUKA_SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"upsert_lead","lead":{"id":"l_jane","name":"Jane Doe","company":"Acme Co","email":"jane@acme.com","phone":"775-555-0100","value":0,"stage":"new_lead","notes":"via SMS","createdAt":"2026-09-10T20:00:00Z","updatedAt":"2026-09-10T20:00:00Z"}}'
```

Browser UI uses same-origin `GET/POST /api/state` (no bearer) and polls about every 20s while the tab is visible.
