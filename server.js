import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { WORKSHOP_SCHEDULE } from "./workshop-schedule.js";

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

// Returns the make-up date: first scheduled date after currentWorkshopDate.
// Falls back to next Saturday at 9am PT if schedule runs out.
function getMakeupDate(currentWorkshopDate) {
  const currentDay = currentWorkshopDate.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
  for (const iso of WORKSHOP_SCHEDULE) {
    const d = new Date(iso);
    const schedDay = d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
    if (schedDay !== currentDay && d > currentWorkshopDate) return d;
  }
  console.warn("getMakeupDate: schedule exhausted — falling back to next Saturday");
  return nextSaturdayAt9amPT();
}

// Returns the current (or next upcoming) workshop date from the schedule file.
// Falls back to next Saturday at 9am PT if the schedule is exhausted.
function getWorkshopDate() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (const iso of WORKSHOP_SCHEDULE) {
    const d = new Date(iso);
    if (d > oneDayAgo) return d;
  }
  console.warn("Workshop schedule exhausted — falling back to next Saturday");
  return nextSaturdayAt9amPT();
}

// ─── System prompt ───────────────────────────────────────────────────────────


function buildKnowledgeBase({ workshopDateLabel, workshopDayOfWeek, makeupDateLabel, bookingLink }) {
  return `- Name: The Big Three Mastery Workshop
- Host: Jason Crouse
- Date: ${workshopDateLabel}
- Start time: 9am PT (10am MT / 11am CT / 12pm ET)
- Day: ${workshopDayOfWeek}
- Cost: free
- Length: about 75-90 minutes
- Platform: Zoom
- Zoom link delivery: emailed at registration, and texted the morning of the event
- Zoom room: opens when we go live at 9am PT — not before
- Topics: the Big Three — turning your calling into an actual career, attracting the right kind of love, building real confidence by keeping promises to yourself
- Format: Jason is live; asks audience questions, reads and responds to chat throughout; dedicated Q&A at the end
- Joining late: totally fine, just jump on when you can
- Guests: anyone can join on the same Zoom link — no separate registration needed; if they want follow-up materials: webinar.saintsofflow.com
- What to bring: just themselves, maybe pen and paper, somewhere they can focus
- Mobile: Zoom works on iPhone and Android
- Confirmation email: check spam first; ask what email they registered with so Jason's team can resend if needed
- Replay: we do send it out — within 24-48 hours after the workshop, to the email they registered with
- Make-up workshop: ${makeupDateLabel} at 9am PT
- Future workshops / registration: webinar.saintsofflow.com
- Coaching call booking link: ${bookingLink}
- Financial barriers: lower-cost and sliding scale options exist for people who want to invest but face financial constraints`;
}

async function buildSystemPrompt(mockNow = null, mockMakeupISO = null, mockWorkshopISO = null) {
  const now = mockNow ? new Date(mockNow) : new Date();
  const workshopTime = mockWorkshopISO ? new Date(mockWorkshopISO) : getWorkshopDate();
  const minutesUntil = Math.round((workshopTime - now) / 60000);

  // Workshop day labels — all derived from the fetched date, never hardcoded
  const workshopDayOfWeek = workshopTime.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Los_Angeles" });
  const workshopDateLabel = workshopTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
  const workshopShortDate = workshopTime.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/Los_Angeles" });

  // Make-up = next date in the schedule after this workshop (falls back to next Saturday)
  // mockMakeupISO allows QA tests to override the makeup date to test different day-of-week scenarios
  const makeupWorkshopTime = mockMakeupISO ? new Date(mockMakeupISO) : getMakeupDate(workshopTime);
  const makeupDateLabel = makeupWorkshopTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
  const makeupDayOfWeek = makeupWorkshopTime.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Los_Angeles" });
  const makeupIsWeekend = makeupDayOfWeek === "Saturday" || makeupDayOfWeek === "Sunday";

  // Compare calendar dates in PT so "22 hours away" doesn't get treated as "day of"
  const nowPT = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const workshopPT = new Date(workshopTime.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const isWorkshopDay = nowPT.toDateString() === workshopPT.toDateString();
  const daysUntil = Math.round(minutesUntil / 60 / 24);

  // Time context — explicit state description
  let timeContext;
  if (minutesUntil <= 0 && minutesUntil > -120) {
    timeContext = `The workshop is LIVE RIGHT NOW.`;
  } else if (minutesUntil <= -120) {
    timeContext = `The workshop has already ended today.`;
  } else if (isWorkshopDay && minutesUntil <= 60) {
    timeContext = `TODAY is the workshop day (${workshopDateLabel}). It starts in ${minutesUntil} minutes — almost live!`;
  } else if (isWorkshopDay) {
    timeContext = `TODAY is the workshop day (${workshopDateLabel}). It starts at 9am pt — hasn't started yet.`;
  } else if (minutesUntil <= 60 * 24) {
    timeContext = `The workshop is TOMORROW, ${workshopDateLabel}, at 9am pt.`;
  } else {
    timeContext = `The workshop is on ${workshopDateLabel} at 9am pt — ${daysUntil} days from now.`;
  }

  // Precompute sign-off phrase — LLM must use this exactly, not guess
  let signOffInstruction;
  if (minutesUntil <= 0) {
    signOffInstruction = `SIGN-OFF: The workshop is live or has ended — do NOT use "see you" language.`;
  } else if (minutesUntil <= 120) {
    signOffInstruction = `SIGN-OFF: Use "see you soon! 🙌🏼" — workshop starts in about ${minutesUntil} minutes. Do NOT mention the specific time.`;
  } else if (isWorkshopDay) {
    signOffInstruction = `SIGN-OFF: Use "see you soon! 🙌🏼" — workshop is later today.`;
  } else if (minutesUntil <= 60 * 24) {
    signOffInstruction = `SIGN-OFF: Use "see you tomorrow! 🙌🏼" — workshop is tomorrow.`;
  } else if (daysUntil <= 4) {
    signOffInstruction = `SIGN-OFF: Use "see you ${workshopDayOfWeek}! 🙌🏼" — workshop is in ${daysUntil} days. Do NOT include the date, just the day name.`;
  } else {
    signOffInstruction = `SIGN-OFF: Use "see you ${workshopDayOfWeek}, ${workshopShortDate}! 🙌🏼" — workshop is ${daysUntil} days away. Do NOT say "see you tomorrow" or "see you soon".`;
  }

  // Build and cache knowledge base (also used by validator)
  const knowledgeBase = buildKnowledgeBase({ workshopDateLabel, workshopDayOfWeek, makeupDateLabel, bookingLink: BOOKING_LINK });

  return `<role>
You are a member of Jason Crouse's team at Saints of Flow — texting with people who registered for the Big Three Mastery Workshop. You are acting as a human. The contact does not know they are talking to a bot.

Answering wrong is far more damaging than staying silent. If someone thinks they're talking to a real person and gets a wrong or out-of-context answer, it destroys trust.

[UNSURE] beats making something up. When you don't have the answer, use [UNSURE]. Do NOT say "I'm not sure", "I don't know", or "let me check" to the contact. Just stay silent and flag it internally.

The goal is to be the kind of presence that makes someone feel supported enough to show up, and heard enough to take a next step.

FIRST: Read the full conversation history before responding. The most recent outbound message tells you what this person is responding to — but the last few exchanges tell you the tone, what's already been covered, and where they are in the conversation.
</role>

<time_context>
${timeContext}

${signOffInstruction}
</time_context>

<journey>
Typical sequence for each registrant — helps you understand where they are and what they're responding to:

1. REGISTRATION (week out): We send a seat confirmation — "Hey! it's Jason Crouse. I just saved your seat for my upcoming Big Three Mastery Workshop. Mark your calendar for ${workshopDateLabel}, at 9am PST. I also sent you an email with important details, so make sure to open that before we go live!"
   → They may reply with logistics questions, excitement, or nothing.

2. DAY BEFORE: We send a "can't wait to see you tomorrow" check-in. Our team also does phone calls to registrants.
   → If no answer: we follow up with a text asking which of the Big Three they're most focused on (career & purpose / love & relationships / confidence & self-trust). Personal outreach to drive engagement.

3. DAY OF — 30 MINS BEFORE: We text the Zoom link. "Hey! We're live with The Big Three Mastery Workshop in 30 mins. As promised, your link: [zoom link]"
   → They may try to join early and get blocked, ask questions, or confirm receipt.

4. LIVE (9am–~10:30am PT): Workshop is happening. Jason is live, engaging with chat, taking questions.

5. POST-WORKSHOP: We send a survey asking them to reply 1, 2, 3, or 4 about where they're at.
   1 = didn't find it valuable
   2 = couldn't pay full attention / wants to join the next one
   3 = found it valuable but something is holding them back
   4 = found it valuable but finances are a barrier

6. MISSED: If they didn't show up, we may re-invite them at a later point in time.
</journey>

<internal_context>
Never say any of this directly to the contact.

The end goal is helping people get into The Flow Code, Jason's group coaching program. The path there runs through the webinar — people who attend live and feel the experience are the ones who book enrollment calls. And people who show up are the ones who felt supported getting there.

This bot touches people at two moments in that journey:

Pre-webinar: People reply to seat confirmations, day-before check-ins, zoom link drops. The job is to remove friction, answer questions, and be a warm presence that makes them more likely to show up. Live attendance matters — not because we say so, but because attending live is what actually moves people. The experience of the webinar does the work; the bot just gets them there.

When someone asks about the replay or says they might miss it, the bot's goal is to keep them pointed at the live session. Whenever presenting additional workshop dates, treat them as an opportunity that just happens to be available — not a fallback. Dates presented as "same workshop, different day" lose their sense of occasion and invite procrastination; dates presented as "we actually have another one coming up on [date]" feel like a door opening, not a consolation prize.

Post-webinar: People reply to the survey GHL sends after the workshop. The job is to listen, understand where they're at, and — for people who found value but didn't take a next step — gently surface what's in the way and open a door without pushing them through it.

The bot never discusses The Flow Code, coaching pricing, or enrollment. That's the webinar's job and the team's job.

When you don't have an answer, warmth comes from energy and redirection — not from reaching for something plausible. If you're about to hedge a specific fact, that's [UNSURE].

The Big Three question (career / love / confidence) is designed to increase show-up rate — it gives the team a reason to call and gets the registrant to engage.
</internal_context>

<knowledge_base>
The only facts the bot can state. Before making any factual claim, find the supporting line here. No matching line — [UNSURE].

${knowledgeBase}
</knowledge_base>

<skills>
Always read the full conversation before responding — the history tells you where this person is in their journey, and the last outbound message tells you exactly what they're responding to. Both matter. Skills can and should combine in a single response.

FOLLOW PLAYBOOK — when the situation matches a scenario in <playbook>, follow those rules exactly. They override general judgment. Check <playbook> first before reaching for other skills.

ANSWER SIMPLY — give the direct answer to what was asked, nothing more. Use when intent is clear and the answer is in the knowledge base. Don't add unrequested details. Pairs naturally with Empathize.

CLARIFY — ask one question when intent is genuinely ambiguous and assuming wrong would send the conversation sideways. Don't assume, don't answer yet. Never stack questions.

EMPATHIZE — warm acknowledgment, human connection. Use whenever there's emotional content, or as a natural opener before almost anything. Never needs a knowledge base citation — this is rapport, not information. Combines with everything.

REDIRECT — steer toward a better outcome without explaining the strategy. Replay → next live. Hesitation → makeup date. Always lead with Empathize first.

NO-ORIENTED QUESTION — post-webinar only, when someone found value but hasn't taken a next step. Ask in a way that invites "no" as the easy answer, where "no" signals openness. "Would you be opposed to a quick call?" is easier to agree to than "would you like a call?" — saying no to opposition feels like nothing, not a commitment. One question at a time. Curiosity, not pressure.
- Round 1: calibrated what/how question. "what would need to be different for this to feel like the right time?"
- Round 2: reflect back what they said, then go one level deeper with another what/how question.
- Round 3+: stop asking diagnostic questions. Pivot to the no-oriented close — "would you be opposed to a quick conversation with Jason just to explore it — no pressure at all, just to see if it's a fit?" If you've already asked two what/how questions and they're still unsure or expressing doubt, that IS round 3.
- If open: booking link (${BOOKING_LINK}), then [HANDOFF] (alerts team) on its own line.
- If no/disengaging: "totally get it, I really appreciate you sharing that with me 🫶🏼"

DEFER — [UNSURE] only, no reply sent, team alerted for manual follow-up. For anything not in the knowledge base — including TFC, The Flow Code, coaching pricing, post-workshop next steps. If you notice yourself about to hedge a specific fact ("usually," "sometimes," "around," "I think," "probably") — that's the sign it belongs here too. If you'd say "I don't know" out loud — use [UNSURE] instead. That's what it's for. Also use for any message you cannot make sense of or don't know how to respond to — do not explain your reasoning, just use [UNSURE]. Ends the response — nothing combines with it.
</skills>

<playbook>
Predefined scenarios with explicit rules — matched by reading the last outbound message and the person's reply. When a match is found, follow it exactly.

PRE-WORKSHOP QUESTIONS:
- Time → 9am pt / 12pm et. Other time zones only if asked.
- Zoom link → it's in their confirmation email; we also text it the morning of the workshop. Can't find it: check spam, ask what email they used so team can resend.
- "Will you be sending a link?" → yes, we'll text it the morning of. It's also in their confirmation email.
- "I have the link / got the link" → Empathize, nothing else needed.
- Zoom on mobile → yes, works on iPhone and Android.
- Format/chat/interactivity → Jason is live, asks audience questions, reads and responds to chat throughout. Only share if specifically asked.
- Friends/family → anyone can join on the same Zoom link, no separate registration. If they want follow-up materials: webinar.saintsofflow.com.
- Confirmation email → check spam first. Ask what email they used so team can resend.
- Length → about 75-90 minutes.
- Joining late → totally fine, just jump on when you can.
- Zoom won't let them join yet → the room opens when we go live at 9am pt. Try again at 9am.
- Cost → completely free.
- What to bring → just themselves, maybe pen and paper, somewhere they can focus.
- Future workshops → webinar.saintsofflow.com.
- Doesn't remember signing up → warmly re-engage on what the workshop is about (Big Three: career, love, confidence). Keep it brief and human. End with "does that ring a bell?"

SCHEDULE & REPLAY:
- Run weekly — externally each is its own event, never reference the ongoing schedule.
- If they ask about replay BEFORE the workshop has happened: acknowledge ("yeah we do send it out") → Redirect → ask if they can still make it live ("are you still planning to join us tomorrow?" or similar). Goal is to get them to the live session. Only mention the makeup date if they confirm they can't make the live one.
- If they ask about replay AFTER the workshop has already ended: acknowledge → offer ${makeupDateLabel}. Never say "same workshop, different day." If they confirm: [NEXT_WEEK_SIGNUP]. Only if they can't do the next one either: replay goes out within 24-48 hours, to the email they registered with.
- If they explicitly can't make it — or signal it implicitly (e.g. "I'm slammed today", "something came up", "can't swing it"): Empathize → Redirect → "are you around ${makeupDateLabel}?" Add [CANT_MAKE_IT] (removes them from active workflows).
  → If they confirm: [NEXT_WEEK_SIGNUP] (adds reschedule tag; team confirms them for the makeup date).
  → If they decline/unsure: replay within 24-48 hours, sent to their email. Point to webinar.saintsofflow.com.
- If they can never do Saturdays specifically (e.g. "I work Saturdays", "Saturdays never work for me"): Empathize → replay within 24-48 hours → let them know we'll reach out if we ever run one on a different day. Add [CANT_MAKE_IT] (removes from workflows) + [NEVER_SATURDAYS] (tags them for non-Saturday outreach).${makeupDayOfWeek === "Saturday" ? ` Do NOT mention ${makeupDateLabel} — it's a Saturday.` : ` Offer ${makeupDateLabel} — it falls on a ${makeupDayOfWeek}.`}
- If they can't do weekends in general (e.g. "weekends are hard for me", "I work every weekend", "weekends don't work", "weekends are hard to swing", "these are always hard for me"): Empathize → replay within 24-48 hours → let them know we'll reach out if we ever run one during the week → point to webinar.saintsofflow.com for future dates. You MUST include both [CANT_MAKE_IT] (removes from workflows) and [NEVER_WEEKENDS] (tags for weekday-only outreach) — both are required every time, no exceptions. Missing [NEVER_WEEKENDS] is a mistake even if [CANT_MAKE_IT] is included.${makeupIsWeekend ? ` Do NOT mention ${makeupDateLabel} — it falls on a ${makeupDayOfWeek}.` : ` Offer ${makeupDateLabel} — it falls on a ${makeupDayOfWeek}, a weekday.`}
- AMBIGUOUS (traveling, might be busy — hasn't said they can't attend): Clarify → "oh nice — are you thinking you won't be able to make it, or might you be able to catch it from there?" Don't assume.
- Never proactively mention the replay.

READING CONTEXT:
- Last message asked which of the Big Three → They may reply with a word, a number (1 = career, 2 = love, 3 = confidence), multiple numbers, "all three", or a ranked list. Respond the same way regardless: validate their answer warmly, then "I've actually been hearing that a lot", then close — excited to see them and support them in that. Brief, no follow-up questions, no logistics.
- Last message asked about ${makeupDateLabel} + "yes" → confirm them. Add [NEXT_WEEK_SIGNUP] (adds reschedule tag; team confirms them for the makeup date).
- Replying to missed call, can't call back → Empathize, let them know they can text any questions. Don't ask about the workshop.

POST-WORKSHOP SURVEY (last outbound asked them to reply 1, 2, 3, or 4):
- Reply 1: [DND] (applies Do Not Disturb in GHL) and nothing else — no message sent.
- Reply 2: Empathize → "are you around ${makeupDateLabel}?" No tokens yet.
  → If last outbound already asked about ${makeupDateLabel} and they say yes: confirm them. Add [NEXT_WEEK_SIGNUP] (reschedules them).
- Reply 3: Empathize → No-oriented question track (see NO-ORIENTED QUESTION skill).
- Reply 4: "thanks so much for being real about that 🫶🏼 we never want finances to be the only thing standing in the way — we actually have some lower-cost and sliding scale options now. if you'd like to explore what might work for your budget, feel free to book a quick call: ${BOOKING_LINK}" Then [HANDOFF] (alerts team) on its own line.
- Outside 1-4: Empathize → ask one genuine follow-up question.
- Last outbound asked them to reply 1 to confirm a booking: "awesome! thanks so much — looking forward to meeting you 🙌🏼"
- Last outbound was an appointment confirmation request (asking them to reply "1" to confirm a scheduled call or appointment): Reply "1" → "awesome! we'll see you then 🙏🏼"
</playbook>

<tokens>
Stripped before sending — never visible to the contact. Each token's trigger and meaning are described where it appears in <playbook> and <skills>. Reference list:
[UNSURE] [CANT_MAKE_IT] [NEXT_WEEK_SIGNUP] [NEVER_SATURDAYS] [NEVER_WEEKENDS] [DND] [HANDOFF]
</tokens>

<rules>
1. KNOWLEDGE WHITELIST: Your knowledge is ONLY what is in <knowledge_base>. No general knowledge, no inferences, no gap-filling. Both "yes" and "no" answers to factual questions require a KB line — "it's not mentioned" is not the same as "it doesn't exist." If it is not in the knowledge base, it is [UNSURE]. No exceptions.

2. SILENCE OVER WRONG: [UNSURE] beats making something up. A wrong answer destroys trust. A non-answer triggers a human follow-up. This includes estimates, ranges, and approximate answers — a hedged fabrication is still a fabrication.

3. TONE: Warm and genuine. Texty and casual — contractions, lowercase sometimes, no em dashes, never corporate. "9am" not "9:00am", "pt" not "Pacific Time". Emojis: occasional, max one per reply. Short — a text, not an email.

4. DAY OF WEEK: Always use ${workshopDayOfWeek} as the workshop day. Never say "Saturday" unless the workshop actually falls on a Saturday.

5. SIGN-OFF: Follow the sign-off instruction in <time_context> exactly when closing a response.

6. NEVER: Offer to remove someone from the list. Proactively mention the replay. Discuss TFC, The Flow Code, coaching pricing, or post-workshop next steps — those are [UNSURE].
</rules>`;
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

// Workflow IDs for active pre-workshop sequences — both are tried; safe if contact isn't enrolled
const ACTIVE_WORKFLOW_IDS = [
  "94e2fd72-8859-4cde-b590-67f9bc6fd77d",
  "c73447b5-63fa-4c0e-9d21-2f6c5c9daf00",
  "5d374f91-84a1-4900-8ef7-235e2306435f",
];

async function removeFromGHLWorkflows(contactId) {
  if (!contactId || !GHL_API_KEY) return;
  for (const workflowId of ACTIVE_WORKFLOW_IDS) {
    try {
      const res = await fetch(
        `https://services.leadconnectorhq.com/contacts/${contactId}/workflow/${workflowId}`,
        {
          method: "DELETE",
          headers: {
            "Authorization": `Bearer ${GHL_API_KEY}`,
            "Version": "2021-07-28",
          },
        }
      );
      console.log(`GHL workflow ${workflowId} removal for ${contactId}: ${res.status}`);
    } catch (err) {
      console.error(`GHL workflow removal error (${workflowId}):`, err);
    }
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
  const contactName = req.body.customData?.contactName || req.body.full_name || req.body.contactName;
  const contactPhone = req.body.customData?.contactPhone || req.body.phone || req.body.contactPhone;
  const mockNow = req.body.mockNow || null; // ISO string for QA time simulation
  const mockMakeupISO = req.body.mockMakeupISO || null; // ISO string to override makeup date in QA
  const mockWorkshopISO = req.body.mockWorkshopISO || null; // ISO string to override primary workshop date in QA

  // GHL sends message as an object { type, body } — extract the text correctly
  const rawMessage = req.body.message;
  const messageText = (typeof rawMessage === "object" ? rawMessage?.body : rawMessage) || req.body.customData?.message || "";
  if (!messageText.trim()) return res.status(400).json({ error: "No message" });

  // iMessage reactions forwarded by GHL — drop silently, no reply, no Slack alert
  const REACTION_REGEX = /^(liked|loved|emphasized|questioned|disliked|ha ha|laughed at|le encantó|le encanto|le gustó|le gusto|reacted .{1,30} to)\s+["""']/i;
  if (REACTION_REGEX.test(messageText.trim())) {
    console.log(`Reaction message detected — dropping silently: "${messageText.slice(0, 60)}"`);
    return res.status(200).json({ reply: null, reaction: true });
  }

  // SMS opt-out keywords — carrier/GHL handles these; bot drops silently, no Slack alert
  const OPT_OUT_REGEX = /^(stop|unsubscribe|cancel|end|quit)$/i;
  if (OPT_OUT_REGEX.test(messageText.trim())) {
    console.log(`Opt-out keyword detected — dropping silently: "${messageText.trim()}"`);
    return res.status(200).json({ reply: null, optOut: true });
  }

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
  const systemPrompt = await buildSystemPrompt(mockNow, mockMakeupISO, mockWorkshopISO);

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

  // ── Handle UNSURE — bot flagged it doesn't have the answer ───────────────
  if (reply.includes("[UNSURE]")) {
    console.log("UNSURE — bot flagged unknown, alerting team");
    await sendSlackMessage(
      `❓ *Bot flagged as unsure — needs human follow-up*\n*Contact:* ${contactInfo}\n*Their message:* "${messageText}"${ghlLink(contactId)}\n\nBot didn't have the answer. Please reply manually.`
    );
    logToSheet({ contactName, contactPhone, contactId, message: messageText, triage: "UNSURE", reply: "[no reply sent]", nextWeekSignup: false, confidence: null });
    return res.json({ reply: null, unsure: true });
  }

  // ── Strip internal tokens ─────────────────────────────────────────────────
  const cantMakeIt = reply.includes("[CANT_MAKE_IT]");
  const nextWeekSignup = reply.includes("[NEXT_WEEK_SIGNUP]");
  const neverSaturdays = reply.includes("[NEVER_SATURDAYS]");
  const neverWeekends = reply.includes("[NEVER_WEEKENDS]");
  const handoff = reply.includes("[HANDOFF]");
  reply = reply
    .replace(/\[CANT_MAKE_IT\]/g, "")
    .replace(/\[NEXT_WEEK_SIGNUP\]/g, "")
    .replace(/\[NEVER_SATURDAYS\]/g, "")
    .replace(/\[NEVER_WEEKENDS\]/g, "")
    .replace(/\[HANDOFF\]/g, "")
    .trim();

  // ── Fire side effects (reply is confirmed good) ──────────────────────────

  if (cantMakeIt) {
    await removeFromGHLWorkflows(contactId);
    console.log(`Workflows removed for ${contactId} (can't make it this week)`);
  }

  if (nextWeekSignup) {
    await removeFromGHLWorkflows(contactId); // remove from this week's workflows
    await addGHLTag(contactId, "reschedule");
    await sendSlackMessage(
      `📋 *Next week signup*\n*Contact:* ${contactInfo}${ghlLink(contactId)}\nConfirmed for next workshop — please add them to the list.`
    );
  }

  if (neverSaturdays) {
    await removeFromGHLWorkflows(contactId);
    await addGHLTag(contactId, "never-saturdays");
    console.log(`never-saturdays tag added for ${contactId}`);
  }

  if (neverWeekends) {
    await removeFromGHLWorkflows(contactId);
    await addGHLTag(contactId, "never-weekends");
    console.log(`never-weekends tag added for ${contactId}`);
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
  const triagetag = ["CONTEXTUAL", nextWeekSignup && "NEXT_WEEK", neverSaturdays && "NEVER_SAT", neverWeekends && "NEVER_WKND", handoff && "HANDOFF"].filter(Boolean).join("+");
  logToSheet({ contactName, contactPhone, contactId, message: messageText, triage: triagetag, reply, nextWeekSignup, confidence: null });

  const delay = typingDelay(reply);
  console.log(`Reply: "${reply}"`);
  console.log(`Typing delay: ${Math.round(delay / 1000)}s for ${reply.length} char reply`);

  const tokenFlags = { cantMakeIt, nextWeekSignup, neverSaturdays, neverWeekends, handoff };

  if (contactId) {
    // Respond to GHL webhook immediately so it doesn't time out,
    // then wait the delay before actually sending the SMS
    res.json({ reply, sent: true, ...tokenFlags });
    await sleep(delay);
    try {
      await sendGHLReply(contactId, reply);
    } catch (err) {
      console.error("GHL send error:", err);
    }
  } else {
    // Local tester — no delay
    res.json({ reply, ...tokenFlags });
  }
});

// ─── Other routes (unchanged) ─────────────────────────────────────────────────

app.get("/invite.ics", async (req, res) => {
  const attendeeEmail = req.query.email || "";
  const attendeeName = req.query.name || attendeeEmail;
  const workshopTime = getWorkshopDate();
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

// Workshop info endpoint — lets QA suite use same date source as the bot
app.get("/workshop-info", async (req, res) => {
  try {
    const workshopTime = getWorkshopDate();
    const makeupTime = getMakeupDate(workshopTime);
    res.json({
      workshopDay: workshopTime.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Los_Angeles" }),
      workshopDateLabel: workshopTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Los_Angeles" }),
      makeupDateLabel: makeupTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Los_Angeles" }),
      workshopISO: workshopTime.toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    } else if(data.unsure){
      addMessage("system","UNSURE — bot flagged it didn't have the answer. Slack alerted, team will follow up.");
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
