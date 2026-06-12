import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";

const { Pool } = pg;
const db = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function setupDb() {
  if (!db) { console.log("No DATABASE_URL — skipping DB setup"); return; }
  await db.query(`
    CREATE TABLE IF NOT EXISTS post_webinar_followups (
      id SERIAL PRIMARY KEY,
      contact_id TEXT NOT NULL,
      contact_name TEXT,
      contact_phone TEXT,
      last_bot_message TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      nudge1_sent BOOLEAN DEFAULT FALSE,
      nudge2_sent BOOLEAN DEFAULT FALSE,
      responded BOOLEAN DEFAULT FALSE,
      closed BOOLEAN DEFAULT FALSE
    )
  `);
  console.log("DB ready");
}
setupDb();

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_ALERT_CHANNEL = "C0B5E3MBXST";

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// Per-contact conversation memory
const conversations = new Map();

// Track contacts who've already had a next-week signup alert sent
const nextWeekAlerted = new Set();

// Workshop date — fetched from the landing page and cached
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
  // Get current time in PT
  const ptNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const day = ptNow.getDay(); // 0=Sun, 6=Sat
  const daysUntilSat = day === 6 ? 7 : (6 - day); // if today is Sat, use next Sat
  const sat = new Date(ptNow);
  sat.setDate(ptNow.getDate() + daysUntilSat);
  sat.setHours(9, 0, 0, 0);
  // Convert back to UTC-based Date using PT offset
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
  // Fall back to next available Saturday at 9am PT if fetch failed
  return cachedWorkshopDate || nextSaturdayAt9amPT();
}

let timeContext = ""; // module-level so validator can access it

async function buildSystemPrompt(triageResult = "INSCOPE") {
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
    timeContext = `The workshop is currently live right now. If someone messages, let them know it already started and give them the Zoom link.`;
  } else if (minutesUntil <= -120) {
    timeContext = `The workshop has already ended. If someone messages, let them know it's over and mention the replay or next workshop.`;
  } else if (!isWorkshopDay && minutesUntil <= 60 * 24) {
    timeContext = `The workshop is tomorrow, ${workshopDateLabel}, at 9am pt. Keep energy warm and excited.`;
  } else if (!isWorkshopDay) {
    timeContext = `The workshop is coming up on ${workshopDateLabel} at 9am pt — still a few days out. Keep energy warm and anticipatory.`;
  } else if (minutesUntil > 90) {
    timeContext = `Today IS the day of the workshop (${workshopDateLabel}) but it is still a few hours away. The Zoom link will be texted out this morning. Keep energy excited.`;
  } else {
    timeContext = `Right now it is ${minutesUntil} minutes until the workshop starts. Energy should be high — we're almost live! Say things like "almost time!" or "we're about to go live!"`;
  }

  return `You are a helpful assistant for Saints of Flow, Jason Crouse's coaching brand. You are texting with someone who has already registered for the Big Three Mastery Workshop. Your job is to answer their questions in a warm, conversational, human way like a real person on the team, not a bot.

CURRENT TIME CONTEXT: ${timeContext}

ABOUT THE WORKSHOP:
- Name: The Big Three Mastery Workshop
- Host: Jason Crouse
- Date: ${workshopDateLabel}
- Time: 9am pt (if someone asks about other time zones: 10am mt / 11am ct / 12pm et)
- Cost: Free
- Length: about 75-90 minutes (includes Q&A)
- Platform: Zoom
- How to join: they will receive a Zoom link via email and it will also be texted to them the morning of the event
- What it covers: how to master the Big Three which are career, love, and confidence. specifically turning your calling into an actual career, attracting the right kind of love, and building real confidence by keeping promises to yourself

REPLAY POLICY:
- only bring up the replay or next Saturday if someone uses explicit language like "I can't make it", "I won't be able to attend", "I'll miss it", "I'm not going to be able to join" — the words have to actually say they cannot attend
- being in a different time zone, traveling, being in Europe, being busy, being unsure of their schedule — none of these count. if anything is ambiguous, assume they ARE attending and keep it warm and hopeful
- if someone asks about the replay directly, answer it warmly — but do not volunteer it unprompted
- if someone truly cannot make it (explicit): ask warmly "are you around next ${nextWorkshopDayOfWeek}?" and leave it there
- if they say yes to the next one: tell them warmly you'll get them added to the list — the next workshop is ${nextWorkshopDateLabel} at 9am pt, use that date — then add [NEXT_WEEK_SIGNUP] on its own line at the very end of your message (this tag gets stripped before sending, it's just for internal tracking)
- if they say no to next Saturday or are unsure: mention the replay warmly and point them to webinar.saintsofflow.com to register for the next one
- never push the replay unprompted — attending live is way better and that energy should come through

TONE AND BEHAVIOR:
- warm, genuinely enthusiastic, like a real person on Jason's team who actually likes their job
- never sound bored, clipped, or like you're just checking a box
- responses should feel complete and warm but never so long it feels like an email
- occasionally use emojis naturally, rotate between 😊 😄 🙌🏼 🫶🏼, don't overdo it, maybe once per reply at most
- it's okay to add a little warmth or encouragement at the end, like "so excited for you to be there" or "it's gonna be a good one"
- occasionally use exclamation marks naturally, not on every sentence but enough to feel upbeat
- never sound like a bot or use corporate language
- do not use em dashes ever
- often skip capitalizing the first word of a sentence, it feels more like a real text
- use casual time formats like "9am" not "9:00am", use "pt" not "Pacific Time" or "PST"
- write in a run-on, texty way, like how a real person actually texts
- do not sell or pitch anything, this is purely logistics and info support

COMMON QUESTIONS AND HOW TO HANDLE THEM:
- "What is it?" / "I don't remember signing up" / "remind me what this is" - describe what the workshop covers warmly (the Big Three: career, love, confidence), skip all the logistics like price, length, and Zoom link — just re-engage them on what it's about, end with something like "does that ring a bell?" or "does that sound familiar?"
- if the prior context shows you just asked "does that sound familiar?" or "does that ring a bell?" and they reply "yes", "yeah", "yep", or similar — they're confirming they remember, NOT saying they have a question. respond warmly, like "awesome! so excited for you to be there 🙌🏼 any questions before we go live?" — never respond with "what's your question?" in this context
- "What time does it start?" - 9am pt this coming Saturday, only mention other time zones if they explicitly ask
- "Where do I join?" - check their email for the Zoom link, it'll also be texted to them day of
- "Will there be a replay?" - yeah there is one but we really recommend being there live since it's a workshop, if they can't make it point them to the following Saturday
- "How long is it?" - plan for about 75-90 minutes
- "Is it free?" - yeah completely free
- "Can I bring a friend?" - they don't need to register separately to join — they can just hop on the same Zoom link. but if they want to get the materials and follow-ups we send after, it's worth having them register at webinar.saintsofflow.com
- "I did not get my confirmation email" - let them know to check spam and that they'll get a reminder plus Zoom link closer to the date, Jason's team can also resend it, ask them what email they used
- "What should I have ready?" - just show up, maybe have a pen and paper if they want to take notes, and be somewhere they can focus for 90 minutes
- link for the next workshop is at webinar.saintsofflow.com

IN SCOPE — questions you should answer:
- anything about the workshop date, time, length, platform, how to join
- replay questions
- confirmation email / Zoom link questions
- what the workshop covers
- whether a friend can join
- what to have ready

OUT OF SCOPE — questions you should NOT answer:
- anything about The Flow Code, TFC, or coaching programs
- pricing or cost of anything beyond the free workshop
- personal advice or coaching questions
- anything you are genuinely unsure about

CRITICAL RULE: If a message is out of scope or you are unsure how to answer it, respond with exactly this single word and nothing else: OUTOFSCOPE

POST-WEBINAR MODE: if the conversation history contains a message asking them to reply with 1, 2, 3, or 4 about the workshop ("we'd genuinely love to hear where you're at after the workshop"), you are now in post-webinar follow-up mode. switch your entire approach — you are no longer answering logistics questions. your job is to understand where they're at and gently invite one small next step toward booking an enrollment call with Jason.

survey responses and how to handle them:
- 1 (didn't find it valuable): get curious, not defensive. ask what felt off about it — one genuine question, no convincing. if they share, reflect it back warmly. never argue or re-pitch.
- 2 (couldn't focus / wants next week): warm and easy. confirm them for next week's workshop, get them excited, done.
- 3 (found it valuable but not ready): your warmest lead. do NOT pitch. ask one calibrated question about what's making now feel like the wrong time. use what/how questions — "what would need to be different for this to feel like the right time?" one question, then let it breathe.
- 4 (valuable but financial barrier): acknowledge it genuinely first. don't immediately mention financing. ask what it would need to look like to feel possible. if they engage openly, you can mention there are flexible options and ask if they'd be open to a quick conversation to explore it.

post-webinar tone and approach:
- warm, genuinely curious, zero agenda, like a real person who actually cares about their answer
- one question at a time, never two questions in one message
- short messages — this is a text conversation, not a sales email
- never use the word "invest" or pitch the Flow Code directly
- use no-oriented questions in the Chris Voss style — "would you be opposed to..." or "is it okay if..." — these feel low pressure and keep people engaged
- never push past what feels natural — if they're not moving, ask one more question and let it breathe

when to hand off to a human:
- if someone says yes to a call or asks directly about pricing, the Flow Code, or next steps — fire a Slack alert (reply OUTOFSCOPE) and stand down immediately. that conversation needs a human.

FOR CONTEXT: Jason's team calls registrants on Friday afternoon to personally confirm their attendance and ask which of the Big Three they're most focused on. If someone asks whether we called them, this is why.

IMPORTANT: always match your sign-off to the actual time context. if the workshop is today and less than a few hours away, never say "see you tomorrow" — use "see you soon", "almost time!", "see you in a bit", or similar. the time context at the top of this prompt tells you exactly where you are.

READING CONTEXT: always read the full conversation history before responding. short replies like "yes", "no", "ok", "sure" are almost always a response to the most recent thing said — figure out what they're responding to before replying. never assume "yes" means "yes I have a question" if the prior message wasn't asking about questions.

${triageResult === "SOCIAL" ? `CURRENT MESSAGE CONTEXT: this message has been classified as a casual social acknowledgment — not a real question and not a statement about whether they can attend. respond with a brief, warm reply only. do NOT ask about the replay, do NOT ask about next Saturday, do NOT ask if they have questions. just acknowledge warmly and leave it there.` : ""}

remember: everyone texting has already registered, they are warm, be helpful, be human, be brief.`;
}

const TRIAGE_PROMPT = `You are a triage assistant. Your only job is to classify an inbound text message for a workshop logistics bot.

IN SCOPE: questions about workshop date, time, length, platform, Zoom link, replay, confirmation email, what the workshop covers, bringing a friend, what to prepare. Also includes: saying they can't make it, will be away, asking if there's another time or another session, anything about attending next week instead. Also includes: replies to a post-webinar survey — someone replying with a number (1, 2, 3, 4) or a short phrase like "I found it valuable" or "I couldn't focus" or "financially not there yet" or any response that sounds like feedback about the workshop they just attended. Also includes: any follow-up in a post-webinar conversation about what's blocking them, whether they want to get on a call, or anything about the Flow Code or working with Jason.

SOCIAL: casual acknowledgments with no real question — things like "thanks", "ok", "sounds good", "got it", "👍", "great", "awesome", "perfect", or similar short responses.

OPTOUT: the person wants to stop receiving messages — "stop", "unsubscribe", "take me off", "remove me", "opt out", "don't text me", "cancel", or any variation of asking to be removed from the list.

OUT OF SCOPE: anything unrelated to the workshop or post-webinar follow-up. If there is any chance the message is a survey response or post-webinar reply, classify it as INSCOPE not OUTOFSCOPE.

Reply with exactly one word: INSCOPE, SOCIAL, OUTOFSCOPE, or OPTOUT`;

async function triage(message) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 10,
    system: TRIAGE_PROMPT,
    messages: [{ role: "user", content: message }],
  });
  return response.content[0].text.trim();
}

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

    // Step 2: fetch the last 10 SMS messages
    const msgsRes = await fetch(
      `https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=10`,
      {
        headers: {
          "Authorization": `Bearer ${GHL_API_KEY}`,
          "Version": "2021-04-15",
        },
      }
    );
    const msgsData = await msgsRes.json();
    const messages = msgsData?.messages?.messages || msgsData?.messages || [];

    // Step 3: map to Claude format — SMS only (exclude emails), reverse to chronological order
    // GHL returns newest-first; we need oldest-first for Claude
    const smsMessages = messages
      .filter(m => m.body && m.body.trim() && m.messageType !== "TYPE_EMAIL" && m.type !== 3)
      .reverse()
      .map(m => ({
        role: m.direction === "inbound" ? "user" : "assistant",
        content: m.body,
      }));
    console.log(`Filtered to ${smsMessages.length} SMS messages (chronological order):`);
    smsMessages.forEach((m, i) => console.log(`  [${i+1}] ${m.role}: "${m.content?.slice(0, 80)}"`));
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
    body: JSON.stringify({
      type: "SMS",
      contactId: contactId,
      message: message,
    }),
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
    const data = await res.json();
    console.log(`GHL tag "${tag}" added to ${contactId}:`, res.status);
    return data;
  } catch (err) {
    console.error(`GHL tag error (${tag}):`, err);
  }
}

async function sendSlackAlert(contactInfo, message, contactId) {
  const ghlLink = contactId ? `\n<https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}|View in GHL>` : "";
  const alertText = `🚨 *Bot handoff needed*\n*Contact:* ${contactInfo}\n*Their message:* "${message}"${ghlLink}\n\nThis was outside the bot's scope — please follow up manually.`;
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
      },
      body: JSON.stringify({
        channel: SLACK_ALERT_CHANNEL,
        text: alertText,
      }),
    });
    const data = await res.json();
    console.log("Slack response:", JSON.stringify(data));
  } catch (err) {
    console.error("Slack alert error:", err);
  }
}

async function validateReply(reply, conversationHistory, timeContext, systemPrompt) {
  try {
    const lastUserMessage = [...conversationHistory].reverse().find(m => m.role === "user")?.content || "";
    const validation = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 150,
      system: `You are a quality checker for an SMS bot. Review the proposed reply and return a JSON object with:
- "score": integer 1-10 (10 = perfect, 1 = do not send)
- "issue": short description of the problem, or null if none

Fail immediately (score 1-3) if:
- Any internal system words appear in the reply: OUTOFSCOPE, INSCOPE, NEXT_WEEK_SIGNUP, or similar
- The reply says "see you tomorrow" or "tomorrow" when the time context says the workshop is today or already ended
- The reply makes no sense as a response to what the person said
- The reply sounds robotic, corporate, or reveals it's a bot
- The reply states something that contradicts the bot's policy guidelines (e.g. wrong policy on replays, bringing guests, confirmation emails, etc.)
- The reply confidently answers a question but gets the policy wrong based on the guidelines provided

Score 7-10 only if the reply is warm, contextually appropriate, human-sounding, AND factually consistent with the bot's guidelines.
Respond with raw JSON only, no markdown.`,
      messages: [{
        role: "user",
        content: `Bot policy guidelines:\n${systemPrompt}\n\n---\n\nTime context: ${timeContext}\n\nLast message from person: "${lastUserMessage}"\n\nProposed reply: "${reply}"`
      }]
    });
    const jsonMatch = validation.content[0].text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in validator response");
    const result = JSON.parse(jsonMatch[0]);
    console.log(`Validation score: ${result.score}/10${result.issue ? ` — ${result.issue}` : ""}`);
    return result;
  } catch (err) {
    console.error("Validation error:", err);
    return { score: 10, issue: null }; // fail open — don't block on validator error
  }
}

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
        triage,
        reply: reply || "",
        nextWeekSignup: !!nextWeekSignup,
        confidence: confidence ?? null,
      }),
    });
  } catch (err) {
    console.error("Sheet log error:", err);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function typingDelay(text) {
  const len = text.length;
  let base;
  if (len < 80) base = 14;
  else if (len < 200) base = 31;
  else base = 53;
  // ±25% jitter so it never feels like a timer
  const jitter = base * 0.25;
  return Math.round((base + (Math.random() * jitter * 2 - jitter)) * 1000);
}


app.post("/chat", async (req, res) => {
  console.log("Incoming GHL payload:", JSON.stringify(req.body, null, 2));

  const contactId = req.body.customData?.contactId || req.body.contact_id;
  const contactName = req.body.customData?.contactName || req.body.full_name;
  const contactPhone = req.body.customData?.contactPhone || req.body.phone;

  // GHL sends message as an object { type, body } — extract the text correctly
  const rawMessage = req.body.message;
  const messageText = (typeof rawMessage === "object" ? rawMessage?.body : rawMessage) || req.body.customData?.message || "";
  if (!messageText.trim()) return res.status(400).json({ error: "No message" });

  console.log("Message text:", messageText);
  console.log("Contact ID:", contactId);

  // Check if a human has taken over — if so, stand down silently
  const humanActive = await hasHumanActiveTag(contactId);
  if (humanActive) {
    console.log("human-active tag found, bot standing down");
    return res.json({ reply: null, humanActive: true });
  }

  // Triage the message
  let triageResult;
  try {
    triageResult = await triage(messageText);
  } catch (err) {
    console.error("Triage error:", err);
    return res.status(500).json({ error: "Triage failed" });
  }

  console.log("Triage result:", triageResult);

  if (triageResult === "OPTOUT") {
    console.log("Opt-out detected, bot going silent");
    return res.json({ reply: null, optOut: true });
  }

  if (triageResult === "OUTOFSCOPE") {
    const contactInfo = contactName || contactPhone || contactId || "Unknown contact";
    await sendSlackAlert(contactInfo, messageText, contactId);
    return res.json({ reply: null, outOfScope: true });
  }

  // Get or create per-contact conversation history
  // If we don't have it in memory, seed from GHL so restarts don't lose context
  const conversationKey = contactId || "local-test";
  if (!conversations.has(conversationKey)) {
    const history = await getGHLConversationHistory(contactId);
    console.log(`Seeded ${history.length} messages from GHL for contact ${contactId}`);
    if (history.length) {
      const last = history[history.length - 1];
      console.log(`Last seeded message — role: ${last.role}, content: "${last.content?.slice(0, 80)}"`);
    }
    // GHL already stores the inbound message before firing the webhook,
    // so the current message may already be the last item — drop it to avoid duplication
    if (history.length && history[history.length - 1].role === "user" && history[history.length - 1].content === messageText) {
      history.pop();
    }
    conversations.set(conversationKey, history);
  }
  const conversation = conversations.get(conversationKey);

  // If this is a reply to the Big Three pre-webinar question (career/love/confidence),
  // the bot should stand down — this is not a post-webinar survey reply
  const isBigThreeContext = conversation.some(m =>
    m.role === "assistant" && m.content?.includes("Reply with 1, 2, or 3")
  );
  if (isBigThreeContext && /^[123]$/.test(messageText.trim())) {
    console.log(`Big Three pre-webinar reply detected (${messageText.trim()}) — bot standing down`);
    return res.json({ reply: null, bigThreeReply: true });
  }

  const builtSystemPrompt = await buildSystemPrompt(triageResult);

  let reply;
  try {
    conversation.push({ role: "user", content: messageText });
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      system: builtSystemPrompt,
      messages: conversation.slice(-20),
    });
    reply = response.content[0].text;
  } catch (err) {
    console.error("Claude error:", err);
    conversation.pop();
    return res.status(500).json({ error: "Bot failed" });
  }

  // Safety net: if the main bot still returns OUTOFSCOPE (alone or appended), treat it the same way
  if (reply.trim() === "OUTOFSCOPE" || reply.includes("OUTOFSCOPE")) {
    const contactInfo = contactName || contactPhone || contactId || "Unknown contact";
    await sendSlackAlert(contactInfo, messageText, contactId);
    conversation.pop();
    return res.json({ reply: null, outOfScope: true });
  }

  // Check for next-week signup marker and strip it before sending
  const nextWeekSignup = reply.includes("[NEXT_WEEK_SIGNUP]");
  reply = reply.replace(/\[NEXT_WEEK_SIGNUP\]/g, "").trim();

  // Pre-send validation — confidence check before anything goes out
  const validation = await validateReply(reply, conversation, timeContext, builtSystemPrompt);
  let finalScore = validation.score;
  let wasRetried = false;
  let origScoreForLog = null;

  if (validation.score < 7) {
    const origScore = validation.score;
    const origIssue = validation.issue;
    const origReply = reply;
    origScoreForLog = origScore;
    console.log(`Low confidence (${origScore}/10) — regenerating. Issue: "${origIssue}"`);

    try {
      const retryRes = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        system: builtSystemPrompt,
        messages: [
          ...conversation.slice(-20),
          { role: "assistant", content: origReply },
          { role: "user", content: `[INTERNAL]: Your reply had a quality issue: "${origIssue || "quality too low"}". Please rewrite it.` },
        ],
      });
      const retryText = retryRes.content[0].text;
      // Capture NEXT_WEEK_SIGNUP from retry if present
      if (!nextWeekSignup && retryText.includes("[NEXT_WEEK_SIGNUP]")) {
        // nextWeekSignup already declared above — let it flow through
      }
      const retryReply = retryText.replace(/\[NEXT_WEEK_SIGNUP\]/g, "").trim();
      const retryValidation = await validateReply(retryReply, conversation, timeContext, builtSystemPrompt);
      finalScore = retryValidation.score;
      console.log(`Retry validation: ${finalScore}/10 (was ${origScore}/10)`);

      if (finalScore >= 7) {
        reply = retryReply;
        wasRetried = true;
        console.log(`Retry succeeded (${origScore}→${finalScore}/10): "${reply}"`);
      }
    } catch (err) {
      console.error("Retry error:", err);
      finalScore = 0; // treat retry error as a block
    }

    // If still below threshold after retry — block and alert
    if (finalScore < 7) {
      const contactInfo = contactName || contactPhone || contactId || "Unknown contact";
      console.log(`Blocking after failed retry (${origScore}→${finalScore}/10)`);
      try {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${SLACK_TOKEN}` },
          body: JSON.stringify({
            channel: SLACK_ALERT_CHANNEL,
            text: `⚠️ *Reply blocked after retry (${origScore}→${finalScore}/10)*\n*Contact:* ${contactInfo}\n*Issue:* ${origIssue || "unknown"}\n*Blocked reply:* "${origReply}"\n*Their message:* "${messageText}"\n<https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}|View in GHL>\n\nBoth attempts failed — please follow up manually.`,
          }),
        });
      } catch (err) {
        console.error("Slack validation alert error:", err);
      }
      logToSheet({ contactName, contactPhone, contactId, message: messageText, triage: triageResult, reply: `[BLOCKED after retry: ${origScore},${finalScore}] ${origReply}`, nextWeekSignup, confidence: origScore });
      return res.json({ reply: null, blocked: true, confidence: origScore, retryScore: finalScore, issue: origIssue });
    }
  }

  if (nextWeekSignup && !nextWeekAlerted.has(conversationKey)) {
    nextWeekAlerted.add(conversationKey);
    const contactInfo = contactName || contactPhone || contactId || "Unknown contact";
    try {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SLACK_TOKEN}` },
        body: JSON.stringify({
          channel: SLACK_ALERT_CHANNEL,
          text: `📋 *Next week signup request*\n*Contact:* ${contactInfo}\n<https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}|View in GHL>\nThey said yes to next Saturday — add them to the list.`,
        }),
      });
    } catch (err) {
      console.error("Slack next-week alert error:", err);
    }
    await addGHLTag(contactId, "reschedule");
  }

  conversation.push({ role: "assistant", content: reply });

  // If we're in post-webinar mode, track this in the DB for follow-up cadence
  const isPostWebinar = conversation.some(m =>
    m.role === "assistant" && m.content?.toLowerCase().includes("reply with the number that fits best")
  );
  if (isPostWebinar && db && contactId) {
    try {
      // Mark any existing open row as responded, then upsert with latest bot message
      // If an open row already exists for this contact, just update the last bot message
      // rather than inserting a duplicate
      const existing = await db.query(
        `SELECT id FROM post_webinar_followups WHERE contact_id = $1 AND closed = FALSE AND responded = FALSE`,
        [contactId]
      );
      if (existing.rows.length > 0) {
        await db.query(
          `UPDATE post_webinar_followups SET last_bot_message = $1 WHERE id = $2`,
          [reply, existing.rows[0].id]
        );
      } else {
        await db.query(
          `INSERT INTO post_webinar_followups (contact_id, contact_name, contact_phone, last_bot_message, sent_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [contactId, contactName || "", contactPhone || "", reply]
        );
      }
      console.log(`Post-webinar followup logged to DB for ${contactId}`);
    } catch (err) {
      console.error("DB write error:", err);
    }
  }

  // Log to Google Sheet (fire and forget)
  // If the reply was regenerated, prefix it so it's visible in the sheet
  const sheetReply = wasRetried ? `[RETRIED ${origScoreForLog}→${finalScore}] ${reply}` : reply;
  logToSheet({ contactName, contactPhone, contactId, message: messageText, triage: triageResult, reply: sheetReply, nextWeekSignup, confidence: finalScore });

  const delay = typingDelay(reply);
  console.log(`Typing delay: ${Math.round(delay / 1000)}s for ${reply.length} char reply`);

  if (contactId) {
    // Respond to GHL webhook immediately so it doesn't time out,
    // then wait the delay before actually sending the SMS
    res.json({ reply, outOfScope: false, sent: true });
    await sleep(delay);
    try {
      await sendGHLReply(contactId, reply);
    } catch (err) {
      console.error("GHL send error:", err);
    }
  } else {
    // Local tester — no delay
    res.json({ reply, outOfScope: false });
  }
});

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
  conversations.clear();
  res.json({ ok: true });
});

app.post("/seed", (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: "messages must be an array" });
  conversations.set("local-test", messages);
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
document.getElementById("seedInput").value="BOT: hey Mario it's Jason Crouse. Do you have any questions for me before our live workshop tomorrow? Start time is 9:00am PST";
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
      addMessage("system","HUMAN ACTIVE - bot standing down, human-active tag detected.");
    } else if(data.optOut){
      addMessage("system","OPT-OUT detected - confirmation sent, tagged opted-out in GHL.");
    } else if(data.outOfScope){
      addMessage("system","OUT OF SCOPE - bot went silent. Slack alert fired to #ghl-alerts.");
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

async function runFollowUpScheduler() {
  if (!db) return;
  try {
    const now = new Date();
    const workshopTime = await getWorkshopDate();

    // Only run post-webinar follow-ups after the workshop has actually ended
    if (now < workshopTime) {
      console.log("Scheduler: workshop hasn't happened yet — skipping follow-up cadence");
      return;
    }

    const rows = await db.query(
      `SELECT * FROM post_webinar_followups WHERE responded = FALSE AND closed = FALSE AND sent_at IS NOT NULL`
    );

    for (const row of rows.rows) {
      const minutesSince = (now - new Date(row.sent_at)) / 60000;
      const contactId = row.contact_id;
      const history = await getGHLConversationHistory(contactId);

      // Check if they've replied since the bot last messaged
      const lastBotIdx = history.map(m => m.content).lastIndexOf(row.last_bot_message);
      const repliedSince = lastBotIdx !== -1 && history.slice(lastBotIdx + 1).some(m => m.role === "user");

      if (repliedSince) {
        await db.query(`UPDATE post_webinar_followups SET responded = TRUE WHERE id = $1`, [row.id]);
        console.log(`Follow-up closed — ${contactId} replied`);
        continue;
      }

      // Nudge 1: a lone "?" after ~2 hours
      if (!row.nudge1_sent && minutesSince >= 120) {
        console.log(`Sending nudge 1 to ${contactId}`);
        await sendGHLReply(contactId, "?");
        await db.query(`UPDATE post_webinar_followups SET nudge1_sent = TRUE, sent_at = NOW() WHERE id = $1`, [row.id]);
        continue;
      }

      // Nudge 2: Voss no-oriented after ~24 hours
      if (row.nudge1_sent && !row.nudge2_sent && minutesSince >= 1440) {
        const history2 = await getGHLConversationHistory(contactId);
        const system = await buildSystemPrompt("INSCOPE");
        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-5",
          max_tokens: 200,
          system: system + "\n\nWrite a single short follow-up text in the Chris Voss no-oriented style. Something like 'is it okay if I take your name off our list for this round?' — low pressure, gives them an easy out. One sentence max.",
          messages: history2.slice(-10),
        });
        const nudge2 = response.content[0].text.trim();
        await sendGHLReply(contactId, nudge2);
        await db.query(`UPDATE post_webinar_followups SET nudge2_sent = TRUE, sent_at = NOW() WHERE id = $1`, [row.id]);
        console.log(`Sent nudge 2 to ${contactId}: "${nudge2}"`);
        continue;
      }

      // After nudge 2 with no response for 24 more hours — alert Slack instead of auto-sending
      // closing message. A human should make this call.
      if (row.nudge2_sent && minutesSince >= 1440) {
        const contactInfo = row.contact_name || row.contact_phone || contactId;
        console.log(`Follow-up cadence complete for ${contactId} — no response after nudge 2, alerting Slack`);
        try {
          await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${SLACK_TOKEN}` },
            body: JSON.stringify({
              channel: SLACK_ALERT_CHANNEL,
              text: `📭 *No response after follow-up cadence*\n*Contact:* ${contactInfo}\n<https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}|View in GHL>\n\nSent survey → nudge 1 → nudge 2. Still no reply. Recommend closing manually if appropriate.`,
            }),
          });
        } catch (err) {
          console.error("Slack scheduler alert error:", err);
        }
        await db.query(`UPDATE post_webinar_followups SET closed = TRUE WHERE id = $1`, [row.id]);
      }
    }
  } catch (err) {
    console.error("Scheduler error:", err);
  }
}

// Run scheduler every hour
setInterval(runFollowUpScheduler, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("SOF Bot Tester running — open http://localhost:3000");
});
