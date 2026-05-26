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

## Health Check

Visit `https://your-railway-url.up.railway.app/health` to confirm the server is running.

---

## Upgrading Later

- **Persistent memory**: Swap the in-memory `conversations` object for Supabase
- **Escalation**: Add logic to ping Slack when someone says "ready to sign up" or "talk to Jason"
- **Instagram/FB**: Same architecture, different GHL webhook event types
- **Tuning**: Edit the `SYSTEM_PROMPT` in server.js to refine voice and behavior
