import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_ALERT_CHANNEL = "C0B5E3MBXST";
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const BOOKING_LINK = process.env.BOOKING_LINK || "https://api.leadconnectorhq.com/widget/bookings/tfcapplication";

// Local-test-only conversation map — used when no contactId (tester UI)
// Production always seeds fresh from GHL every request
const testConversations = new Map();

// ─── Workshop date ───────────────────────────────────────────────────────────

let cachedWorkshopDate = null;
let workshopDateCachedAt = null;
const CACHE_TTL = 6 * 60 * 60 * 1000; // refresh every 6 hours

async function fetchWorkshopDate() {
  try {
    const res = await fetch("https://webinar.saintsofflow.com");
    const html = await res.text();
    // Matches patterns like "Saturday, May 30th @ 9:00am PST" or "Saturday, May 30th @ 9am PST"
    const match = html.match(/(\w+),\s+(\w+)\s+(\d+)\w*\s+@\s+(\d+)(?::(\d+))?(am|pm)\s*(PST|PDT|PT)/i);
    if (!match) {
      console.error("Could not parse workshop date from site");
      return null;
    }
    const [, , monthName, day, hour, minute = "00", ampm] = match;
    const months = { January:0, February:1, March:2, April:3, May:4, June:5,
                     July:6, August:7, September:8, October:9, November:10, December:11 };
    const monthIdx = months[monthName];
    if (monthIdx === undefined) return null;

    let h = parseInt(hour);
    if (ampm.toLowerCase() === "pm" && h !== 12) h += 12;
    if (ampm.toLowerCase() === "am" && h === 12) h = 0;

    // Pacific time: PDT (UTC-7) Mar-Nov, PST (UTC-8) Nov-Mar
    const tzOffset = (monthIdx >= 2 && monthIdx <= 10) ? -7 : -8;
    const offsetStr = `${tzOffset < 0 ? "-" : "+"}${String(Math.abs(tzOffset)).padStart(2, "0")}:00`;

    const year = new Date().getFullYear();
    const dateStr = `${year}-${String(monthIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${minute}:00${offsetStr}`;
    let workshopDate = new Date(dateStr);

    // If date is already more than a day in the past, try next year
    if (workshopDate < new Date(Date.now() - 24 * 60 * 60 * 1000)) {
      workshopDate = new Date(dateStr.replace(`${year}-`, `${year + 1}-`));
    }

    console.log(`Workshop date fetched from site: ${workshopDate}`);
    return workshopDate;
  } catch (err) {
    console.error("Failed to fetch workshop date from site:", err);
    return null;
  }
}

function nextSaturdayAt9amPT() {
  const now = new Date();
  const ptNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const day = ptNow.getDay(); // 0=Sun, 6=Sat
  const daysUntilSat = day === 6 ? 7 : (6 - day); // if today is Sat, use next Sat
  const sat = new Date(ptNow);
  sat.setDate(ptNow.getDate() + daysUntilSat);
  sat.setHours(9, 0, 0, 0);
  const month = sat.getMonth();
  const tzOffset = (month >= 2 && month <= 10) ? -7 : -8;
  return new Date(sat.getTime() - tzOffset * 60 * 60 * 1000);
}

async function getWorkshopDate() {
  const now = Date.now();
  if (cachedWorkshopDate && workshopDateCachedAt && (now - workshopDateCachedAt) < CACHE_TTL) {
    return cachedWorkshopDate;
  }
  const date = await fetchWorkshopDate();
  if (date) {
    cachedWorkshopDate = date;
    workshopDateCachedAt = now;
  }
  return cachedWorkshopDate || nextSaturdayAt9amPT();
}

// ─── System prompt ───────────────────────────────────────────────────────────

// module-level so validateReply can access current context without re-building
let timeContext = "";

async function buildSystemPrompt() {
  const now = new Date();
  const workshopTime = await getWorkshopDate();
  const minutesUntil = Math.round((workshopTime - now) / 60000);
  const workshopDateLabel = workshopTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
  const nextWorkshopTime = new Date(workshopTime.getTime() + 7 * 24 * 60 * 60 * 1000);
  const nextWorkshopDateLabel = nextWorkshopTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
  const nextWorkshopDayOfWeek = process.env.NEXT_WORKSHOP_DAY_OVERRIDE || nextWorkshopTime.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Los_Angeles" });

  // Compare calendar dates in PT so "22 hours away" doesn't get treated as "day of"
  const nowPT = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const workshopPT = new Date(workshopTime.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const isWorkshopDay = nowPT.toDateString() === workshopPT.toDateString();

  if (minutesUntil <= 0 && minutesUntil > -120) {
    timeContext = `The workshop is live right now.`;
  } else if (minutesUntil <= -120) {
    timeContext = `The workshop has already ended.`;
  } else if (!isWorkshopDay && minutesUntil <= 60 * 24) {
    timeContext = `The workshop is tomorrow, ${workshopDateLabel}, at 9am pt.`;
  } else if (!isWorkshopDay) {
    timeContext = `The workshop is coming up on ${workshopDateLabel} at 9am pt.`;
  } else if (minutesUntil > 90) {
    timeContext = `Today is the workshop day (${workshopDateLabel}) but it hasn't started yet.`;
  } else {
    timeContext = `${minutesUntil} minutes until the workshop starts — almost live!`;
  }

  return `You are a warm, human-sounding assistant for Saints of Flow, Jason Crouse's coaching brand. You text with people who have registered for the Big Three Mastery Workshop.

FIRST: Read the full conversation history before responding. The most recent outbound message (from us) tells you exactly what this person is responding to — let that guide everything.

TIME CONTEXT: ${timeContext}

WORKSHOP DETAILS:
- Name: The Big Three Mastery Workshop
- Host: Jason Crouse
- Date: ${workshopDateLabel} at 9am pt (10am mt / 11am ct / 12pm et)
- Cost: free
- Length: about 75-90 minutes including Q&A
- Platform: Zoom — link sent via email and texted the morning of the event
- What it covers: the Big Three — turning your calling into an actual career, attracting the right kind of love, building real confidence by keeping promises to yourself

---

HOW TO READ YOUR CONTEXT — look at what the last outbound message was, then respond accordingly:

IF THE LAST OUTBOUND MESSAGE ASKED WHICH OF THE BIG THREE THEY'RE MOST FOCUSED ON:
(something about career & purpose, love & relationships, confidence & self-trust — or "which area are you most focused on" — anything asking them to pick one of the three)
→ This is our team's personal outreach after a missed call. Respond warmly and briefly no matter what they answered. Example: "awesome — I've actually been hearing that a lot. I think you're gonna love tomorrow 🙌🏼" Keep it short. Don't ask follow-up questions.

IF THE LAST OUTBOUND MESSAGE WAS THE POST-WORKSHOP SURVEY:
(asking them to reply 1, 2, 3, or 4 about where they're at after the workshop)
→ Handle their reply:

  Reply was 1 (didn't find it valuable):
  Return exactly this and nothing else: [DND]

  Reply was 2 (couldn't pay full attention / wants to join the next one):
  Warm reply, confirm them for next Saturday. Tell them you'll get them added for ${nextWorkshopDateLabel} at 9am pt.
  End your message with [NEXT_WEEK_SIGNUP] on its own line.

  Reply was 3 (found it valuable but something is holding them back):
  You're in a Chris Voss low-pressure enrollment conversation. Goal: understand their block and gently open the door to a next step — not to sell, not to convince.
  - Round 1: One calibrated what/how question. Example: "what would need to be different for this to feel like the right time?"
  - Round 2: Reflect back what they said, then go one level deeper with another what/how question.
  - Round 3+: Move toward a call with a no-oriented question: "would you be opposed to a quick conversation with Jason just to explore it — no pressure at all, just to see if it's a fit?"
  - If they say yes or seem open: give them the booking link (${BOOKING_LINK}), then add [HANDOFF] on its own line at the very end.
  - If they say no or disengage: close warmly. "totally get it, I really appreciate you sharing that with me 🫶🏼"
  One question at a time. Short messages. Zero selling energy.

  Reply was 4 (found it valuable but finances are a barrier):
  Send: "thanks so much for being real about that 🫶🏼 we never want finances to be the only thing standing in the way — we actually have some lower-cost and sliding scale options now. if you'd like to explore what might work for your budget, feel free to book a quick call: ${BOOKING_LINK}"
  Then add [HANDOFF] on its own line.

  Reply was something outside 1-4 (a sentence, "5", unexpected text):
  Respond warmly as if they're sharing feedback. Acknowledge what they said and ask one genuine follow-up question.

IF THE LAST OUTBOUND MESSAGE ASKED THEM TO REPLY 1 TO CONFIRM THEIR BOOKING:
→ They're confirming a call. Reply: "awesome! thanks so much — looking forward to meeting you 🙌🏼"

ALL OTHER CONTEXTS (pre-workshop logistics, general check-ins, questions, no clear prior context):
→ Pre-workshop assistant mode. Help them warmly with whatever they need.

---

PRE-WORKSHOP — WHAT TO KNOW:

Common questions:
- Time → 9am pt on ${workshopDateLabel}. Other time zones only if asked.
- Zoom link → sent in their confirmation email, also texted the morning of.
- Replay → there is one, but live is way better since it's interactive. Only mention if they ask or explicitly say they can't make it.
- Friend → they can join on the same Zoom link, no separate registration needed. If they want the follow-up materials, they can register at webinar.saintsofflow.com.
- Confirmation email → check spam. Jason's team can resend — ask what email they used.
- Length → plan for 75-90 minutes.
- Cost → completely free.
- What to bring → just themselves, maybe pen and paper, somewhere they can focus.
- Future workshops → webinar.saintsofflow.com

Attendance situations:
- Explicitly can't make it this week → ask warmly "are you around next ${nextWorkshopDayOfWeek}?" and leave it there.
- Yes to next Saturday → confirm them for ${nextWorkshopDateLabel} at 9am pt. Add [NEXT_WEEK_SIGNUP] on its own line at the very end.
- No to next Saturday or unsure → mention the replay warmly, point to webinar.saintsofflow.com.
- Can NEVER do Saturdays (works every Saturday, can't do weekends, etc.) → warm reply, mention the replay, point to webinar.saintsofflow.com for future dates. Add [NEVER_SATURDAYS] on its own line at the very end. Do NOT ask about next Saturday.
- AMBIGUOUS situation (traveling, driving somewhere, in Europe, might be busy — but hasn't explicitly said they can't attend) → ask one clarifying question: "oh nice — are you thinking you won't be able to make it, or might you be able to catch it from there?" Do NOT assume they can't attend. Never jump to the replay or next Saturday.
- Replying to a missed call follow-up, can't call back right now → acknowledge warmly, let them know they can text any questions anytime. Do not ask about the workshop.

Reading short replies:
Always check what the last outbound message was before interpreting "yes", "no", "ok", "sure", "yes sir", "👍" — these are responses to whatever was just asked.
- Prior message asked if they have questions + they say "yes" or "yes sir" → they have a question. Ask warmly what it is.
- Prior message asked if they have questions + they say "no", "none", "no no questions" → they don't. Respond warmly. Never interpret this as "no I can't attend."
- Prior message asked about next Saturday + they say "yes" → they're available. Confirm them.

Out of scope → if they ask about The Flow Code, TFC, coaching program pricing, or anything you genuinely don't know: reply with exactly OUTOFSCOPE and nothing else.

---

TONE AND STYLE:
- Warm, genuine — like a real person on Jason's team who actually cares
- Texty and casual — run-on sentences, lowercase at the start sometimes, contractions always
- No em dashes. No corporate language. Never sound like a bot.
- Time formats: "9am" not "9:00am", "pt" not "Pacific Time" or "PST"
- Emojis: natural and occasional, rotate 😊 😄 🙌🏼 🫶🏼 — max one per reply
- Warm and complete but short enough to feel like a text, not an email
- Match sign-off to time context — never say "see you tomorrow" if it's the day of or already ended

INTERNAL TOKENS — stripped before sending, never visible to the contact:
[NEXT_WEEK_SIGNUP] — bot confirmed them for next Saturday
[NEVER_SATURDAYS] — contact can't do Saturdays, add GHL tag
[DND] — survey reply 1, apply DND in GHL, no message sent
[HANDOFF] — booking link was provided, alert the team
OUTOFSCOPE — out of scope, alert the team, no message sent`;
}

// ─── GHL helpers ─────────────────────────────────────────────────────────────

async function getGHLConversationHistory(contactId) {
  if (!contactId || !GHL_API_KEY || !GHL_LOCATION_ID) return [];
  try {
    // Step 1: find the conversation for this contact
    const searchRes = await fetch(
      `https://services.leadconnectorhq.com/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contactId}`,
      {
        headers: {
          "Authorization": `Bearer ${GHL_API_KEY}`,
          "Version": "2021-04-15",
        },
      }
    );
    const searchData = await searchRes.json();
    const conversationId = searchData?.conversations?.[0]?.id;
    if (!conversationId) return [];

    // Step 2: fetch the last 20 SMS messages (more context for multi-turn post-webinar conversations)
    const msgsRes = await fetch(
      `https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=20`,
      {
        headers: {
          "Authorization": `Bearer ${GHL_API_KEY}`,
          "Version": "2021-04-15",
        },
      }
    );
    const msgsData = await msgsRes.json();
    const messages = msgsData?.messages?.messages || msgsData?.messages || [];

    // Step 3: map to Claude format — SMS only, reverse to chronological order
    // GHL returns newest-first; Claude needs oldest-first
    const smsMessages = messages
      .filter(m => m.body && m.body.trim() && m.messageType !== "TYPE_EMAIL" && m.type !== 3)
      .reverse()
      .map(m => ({
        role: m.direction === "inbound" ? "user" : "assistant",
        content: m.body,
      }));

    console.log(`GHL history: ${smsMessages.length} SMS messages for ${contactId}`);
    smsMessages.forEach((m, i) => console.log(`  [${i + 1}] ${m.role}: "${m.content?.slice(0, 80)}"`));
    return smsMessages;
  } catch (err) {
    console.error("GHL history fetch error:", err);
    return [];
  }
}

async function hasHumanActiveTag(contactId) {
  if (!contactId || !GHL_API_KEY) return false;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: {
        "Authorization": `Bearer ${GHL_API_KEY}`,
        "Version": "2021-04-15",
      },
    });
    const data = await res.json();
    const tags = data?.contact?.tags || [];
    console.log("Contact tags:", tags);
    return tags.includes("human-active");
  } catch (err) {
    console.error("GHL tag check error:", err);
    return false; // fail open — let bot respond if we can't check
  }
}

async function sendGHLReply(contactId, message) {
  await fetch("https://services.leadconnectorhq.com/conversations/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GHL_API_KEY}`,
      "Version": "2021-04-15",
    },
    body: JSON.stringify({ type: "SMS", contactId, message }),
  });
}

async function addGHLTag(contactId, tag) {
  if (!contactId || !GHL_API_KEY) return;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GHL_API_KEY}`,
        "Version": "2021-04-15",
      },
      body: JSON.stringify({ tags: [tag] }),
    });
    console.log(`GHL tag "${tag}" added to ${contactId}: ${res.status}`);
  } catch (err) {
    console.error(`GHL tag error (${tag}):`, err);
  }
}

async function setGHLDND(contactId) {
  if (!contactId || !GHL_API_KEY) return;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GHL_API_KEY}`,
        "Version": "2021-07-28",
      },
      body: JSON.stringify({ dnd: true }),
    });
    console.log(`GHL DND set for ${contactId}: ${res.status}`);
  } catch (err) {
    console.error("GHL DND error:", err);
  }
}

// ─── Slack helpers ────────────────────────────────────────────────────────────

function ghlLink(contactId) {
  return contactId
    ? `\n<https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}|View in GHL>`
    : "";
}

async function sendSlackMessage(text) {
  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SLACK_TOKEN}` },
      body: JSON.stringify({ channel: SLACK_ALERT_CHANNEL, text }),
    });
  } catch (err) {
    console.error("Slack error:", err);
  }
}

// kept for backward compat — wraps sendSlackMessage with the standard handoff format
async function sendSlackAlert(contactInfo, message, contactId) {
  await sendSlackMessage(
    `🚨 *Bot handoff needed*\n*Contact:* ${contactInfo}\n*Their message:* "${message}"${ghlLink(contactId)}\n\nOut of scope — please follow up manually.`
  );
}

// ─── Validation ───────────────────────────────────────────────────────────────

async function validateReply(reply, conversationHistory, timeCtx, systemPrompt) {
  try {
    const lastUserMessage = [...conversationHistory].reverse().find(m => m.role === "user")?.content || "";
    const validation = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 150,
      system: `You are a quality checker for an SMS bot. Review the proposed reply and return a JSON object with:
- "score": integer 1-10 (10 = perfect, 1 = do not send)
- "issue": short description of the problem, or null if none

Fail immediately (score 1-3) if:
- Any internal token appears in the reply: OUTOFSCOPE, [DND], [NEXT_WEEK_SIGNUP], [NEVER_SATURDAYS], [HANDOFF]
- The reply says "see you tomorrow" or "tomorrow" when the time context says the workshop is today or already ended
- The reply makes no sense as a response to what the person said
- The reply sounds robotic, corporate, or reveals it's a bot
- The reply states something that contradicts the bot's policy guidelines (wrong info on replays, bringing guests, confirmation emails, etc.)
- The reply asks about next Saturday when the person said they can never do Saturdays, or when they were replying to a phone call follow-up (not saying they can't attend)
- The reply confidently answers a question but gets the policy wrong

Score 7-10 only if the reply is warm, contextually appropriate, human-sounding, AND factually consistent with the bot's guidelines.
Respond with raw JSON only, no markdown.`,
      messages: [{
        role: "user",
        content: `Bot policy guidelines:\n${systemPrompt}\n\n---\n\nTime context: ${timeCtx}\n\nLast message from person: "${lastUserMessage}"\n\nProposed reply: "${reply}"`
      }]
    });
    const jsonMatch = validation.content[0].text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in validator response");
    const result = JSON.parse(jsonMatch[0]);
    console.log(`Validation: ${result.score}/10${result.issue ? ` — ${result.issue}` : ""}`);
    return result;
  } catch (err) {
    console.error("Validation error:", err);
    return { score: 10, issue: null }; // fail open — don't block on validator error
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

async function logToSheet({ contactName, contactPhone, contactId, message, triage, reply, nextWeekSignup, confidence }) {
  const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        contactName: contactName || "",
        contactPhone: contactPhone || "",
        contactId: contactId || "",
        message,
        triage: triage || "CONTEXTUAL",
        reply: reply || "",
        nextWeekSignup: !!nextWeekSignup,
        confidence: confidence ?? null,
      }),
    });
  } catch (err) {
    console.error("Sheet log error:", err);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function typingDelay(text) {
  const len = text.length;
  let base;
  if (len < 80) base = 14;
  else if (len < 200) base = 31;
  else base = 53;
  const jitter = base * 0.25;
  return Math.round((base + (Math.random() * jitter * 2 - jitter)) * 1000);
}

// ─── Main chat endpoint ───────────────────────────────────────────────────────

app.post("/chat", async (req, res) => {
  console.log("Incoming payload:", JSON.stringify(req.body, null, 2));

  const contactId = req.body.customData?.contactId || req.body.contact_id;
  const contactName = req.body.customData?.contactName || req.body.full_name;
  const contactPhone = req.body.customData?.contactPhone || req.body.phone;

  // GHL sends message as an object { type, body } — extract the text correctly
  const rawMessage = req.body.message;
  const messageText = (typeof rawMessage === "object" ? rawMessage?.body : rawMessage) || req.body.customData?.message || "";
  if (!messageText.trim()) return res.status(400).json({ error: "No message" });

  console.log("Message:", messageText, "| Contact:", contactId);

  // Human-active tag → stand down silently
  const humanActive = await hasHumanActiveTag(contactId);
  if (humanActive) {
    console.log("human-active tag — bot standing down");
    return res.json({ reply: null, humanActive: true });
  }

  // ── Seed conversation history ────────────────────────────────────────────
  // Production (has contactId): always fetch fresh from GHL — no stale in-memory state
  // Local test (no contactId): use testConversations Map seeded via /seed
  let history;
  if (contactId) {
    history = await getGHLConversationHistory(contactId);
    // GHL may have already logged this inbound before firing the webhook — deduplicate
    if (history.length && history[history.length - 1].role === "user" && history[history.length - 1].content === messageText) {
      history.pop();
    }
  } else {
    history = [...(testConversations.get("local-test") || [])];
  }
  history.push({ role: "user", content: messageText });

  // ── Build system prompt and call Claude ─────────────────────────────────
  const systemPrompt = await buildSystemPrompt();

  let reply;
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      system: systemPrompt,
      messages: history.slice(-20),
    });
    reply = response.content[0].text;
  } catch (err) {
    console.error("Claude error:", err);
    return res.status(500).json({ error: "Bot failed" });
  }

  const contactInfo = contactName || contactPhone || contactId || "Unknown";

  // ── Handle [DND] — survey reply 1, didn't find it valuable ──────────────
  if (reply.trim() === "[DND]" || reply.includes("[DND]")) {
    console.log("Survey reply 1 — applying DND");
    await setGHLDND(contactId);
    await sendSlackMessage(
      `📋 *Survey: didn't find it valuable*\n*Contact:* ${contactInfo}${ghlLink(contactId)}\nDND applied. No reply sent.`
    );
    logToSheet({ contactName, contactPhone, contactId, message: messageText, triage: "POST_SURVEY_DND", reply: "[DND applied]", nextWeekSignup: false, confidence: null });
    return res.json({ reply: null, dnd: true });
  }

  // ── Handle OUTOFSCOPE ────────────────────────────────────────────────────
  if (reply.trim() === "OUTOFSCOPE" || reply.includes("OUTOFSCOPE")) {
    console.log("OUTOFSCOPE — alerting Slack");
    await sendSlackAlert(contactInfo, messageText, contactId);
    logToSheet({ contactName, contactPhone, contactId, message: messageText, triage: "OUTOFSCOPE", reply: "", nextWeekSignup: false, confidence: null });
    return res.json({ reply: null, outOfScope: true });
  }

  // ── Extract and strip all internal tokens ────────────────────────────────
  const nextWeekSignup = reply.includes("[NEXT_WEEK_SIGNUP]");
  const neverSaturdays = reply.includes("[NEVER_SATURDAYS]");
  const handoff = reply.includes("[HANDOFF]");
  reply = reply
    .replace(/\[NEXT_WEEK_SIGNUP\]/g, "")
    .replace(/\[NEVER_SATURDAYS\]/g, "")
    .replace(/\[HANDOFF\]/g, "")
    .trim();

  // ── Validate ─────────────────────────────────────────────────────────────
  const validation = await validateReply(reply, history, timeContext, systemPrompt);
  let finalScore = validation.score;
  let wasRetried = false;
  let origScoreForLog = null;

  if (validation.score < 7) {
    const origScore = validation.score;
    const origIssue = validation.issue;
    const origReply = reply;
    origScoreForLog = origScore;
    console.log(`Low confidence (${origScore}/10) — retrying. Issue: "${origIssue}"`);

    try {
      const retryRes = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [
          ...history.slice(-20),
          { role: "assistant", content: origReply },
          { role: "user", content: `[INTERNAL]: Your reply had a quality issue: "${origIssue || "quality too low"}". Please rewrite it.` },
        ],
      });
      const retryReply = retryRes.content[0].text
        .replace(/\[NEXT_WEEK_SIGNUP\]/g, "")
        .replace(/\[NEVER_SATURDAYS\]/g, "")
        .replace(/\[HANDOFF\]/g, "")
        .trim();
      const retryValidation = await validateReply(retryReply, history, timeContext, systemPrompt);
      finalScore = retryValidation.score;
      console.log(`Retry: ${finalScore}/10 (was ${origScore}/10)`);

      if (finalScore >= 7) {
        reply = retryReply;
        wasRetried = true;
      }
    } catch (err) {
      console.error("Retry error:", err);
      finalScore = 0;
    }

    // Still below threshold after retry — block and alert
    if (finalScore < 7) {
      console.log(`Blocking after retry (${origScoreForLog}→${finalScore}/10)`);
      await sendSlackMessage(
        `⚠️ *Reply blocked after retry (${origScoreForLog}→${finalScore}/10)*\n*Contact:* ${contactInfo}\n*Issue:* ${validation.issue || "unknown"}\n*Their message:* "${messageText}"${ghlLink(contactId)}\n\nBoth attempts failed — please follow up manually.`
      );
      logToSheet({ contactName, contactPhone, contactId, message: messageText, triage: "BLOCKED", reply: `[BLOCKED ${origScoreForLog}→${finalScore}] ${reply}`, nextWeekSignup, confidence: origScoreForLog });
      return res.json({ reply: null, blocked: true, confidence: origScoreForLog, retryScore: finalScore });
    }
  }

  // ── Fire side effects (reply is confirmed good) ──────────────────────────

  if (nextWeekSignup) {
    await sendSlackMessage(
      `📋 *Next week signup*\n*Contact:* ${contactInfo}${ghlLink(contactId)}\nConfirmed for next Saturday — please add them to the list.`
    );
    await addGHLTag(contactId, "reschedule");
  }

  if (neverSaturdays) {
    await addGHLTag(contactId, "never-saturdays");
    console.log(`never-saturdays tag added for ${contactId}`);
  }

  if (handoff) {
    await sendSlackMessage(
      `🔥 *Ready for a call*\n*Contact:* ${contactInfo}\n*Their message:* "${messageText}"${ghlLink(contactId)}\nBot provided booking link — follow up to confirm the call.`
    );
  }

  // Update local test history so the tester stays coherent across messages
  if (!contactId) {
    history.push({ role: "assistant", content: reply });
    testConversations.set("local-test", history);
  }

  // ── Log and send ─────────────────────────────────────────────────────────
  const triagetag = ["CONTEXTUAL", nextWeekSignup && "NEXT_WEEK", neverSaturdays && "NEVER_SAT", handoff && "HANDOFF"].filter(Boolean).join("+");
  const sheetReply = wasRetried ? `[RETRIED ${origScoreForLog}→${finalScore}] ${reply}` : reply;
  logToSheet({ contactName, contactPhone, contactId, message: messageText, triage: triagetag, reply: sheetReply, nextWeekSignup, confidence: finalScore });

  const delay = typingDelay(reply);
  console.log(`Typing delay: ${Math.round(delay / 1000)}s for ${reply.length} char reply`);

  if (contactId) {
    // Respond to GHL webhook immediately so it doesn't time out,
    // then wait the delay before actually sending the SMS
    res.json({ reply, sent: true });
    await sleep(delay);
    try {
      await sendGHLReply(contactId, reply);
    } catch (err) {
      console.error("GHL send error:", err);
    }
  } else {
    // Local tester — no delay
    res.json({ reply });
  }
});

// ─── Other routes (unchanged) ─────────────────────────────────────────────────

app.get("/invite.ics", async (req, res) => {
  const attendeeEmail = req.query.email || "";
  const attendeeName = req.query.name || attendeeEmail;
  const workshopTime = await getWorkshopDate();
  const zoomUrl = process.env.ZOOM_JOIN_URL || "https://us06web.zoom.us/j/89066020696";

  const fmt = (d) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const dtstart = fmt(workshopTime);
  const dtend = fmt(new Date(workshopTime.getTime() + 90 * 60 * 1000));
  const dtstamp = fmt(new Date());
  const uid = `big-three-${workshopTime.toISOString().split("T")[0]}@saintsofflow.com`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Saints of Flow//Big Three Workshop//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    "SUMMARY:The Big Three Mastery Workshop",
    `UID:${uid}`,
    "ORGANIZER;CN=Jason Crouse:mailto:jason@saintsofflow.com",
    attendeeEmail
      ? `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;RSVP=TRUE;CN=${attendeeName}:mailto:${attendeeEmail}`
      : "",
    `DESCRIPTION:Join Jason Crouse for The Big Three Mastery Workshop — mastering career\\, love\\, and confidence.\\n\\nJoin via Zoom:\\n${zoomUrl}`,
    `LOCATION:${zoomUrl}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT60M",
    "ACTION:DISPLAY",
    "DESCRIPTION:The Big Three Mastery Workshop starts in 1 hour!",
    "END:VALARM",
    "BEGIN:VALARM",
    "TRIGGER:-PT10M",
    "ACTION:DISPLAY",
    "DESCRIPTION:The Big Three Mastery Workshop starts in 10 minutes!",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");

  res.setHeader("Content-Type", "text/calendar; charset=utf-8; method=REQUEST");
  res.setHeader("Content-Disposition", 'attachment; filename="big-three-workshop.ics"');
  res.send(lines);
});

app.get("/conversation/:contactId", async (req, res) => {
  const { contactId } = req.params;
  const history = await getGHLConversationHistory(contactId);
  if (!history.length) return res.json({ contactId, messages: [], note: "No SMS history found" });
  res.json({
    contactId,
    messages: history.map((m, i) => ({
      index: i + 1,
      role: m.role === "user" ? "THEM" : "US",
      content: m.content,
    })),
  });
});

app.post("/reset", (req, res) => {
  testConversations.clear();
  res.json({ ok: true });
});

app.post("/seed", (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: "messages must be an array" });
  testConversations.set("local-test", messages);
  res.json({ ok: true, seeded: messages.length });
});

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>SOF Bot Tester</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f0e0c;--surface:#1a1916;--border:#2a2825;--gold:#c9a84c;--gold-dim:#7a6330;--text:#e8e4dc;--text-dim:#7a7670;--red:#e05555;--radius:16px}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;align-items:center}
.container{width:100%;max-width:680px;height:100vh;display:flex;flex-direction:column}
.header{padding:24px 28px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.header-left{display:flex;align-items:center;gap:12px}
.avatar{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--gold),#8a6020);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;color:#0f0e0c}
.header-title{font-size:15px;font-weight:600}
.header-sub{font-size:12px;color:var(--text-dim);margin-top:1px}
.badge{font-size:11px;font-family:'DM Mono',monospace;color:var(--gold);background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.2);padding:3px 10px;border-radius:20px}
.messages{flex:1;overflow-y:auto;padding:24px 28px;display:flex;flex-direction:column;gap:16px}
.message{display:flex;flex-direction:column;max-width:80%}
.message.user{align-self:flex-end;align-items:flex-end}
.message.bot{align-self:flex-start;align-items:flex-start}
.message.system{align-self:center;align-items:center;max-width:100%}
.bubble{padding:12px 16px;border-radius:var(--radius);font-size:14.5px;line-height:1.55}
.message.user .bubble{background:var(--gold);color:#0f0e0c;border-bottom-right-radius:4px;font-weight:500}
.message.bot .bubble{background:var(--surface);color:var(--text);border:1px solid var(--border);border-bottom-left-radius:4px}
.message.system .bubble{background:rgba(224,85,85,0.1);color:var(--red);border:1px solid rgba(224,85,85,0.2);border-radius:8px;font-size:12px;font-family:'DM Mono',monospace;text-align:center}
.label{font-size:11px;color:var(--text-dim);margin-bottom:5px;font-family:'DM Mono',monospace}
.typing{display:flex;gap:5px;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);border-bottom-left-radius:4px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--gold-dim);animation:pulse 1.2s ease-in-out infinite}
.dot:nth-child(2){animation-delay:0.2s}
.dot:nth-child(3){animation-delay:0.4s}
@keyframes pulse{0%,80%,100%{opacity:0.3;transform:scale(0.9)}40%{opacity:1;transform:scale(1.1)}}
.input-area{padding:16px 28px 24px;border-top:1px solid var(--border);flex-shrink:0}
.input-row{display:flex;gap:10px;align-items:flex-end}
textarea{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:12px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:14px;padding:12px 16px;resize:none;outline:none;min-height:46px;max-height:120px;line-height:1.5}
textarea:focus{border-color:var(--gold-dim)}
textarea::placeholder{color:var(--text-dim)}
button.send{width:46px;height:46px;border-radius:12px;background:var(--gold);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
button.send:disabled{opacity:0.3;cursor:not-allowed}
.footer{display:flex;align-items:center;justify-content:space-between;margin-top:10px}
.hint{font-size:11px;color:var(--text-dim)}
button.reset{font-size:11px;color:var(--text-dim);background:none;border:none;cursor:pointer;font-family:'DM Sans',sans-serif;padding:0}
button.reset:hover{color:var(--gold)}
.empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center}
.empty-icon{width:48px;height:48px;border-radius:50%;background:var(--surface);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;margin-bottom:4px;font-size:20px}
.empty-title{font-size:15px;font-weight:500;color:var(--text)}
.empty-sub{font-size:13px;color:var(--text-dim);max-width:280px;line-height:1.5}
.seed-panel{border-top:1px solid var(--border);padding:12px 28px;flex-shrink:0;background:var(--surface)}
.seed-toggle{font-size:11px;color:var(--text-dim);background:none;border:none;cursor:pointer;font-family:'DM Mono',monospace;padding:0;display:flex;align-items:center;gap:6px}
.seed-toggle:hover{color:var(--gold)}
.seed-body{display:none;margin-top:10px;flex-direction:column;gap:8px}
.seed-body.open{display:flex}
.seed-body textarea{min-height:90px;max-height:180px;font-size:12px;font-family:'DM Mono',monospace;line-height:1.6;resize:vertical}
.seed-actions{display:flex;gap:8px;align-items:center}
button.seed-load{font-size:12px;background:var(--gold);color:#0f0e0c;border:none;border-radius:8px;padding:6px 14px;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:600}
.seed-status{font-size:11px;color:var(--text-dim);font-family:'DM Mono',monospace}
</style>
</head>
<body>
<div class="container">
<div class="header">
  <div class="header-left">
    <div class="avatar">SF</div>
    <div>
      <div class="header-title">Saints of Flow Bot</div>
      <div class="header-sub">Big Three Mastery Workshop — registrant support</div>
    </div>
  </div>
  <div class="badge">LOCAL TEST</div>
</div>
<div class="messages" id="messages">
  <div class="empty-state" id="emptyState">
    <div class="empty-icon">💬</div>
    <div class="empty-title">Ask it anything</div>
    <div class="empty-sub">In-scope questions get a reply. Out-of-scope goes silent + fires a Slack alert.</div>
  </div>
</div>
<div class="input-area">
  <div class="input-row">
    <textarea id="input" placeholder="e.g. What time does it start?" rows="1" onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
    <button class="send" id="sendBtn" onclick="sendMessage()">
      <svg viewBox="0 0 24 24" fill="none" stroke="#0f0e0c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
    </button>
  </div>
  <div class="footer">
    <span class="hint">Enter to send</span>
    <button class="reset" onclick="resetConversation()">Reset conversation</button>
  </div>
</div>
<div class="seed-panel">
  <button class="seed-toggle" onclick="toggleSeed()">+ Set context</button>
  <div class="seed-body" id="seedBody" style="display:none">
    <textarea id="seedInput" placeholder="Paste prior conversation, one message per line:

BOT: Yoo, do you have any questions before tomorrow?
YOU: Traveling. Hope to be settled in time"></textarea>
    <div class="seed-actions">
      <button class="seed-load" onclick="loadSeed()">Load context</button>
      <span class="seed-status" id="seedStatus"></span>
    </div>
  </div>
</div>
</div>
<script>
const messagesEl=document.getElementById("messages");
const inputEl=document.getElementById("input");
const sendBtn=document.getElementById("sendBtn");
const emptyState=document.getElementById("emptyState");
let isLoading=false;
document.getElementById("seedInput").value="BOT: hey it's Jason Crouse's team. Do you have any questions before our live workshop tomorrow? Start time is 9am pt";
function autoResize(el){el.style.height="auto";el.style.height=Math.min(el.scrollHeight,120)+"px"}
function handleKey(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage()}}
function addMessage(role,text){
  if(emptyState)emptyState.style.display="none";
  const msg=document.createElement("div");
  msg.className="message "+role;
  const label=document.createElement("div");
  label.className="label";
  if(role==="user")label.textContent="YOU";
  else if(role==="bot")label.textContent="SOF BOT";
  else label.textContent="SYSTEM";
  const bubble=document.createElement("div");
  bubble.className="bubble";
  bubble.textContent=text;
  msg.appendChild(label);
  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  messagesEl.scrollTop=messagesEl.scrollHeight;
}
function showTyping(){
  if(emptyState)emptyState.style.display="none";
  const w=document.createElement("div");
  w.className="message bot";w.id="typing";
  const label=document.createElement("div");
  label.className="label";label.textContent="SOF BOT";
  const t=document.createElement("div");
  t.className="typing";
  t.innerHTML="<div class='dot'></div><div class='dot'></div><div class='dot'></div>";
  w.appendChild(label);w.appendChild(t);
  messagesEl.appendChild(w);
  messagesEl.scrollTop=messagesEl.scrollHeight;
}
function removeTyping(){const t=document.getElementById("typing");if(t)t.remove()}
async function sendMessage(){
  const text=inputEl.value.trim();
  if(!text||isLoading)return;
  isLoading=true;sendBtn.disabled=true;
  inputEl.value="";inputEl.style.height="auto";
  addMessage("user",text);showTyping();
  try{
    const res=await fetch("/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:text,contactName:"Test User",contactPhone:"+1 (555) 000-0000"})});
    const data=await res.json();
    removeTyping();
    if(data.humanActive){
      addMessage("system","HUMAN ACTIVE — bot standing down.");
    } else if(data.dnd){
      addMessage("system","DND — survey reply 1. DND applied in GHL, no message sent.");
    } else if(data.outOfScope){
      addMessage("system","OUT OF SCOPE — bot went silent. Slack alert fired.");
    } else if(data.blocked){
      addMessage("system","BLOCKED — reply failed validation twice ("+data.confidence+"→"+data.retryScore+"/10). Slack alerted.");
    } else {
      addMessage("bot",data.reply);
    }
  }catch(err){
    removeTyping();addMessage("system","Something went wrong. Check your API key and server logs.");
  }
  isLoading=false;sendBtn.disabled=false;inputEl.focus();
}
async function resetConversation(){
  await fetch("/reset",{method:"POST"});
  messagesEl.innerHTML="";
  messagesEl.appendChild(emptyState);
  emptyState.style.display="flex";
  document.getElementById("seedStatus").textContent="";
}
inputEl.focus();
function toggleSeed(){
  const body=document.getElementById("seedBody");
  const btn=document.querySelector(".seed-toggle");
  const isOpen=body.style.display==="flex";
  body.style.display=isOpen?"none":"flex";
  body.style.flexDirection="column";
  body.style.gap="8px";
  body.style.marginTop="10px";
  btn.textContent=isOpen?"+ Set context":"- Set context";
}
async function loadSeed(){
  const raw=document.getElementById("seedInput").value.trim();
  const statusEl=document.getElementById("seedStatus");
  if(!raw){statusEl.textContent="nothing to load";return;}
  const messages=[];
  for(const line of raw.split("\\n")){
    const trimmed=line.trim();
    if(!trimmed)continue;
    if(/^BOT:/i.test(trimmed)) messages.push({role:"assistant",content:trimmed.replace(/^BOT:[\\s]*/i,"")});
    else if(/^YOU:/i.test(trimmed)) messages.push({role:"user",content:trimmed.replace(/^YOU:[\\s]*/i,"")});
  }
  if(!messages.length){statusEl.textContent="couldn't parse any lines";return;}
  await fetch("/reset",{method:"POST"});
  const res=await fetch("/seed",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages})});
  const data=await res.json();
  messagesEl.innerHTML="";
  messagesEl.appendChild(emptyState);
  emptyState.style.display="none";
  for(const m of messages){
    const role=m.role==="user"?"user":"bot";
    const msg=document.createElement("div");
    msg.className="message "+role;
    msg.style.opacity="0.45";
    const label=document.createElement("div");
    label.className="label";
    label.textContent=(role==="user"?"YOU [context]":"SOF BOT [context]");
    const bubble=document.createElement("div");
    bubble.className="bubble";
    bubble.textContent=m.content;
    msg.appendChild(label);msg.appendChild(bubble);
    messagesEl.appendChild(msg);
  }
  messagesEl.scrollTop=messagesEl.scrollHeight;
  statusEl.textContent=data.seeded+" messages loaded";
  toggleSeed();
}
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SOF Bot running on port ${PORT}`);
});
