# SOF Bot — GHL AI Messaging Bot

A lightweight AI bot that connects your GHL phone number to Claude, 
enabling real conversational AI responses to pre-webinar questions.

## How It Works

1. Someone texts your GHL number
2. GHL fires a webhook to this server
3. Server sends the message to Claude (with full conversation history)
4. Claude replies using your SOF system prompt
5. Reply gets sent back via GHL API to the person's phone

---

## Deploy to Railway (10 min)

### Step 1 — Push to GitHub
Create a new private GitHub repo and push this folder to it.

### Step 2 — Deploy on Railway
1. Go to https://railway.app and sign up
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repo — Railway auto-detects Node.js

### Step 3 — Add Environment Variables
In Railway dashboard → your service → Variables, add:
- `ANTHROPIC_API_KEY` — from https://console.anthropic.com
- `GHL_API_KEY` — from GHL > Settings > API Keys

### Step 4 — Get Your Public URL
Railway gives you a URL like: `https://sof-bot-production.up.railway.app`
Copy it — you need it for the GHL webhook.

---

## Configure GHL Webhook

1. In GHL go to: **Settings → Webhooks**
2. Create a new webhook
3. Set URL to: `https://your-railway-url.up.railway.app/webhook/ghl`
4. Select event: **Inbound Message**
5. Save

---

## Test It

Send a text to your GHL number. You should get an AI reply within a few seconds.

Check Railway logs to see the conversation in real time.

---

## Workshop Schedule (team-editable)

The schedule lives in Postgres and is edited at:

**`https://sof-bot-production.up.railway.app/schedule`**

Sign in with your first name plus the shared team password (`SCHEDULE_PASSWORD`
env var). You can add, edit, and remove workshop dates; the bot picks up changes
within 60 seconds.

**Audit trail.** Your name is signed into the session cookie and stamped onto
`updated_by` on every write, shown in the "Last edited" column as
`Ashley · 2d ago`. The name is covered by the cookie's HMAC, so it can't be
edited client-side to attribute a change to someone else. This is accountability,
not authentication — everyone shares one password, so it answers "who moved
July 22?" rather than gating access per person.

Changing `SCHEDULE_PASSWORD` invalidates every existing session, which is what
you want when someone leaves the team.

**Enter Pacific wall-clock time.** Type `9:00 AM` and it stays 9am Pacific across
daylight saving — Postgres does the offset conversion via `AT TIME ZONE`. Nobody
enters `-07:00` / `-08:00` by hand anymore.

### How the data flows

| Layer | File | Role |
|---|---|---|
| Table | `workshops` on **Postgres--SN8** | source of truth |
| Access | `db.js` | SQL, schema creation, seeding |
| Cache | `schedule-store.js` | in-memory, refreshed every 60s and on every edit |
| Auth | `schedule-auth.js` | HMAC-signed cookie, shared password, editor name |
| UI | `schedule-page.js` | the `/schedule` page |
| Fallback | `workshop-schedule.js` | seed on first boot + outage fallback only |

If Postgres is unreachable the bot serves its last good read; if it never got
one, it uses `workshop-schedule.js`; if that's exhausted, it falls back to
"next Saturday 9am PT". It cannot end up with no date.

> ⚠️ `Postgres--SN8` is the sof-bot database. `Postgres-ENka` in the same Railway
> project is **tfc-platform production** (members, payments). Never point
> `DATABASE_URL` here at ENka.

The schema is created automatically on boot (`CREATE TABLE IF NOT EXISTS`), so
there's no manual migration step. To inspect or verify it:

```
DATABASE_URL="$(railway variables --service Postgres--SN8 --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" node test-schedule-db.mjs
```

---

## Health Check

Visit `https://your-railway-url.up.railway.app/health` to confirm the server is running.

---

## Upgrading Later

- **Persistent memory**: Swap the in-memory `conversations` object for Supabase
- **Escalation**: Add logic to ping Slack when someone says "ready to sign up" or "talk to Jason"
- **Instagram/FB**: Same architecture, different GHL webhook event types
- **Tuning**: Edit the `SYSTEM_PROMPT` in server.js to refine voice and behavior
