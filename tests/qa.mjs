#!/usr/bin/env node
/**
 * SOF Bot QA Suite
 * ─────────────────────────────────────────────────────────────────────────
 * Runs multi-turn conversations against the local bot server, scores each
 * one with Claude, and generates a human-readable HTML review report.
 *
 * Usage:
 *   node tests/qa.mjs                                          # run all tests
 *   node tests/qa.mjs --filter survey                         # single category/id match
 *   node tests/qa.mjs --filter "out of scope,context,time"   # comma-separated (focus mode)
 *   node tests/qa.mjs --exclude "time,big three"             # skip categories
 *   BOT_URL=https://your-staging.railway.app node tests/qa.mjs
 *
 * Requires: ANTHROPIC_API_KEY env var. Bot server must be running.
 * Output:   terminal report + tests/qa-report.html
 */

import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const BOT_URL = process.env.BOT_URL || "http://localhost:3000";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const FILTER      = process.argv.find((a, i) => process.argv[i - 1] === "--filter");
const EXCLUDE     = process.argv.find((a, i) => process.argv[i - 1] === "--exclude");
const FAILED_ONLY = process.argv.includes("--failed-only");
const __dir = dirname(fileURLToPath(import.meta.url));
const TODAY = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

// ── Workshop date — fetched from bot (same source of truth as server) ─────────

async function fetchWorkshopInfo() {
  try {
    const res = await fetch(`${BOT_URL}/workshop-info`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return { workshopDay: "Sunday", workshopDateLabel: "Sunday (unknown)", makeupDateLabel: "Sunday (unknown)", workshopISO: null };
  }
}

// ── API helpers ───────────────────────────────────────────────────────────────

const post = (path, body) =>
  fetch(`${BOT_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const reset = () => fetch(`${BOT_URL}/reset`, { method: "POST" });
const seed = (messages) => post("/seed", { messages });
const chat = (message, mockNow = null, mockMakeupISO = null, mockWorkshopISO = null) => post("/chat", { message, contactName: "QA Tester", contactPhone: "+1 (555) 000-0000", ...(mockNow && { mockNow }), ...(mockMakeupISO && { mockMakeupISO }), ...(mockWorkshopISO && { mockWorkshopISO }) });

// ── Seeds and tests built after fetching workshop info ────────────────────────

const { workshopDay, workshopDateLabel, makeupDateLabel, workshopISO } = await fetchWorkshopInfo();

// ── Makeup date overrides for day-of-week QA tests ────────────────────────────
// Returns ISO of next occurrence of targetDay (0=Sun … 6=Sat) after workshopISO
function nextDayISO(targetDay) {
  if (!workshopISO) return null;
  const ref = new Date(workshopISO);
  let daysAhead = (targetDay - ref.getDay() + 7) % 7 || 7;
  return new Date(ref.getTime() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
}
const mockMakeupWednesday = nextDayISO(3); // next Wednesday after workshop
const mockMakeupSaturday  = nextDayISO(6); // next Saturday after workshop

// Mock a Saturday as the primary workshop date — needed for never-saturdays tests
// (real workshop may be any day; these tests only make sense against a Saturday workshop)
const mockWorkshopSaturdayISO = mockMakeupSaturday; // next Saturday after the real workshop
const mockNowBeforeSaturdayWorkshop = mockWorkshopSaturdayISO
  ? new Date(new Date(mockWorkshopSaturdayISO).getTime() - 13 * 60 * 60 * 1000).toISOString()
  : null;
// Makeup dates relative to the mock Saturday workshop
function nextDayISOFromRef(refISO, targetDay) {
  if (!refISO) return null;
  const ref = new Date(refISO);
  const daysAhead = (targetDay - ref.getDay() + 7) % 7 || 7;
  return new Date(ref.getTime() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
}
const mockMakeupWednesdayRelToSat = nextDayISOFromRef(mockWorkshopSaturdayISO, 3);
const mockMakeupSaturdayRelToSat  = nextDayISOFromRef(mockWorkshopSaturdayISO, 6);

// ── Mock time helpers (relative to workshop start at 9am PT) ──────────────────
// All times are ISO strings the server accepts as mockNow

function mockTime(offsetHours) {
  // offsetHours relative to workshop start: -168 = 7 days before, -24 = day before, -1 = 1hr before, +1 = 1hr after
  if (!workshopISO) return null;
  return new Date(new Date(workshopISO).getTime() + offsetHours * 60 * 60 * 1000).toISOString();
}

const T = {
  sevenDaysBefore:  mockTime(-168),      // 7 days out
  threeDaysBefore:  mockTime(-72),       // 3 days out
  dayBefore8pm:     mockTime(-13),       // evening before (8pm PT)
  morningOf8am:     mockTime(-1),        // 1 hour before workshop
  thirtyMinsBefore: mockTime(-0.5),      // 30 minutes before
  fiveMinsBefore:   mockTime(-0.0833),   // 5 minutes before
  fifteenMinsAfter: mockTime(0.25),      // 15 minutes after start
  duringWorkshop:   mockTime(0.5),       // 30 min after start
  dayAfter:         mockTime(25),        // next day
};

// ── Reusable seed templates ───────────────────────────────────────────────────
// These match the actual GHL automation messages sent to contacts.

const S = {
  // Week-out outbound — first text sent after registration (seat confirmation)
  weekOut: [
    { role: "assistant", content: `Hey! it's me Jason Crouse. I just saved your seat for my upcoming Big Three Mastery Workshop. Mark your calendar for ${workshopDateLabel}, at 9am PST 🙌🏼 I also sent you an email with important details, so make sure to open that before we go live!` },
  ],

  // Day-before outbound ("do you have any questions?")
  preWorkshop: [
    { role: "assistant", content: `it's Jason! Do you have any questions for me before our live workshop tomorrow? Start time is 9am PST` },
  ],

  // 30-mins-before outbound (zoom link drop)
  zoomLinkDrop: [
    { role: "assistant", content: `Hey! We're live with The Big Three Mastery Workshop in 30 mins. As promised, your link: https://us06web.zoom.us/j/89429086241` },
  ],

  // Morning-of outbound ("are you still going to make it?")
  askingQuestions: [
    { role: "assistant", content: `Hey, it's Jason Crouse. Today's live training starts at 9am PST sharp. Are you still going to make it?` },
  ],

  // Post-workshop survey
  survey: [
    { role: "assistant", content: `We'd genuinely love to hear where you're at after the workshop today 😊 Feel free to just reply with the number that fits best:\n1. I didn't really find it valuable\n2. I wasn't able to fully pay attention but would like to join the next one\n3. I found it valuable but something is still holding me back\n4. I found it valuable but can't financially invest in my growth right now` },
  ],

  // Missed workshop — first follow-up (hosting another one on the makeup date)
  missedWorkshop: [
    { role: "assistant", content: `Hey, was just reaching out because I saw you missed the workshop last week. We are hosting another one on ${makeupDateLabel} at 9am PST. Want me to save you a seat?` },
  ],

  // Generic "any questions?" — used for sign-off tests where timing varies via mockNow
  checkIn: [
    { role: "assistant", content: "hey! just checking in — any questions before the workshop? 🙌🏼" },
  ],

  // Missed workshop — re-invite to "2.0 edition" (longer gap)
  missedWorkshopReinvite: [
    { role: "assistant", content: `Hey it's Jason Crouse. Saw you missed my last workshop, and wanted to invite you to the 2.0 edition this ${workshopDay} at 9am PST - will be sending the link here 25 mins before the day of the workshop` },
  ],

  // Big Three follow-up (after a call)
  bigThreeQ: [
    { role: "assistant", content: "hey! just following up from our call earlier 🙌🏼 quick question — which of the Big Three are you most focused on right now? career & purpose, love & relationships, or confidence & self-trust?" },
  ],

  // Booking confirmation ("reply 1 to confirm")
  bookingConfirm: [
    { role: "assistant", content: "awesome! i went ahead and sent you the booking link. please reply 1 to confirm your spot 🙌🏼" },
  ],

  // Bot just asked about the makeup date
  nextWeekAsk: [
    { role: "assistant", content: `totally understand! are you around ${makeupDateLabel}?` },
  ],
};

// ── Test definitions ──────────────────────────────────────────────────────────
// Each test:
//   seed     – conversation history to load before starting
//   turns    – array of messages to send in sequence
//   rubric   – what the scorer evaluates (be specific)
//   check    – optional programmatic assertion on the FINAL response
//   critical – if true, a failure here is especially important to flag

const TESTS = [

  // ══════════════════════════════════════════════════════════════════════════
  // POST-WORKSHOP SURVEY — replies to 1 / 2 / 3 / 4 at different moments
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "survey-1-dnd",
    category: "Survey",
    name: "Reply '1' to survey — apply DND, no message",
    critical: true,
    mockNow: T.dayAfter,
    seed: S.survey,
    turns: ["1"],
    rubric: "Reply 1 to the post-workshop survey means they didn't find it valuable. Bot must apply DND (response.dnd === true) and send NO reply (response.reply === null). Nothing else.",
    check: (r) => r.dnd === true && r.reply === null,
  },
  {
    id: "survey-2-next-week",
    category: "Survey",
    name: `Reply '2' to survey — ask about make-up date (${makeupDateLabel})`,
    mockNow: T.dayAfter,
    seed: S.survey,
    turns: ["2"],
    rubric: `Reply 2 means they couldn't fully attend and want the next workshop. Bot should warmly acknowledge they missed it and ask if they're free for the make-up date: "${makeupDateLabel}." Should NOT confirm them yet. Should NOT pitch or ask what held them back. No tokens yet.`,
  },
  {
    id: "survey-3-round1",
    category: "Survey",
    name: "Reply '3' to survey — Voss opens (round 1)",
    mockNow: T.dayAfter,
    seed: S.survey,
    turns: ["3"],
    rubric: "Reply 3 means found it valuable but something is holding them back. Bot must open with ONE calibrated what/how question — e.g. 'what would need to be different for this to feel like the right time?' Must NOT pitch, sell, mention the booking link, or ask two questions at once.",
  },
  {
    id: "survey-3-round2",
    category: "Survey",
    name: "Voss round 2 — deepen after their response",
    mockNow: T.dayAfter,
    seed: [
      ...S.survey,
      { role: "user", content: "3" },
      { role: "assistant", content: "what would need to be different for this to feel like the right time?" },
    ],
    turns: ["i just feel like i need more time to think about it"],
    rubric: "Round 2 of Voss. Bot should reflect back what they said and go one level deeper with ONE more what/how question. Still no booking link. Still no pitch. One question only.",
  },
  {
    id: "survey-3-offer-call",
    category: "Survey",
    name: "Voss round 3 — move toward offering the call",
    mockNow: T.dayAfter,
    seed: [
      ...S.survey,
      { role: "user", content: "3" },
      { role: "assistant", content: "what would need to be different for this to feel like the right time?" },
      { role: "user", content: "i just need more time to think" },
      { role: "assistant", content: "totally makes sense — what part of it feels like it needs more clarity? is it about what's included, or something else?" },
    ],
    turns: ["honestly i'm just not sure it's the right fit for me"],
    rubric: "Round 3. Non-financial blocker. Acceptable outcomes: (1) another calibrated what/how question, (2) a no-oriented call offer ('would you be opposed to a quick conversation?'), or (3) a warm graceful close if the person has expressed clear doubt about fit ('not sure it's the right fit for me'). All three are valid. Must NOT repeat the exact same question from the previous turn. Must NOT provide the booking link yet. One question only if asking. Score negatively ONLY if: bot repeats verbatim from last turn, pushes hard, or gives the booking link URL.",
  },
  {
    id: "survey-3-accepts-call",
    category: "Survey",
    name: "Voss — they accept the call, bot provides booking link",
    critical: true,
    mockNow: T.dayAfter,
    seed: [
      ...S.survey,
      { role: "user", content: "3" },
      { role: "assistant", content: "would you be opposed to a quick conversation with Jason just to see if it's a fit?" },
    ],
    turns: ["yeah I'd actually be open to that"],
    rubric: "They said yes to a call. Bot must provide the booking link (URL must contain 'leadconnectorhq.com/widget/bookings'). Warm, not pushy.",
    check: (r) => r.reply && r.reply.includes("leadconnectorhq.com"),
  },
  {
    id: "survey-3-declines-call",
    category: "Survey",
    name: "Voss — they decline the call",
    mockNow: T.dayAfter,
    seed: [
      ...S.survey,
      { role: "user", content: "3" },
      { role: "assistant", content: "would you be opposed to a quick conversation with Jason just to see if it's a fit?" },
    ],
    turns: ["no i don't think that's right for me"],
    rubric: "They said no to a call. Bot should close warmly and gracefully — 'totally get it, I really appreciate you sharing that.' Should NOT push or pitch further.",
  },
  {
    id: "survey-4-financial",
    category: "Survey",
    name: "Reply '4' to survey — financial barrier",
    critical: true,
    mockNow: T.dayAfter,
    seed: S.survey,
    turns: ["4"],
    rubric: "Reply 4 = financial barrier. Should warmly acknowledge it, mention lower-cost/sliding scale options, and provide the booking link URL (must contain 'leadconnectorhq.com/widget/bookings').",
    check: (r) => r.reply && r.reply.includes("leadconnectorhq.com"),
  },
  {
    id: "survey-5-unexpected",
    category: "Survey",
    name: "Reply '5' to survey — not a valid option",
    mockNow: T.dayAfter,
    seed: S.survey,
    turns: ["5"],
    rubric: "Reply 5 is outside the survey options. Bot should treat it as unexpected feedback and respond warmly, asking one follow-up question. Must NOT apply DND. Must NOT add nextWeekSignup. Must NOT provide booking link.",
    check: (r) => r.dnd !== true && r.reply !== null,
  },
  {
    id: "survey-text-reply",
    category: "Survey",
    name: "Text reply to survey instead of a number",
    mockNow: T.dayAfter,
    seed: S.survey,
    turns: ["It was really good but I'm not quite ready to invest right now"],
    rubric: "Text instead of a number. Should be treated like a 3/4 context (found it valuable, money is a concern). Should open warmly and start the Voss conversation. Must NOT apply DND.",
    check: (r) => r.dnd !== true,
  },

  // ══════════════════════════════════════════════════════════════════════════
  // BIG THREE CONTEXT — replies to Lex's personal outreach call follow-up
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "big-three-career",
    category: "Big Three",
    name: "Big Three reply — 'career for sure'",
    seed: S.bigThreeQ,
    turns: ["career for sure"],
    rubric: "Bot should respond warmly and briefly regardless of the answer — something like 'awesome, I've actually been hearing that a lot. I think you're gonna love tomorrow.' Short. No follow-up questions. No workshop logistics.",
  },
  {
    id: "big-three-reply-2",
    category: "Big Three",
    name: "CRITICAL: '2' in Big Three context = love, NOT survey reply",
    critical: true,
    seed: S.bigThreeQ,
    turns: ["2"],
    rubric: "Replying '2' in Big Three context means love & relationships — NOT a survey reply 2. Must NOT add nextWeekSignup. Must NOT apply DND. Must send a warm brief reply. A standard sign-off like 'see you Sunday' is fine and expected.",
    check: (r) => r.reply !== null && r.dnd !== true && !r.nextWeekSignup,
  },
  {
    id: "big-three-all-three",
    category: "Big Three",
    name: "Big Three — 'honestly all three'",
    seed: S.bigThreeQ,
    turns: ["honestly all three lol"],
    rubric: "Must validate the 'all three' feeling warmly first — something like 'haha I totally get that — most people feel pulled in all three directions.' Then confirm we've been hearing that a lot. Then close warmly — excited to see them and support them. Any opening word (including 'awesome') is fine as long as it fits the emotional context. Must NOT skip straight to sign-off. Must NOT ask a follow-up question. No workshop logistics.",
  },
  {
    id: "big-three-cant-talk",
    category: "Big Three",
    name: "Big Three context — can't talk right now",
    seed: S.bigThreeQ,
    turns: ["Can't really talk right now, I'll text later"],
    rubric: "They're replying to a missed call. Should acknowledge warmly and let them know they can text any time. Should NOT ask about workshop attendance or jump to logistics.",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // BOOKING CONFIRMATION — '1' in DIFFERENT context = confirm, not DND
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "booking-confirm-1",
    category: "Booking",
    name: "CRITICAL: '1' to confirm booking — NOT DND",
    critical: true,
    seed: S.bookingConfirm,
    turns: ["1"],
    rubric: "CRITICAL: Replying '1' to a booking confirmation message is NOT a survey reply 1. Must NOT apply DND. Must send a warm reply like 'awesome! thanks so much — looking forward to meeting you 🙌🏼'",
    check: (r) => r.dnd !== true && r.reply !== null,
  },
  {
    id: "booking-confirm-after-survey-2",
    category: "Booking",
    name: "CRITICAL: '1' to booking confirm after survey flow",
    critical: true,
    seed: [
      ...S.survey,
      { role: "user", content: "2" },
      { role: "assistant", content: "so glad you want to join again! getting you added for next Saturday 🙌🏼 Jason's team will also reach out — please reply 1 to confirm you're open to a quick call" },
    ],
    turns: ["1"],
    rubric: "CRITICAL context: the last outbound message was a booking confirmation ('reply 1 to confirm'), NOT the survey. Replying '1' here is a booking confirmation. Must NOT apply DND. Must send a warm confirmation reply.",
    check: (r) => r.dnd !== true && r.reply !== null,
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SHORT REPLY CONTEXT READING
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "no-no-questions",
    category: "Context Reading",
    name: "'no no questions' = no questions, NOT can't attend",
    critical: true,
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["no no questions"],
    rubric: `CRITICAL: 'no no questions' means they have NO questions — not that they can't attend. Bot must wrap up warmly with a day-before sign-off. Must NOT ask about ${makeupDateLabel}. Must NOT mention the replay.`,
  },
  {
    id: "yes-after-next-saturday",
    category: "Context Reading",
    name: `'yes' after 'are you around next ${workshopDay}?' = confirm them`,
    mockNow: T.dayBefore8pm,
    seed: [
      ...S.preWorkshop,
      { role: "user", content: "I can't make it this week unfortunately" },
      ...S.nextWeekAsk,
    ],
    turns: ["yes!"],
    rubric: `Saying 'yes' in response to 'are you around ${makeupDateLabel}?' means they're confirming the make-up workshop. Bot should confirm them for ${makeupDateLabel} at 9am pt and signal nextWeekSignup.`,
    check: (r) => r.nextWeekSignup === true,
  },
  {
    id: "yes-remembers-workshop",
    category: "Context Reading",
    name: "'yes' after 'does that ring a bell?' = they remember, NOT a question",
    mockNow: T.dayBefore8pm,
    seed: [
      ...S.preWorkshop,
      { role: "user", content: "I don't remember signing up?" },
      { role: "assistant", content: `of course! you registered for the Big Three Mastery Workshop with Jason Crouse — it covers career, love, and confidence. it's this ${workshopDay} at 9am pt. does that ring a bell?` },
    ],
    turns: ["yes!"],
    rubric: "'yes' here means they remember the workshop, not that they have a question. Bot should respond warmly — 'awesome! so excited for you to be there' — and maybe ask if they have any questions. Must NOT respond with 'great, what's your question?'",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // ATTENDANCE SCENARIOS
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "cant-make-this-saturday",
    category: "Attendance",
    name: `Can't make it this ${workshopDay}`,
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: [`I can't make it this ${workshopDay} unfortunately`],
    rubric: `Should ask warmly about ${makeupDateLabel} and leave it there. Must NOT immediately volunteer the replay. Must NOT add nextWeekSignup yet (they haven't confirmed).`,
    check: (r) => !r.nextWeekSignup,
  },
  {
    id: "never-saturdays",
    category: "Attendance",
    name: "Can NEVER do Saturdays specifically",
    critical: true,
    mockNow: mockNowBeforeSaturdayWorkshop,
    mockWorkshopISO: mockWorkshopSaturdayISO,
    seed: S.preWorkshop,
    turns: ["I can never make Saturdays, it's my busiest day at work"],
    rubric: `Can't do Saturdays specifically. Must respond warmly, mention the replay (within 24-48 hours, to their email), and let them know we'll reach out if we ever run one on a different day. Must apply [CANT_MAKE_IT] and [NEVER_SATURDAYS] tags. Must NOT apply [NEVER_WEEKENDS].`,
    check: (r) => r.neverSaturdays === true && r.cantMakeIt === true,
  },
  {
    id: "cant-do-weekends",
    category: "Attendance",
    name: "Can't do weekends in general",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["Weekends are just impossible for me unfortunately"],
    rubric: `Can't do weekends at all. Must respond warmly, mention the replay (within 24-48 hours, to their email), and let them know we'll reach out if we ever run one during the week. Must apply [CANT_MAKE_IT] and [NEVER_WEEKENDS] tags. Must NOT apply [NEVER_SATURDAYS].`,
    check: (r) => r.neverWeekends === true && r.cantMakeIt === true,
  },
  {
    id: "never-saturdays-makeup-wednesday",
    category: "Attendance",
    name: "Can't do Saturdays — makeup is Wednesday (should offer it)",
    mockNow: mockNowBeforeSaturdayWorkshop,
    mockWorkshopISO: mockWorkshopSaturdayISO,
    mockMakeupISO: mockMakeupWednesdayRelToSat,
    seed: S.preWorkshop,
    turns: ["I can never make Saturdays, it's my busiest day at work"],
    rubric: `Can't do Saturdays. The makeup date falls on a Wednesday — bot SHOULD offer it since it's not a Saturday. Must apply [CANT_MAKE_IT] and [NEVER_SATURDAYS]. Must mention the Wednesday makeup date in the reply.`,
    check: (r) => r.neverSaturdays === true && r.cantMakeIt === true,
  },
  {
    id: "never-saturdays-makeup-saturday",
    category: "Attendance",
    name: "Can't do Saturdays — makeup is Saturday (should NOT offer it)",
    mockNow: mockNowBeforeSaturdayWorkshop,
    mockWorkshopISO: mockWorkshopSaturdayISO,
    mockMakeupISO: mockMakeupSaturdayRelToSat,
    seed: S.preWorkshop,
    turns: ["I can never make Saturdays, it's my busiest day at work"],
    rubric: `Can't do Saturdays. The makeup date falls on a Saturday — bot must NOT offer it. Should only mention replay and that we'll reach out if we run one on a different day. Must apply [CANT_MAKE_IT] and [NEVER_SATURDAYS].`,
    check: (r) => r.neverSaturdays === true && r.cantMakeIt === true,
  },
  {
    id: "never-weekends-makeup-wednesday",
    category: "Attendance",
    name: "Can't do weekends — makeup is Wednesday (should offer it)",
    mockNow: T.dayBefore8pm,
    mockMakeupISO: mockMakeupWednesday,
    seed: S.preWorkshop,
    turns: ["Weekends are just impossible for me unfortunately"],
    rubric: `Can't do weekends. The makeup date falls on a Wednesday — bot SHOULD offer it since it's a weekday. Must apply [CANT_MAKE_IT] and [NEVER_WEEKENDS]. Must mention the Wednesday makeup date in the reply.`,
    check: (r) => r.neverWeekends === true && r.cantMakeIt === true,
  },
  {
    id: "never-weekends-makeup-saturday",
    category: "Attendance",
    name: "Can't do weekends — makeup is Saturday (should NOT offer it)",
    mockNow: T.dayBefore8pm,
    mockMakeupISO: mockMakeupSaturday,
    seed: S.preWorkshop,
    turns: ["Weekends are just impossible for me unfortunately"],
    rubric: `Can't do weekends. The makeup date falls on a Saturday — bot must NOT offer it. Should only mention replay and that we'll reach out if we ever run one during the week. Must apply [CANT_MAKE_IT] and [NEVER_WEEKENDS].`,
    check: (r) => r.neverWeekends === true && r.cantMakeIt === true,
  },
  {
    id: "ambiguous-driving",
    category: "Attendance",
    name: "AMBIGUOUS: driving that day (clarify, don't assume)",
    critical: true,
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["I'll be driving to Santa Barbara that day"],
    rubric: `AMBIGUOUS — driving somewhere doesn't mean they can't attend. Bot must ask ONE clarifying question like 'oh nice — are you thinking you won't be able to make it, or might you be able to catch it from there?' Must NOT assume they can't attend. Must NOT mention replay or next ${workshopDay} yet.`,
    check: (r) => !r.nextWeekSignup,
  },
  {
    id: "ambiguous-traveling",
    category: "Attendance",
    name: "AMBIGUOUS: traveling that weekend",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["I'm actually traveling this weekend"],
    rubric: `AMBIGUOUS — traveling doesn't mean can't attend. Should ask a clarifying question. Must NOT jump to replay or next ${workshopDay}.`,
  },
  {
    id: "ambiguous-in-europe",
    category: "Attendance",
    name: "AMBIGUOUS: will be in Europe (different timezone)",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["I'm going to be in London that week"],
    rubric: `AMBIGUOUS — being in Europe doesn't mean they can't attend (9am PT = 5pm London). Should ask a clarifying question. Must NOT jump to replay or next ${workshopDay} unprompted.`,
  },
  {
    id: "slammed-today",
    category: "Attendance",
    name: "'I am slammed today' — in response to morning-of check-in",
    mockNow: T.morningOf8am,
    seed: S.askingQuestions,
    turns: ["I am slammed today"],
    rubric: `Workshop is ~1 hour away. In response to the morning-of check-in, "slammed today" is effectively a can't-make-it signal. Bot should warmly acknowledge it and pivot directly to asking about ${makeupDateLabel}. Must NOT be ambiguous — treat it as a can't-make-it and ask about the makeup date. Must NOT offer replay unprompted.`,
    check: (r) => r.cantMakeIt === true,
  },
  {
    id: "zoom-wont-open-30-mins-before",
    category: "Attendance",
    name: "Zoom won't let me join — 30 mins before start",
    mockNow: T.thirtyMinsBefore,
    seed: S.zoomLinkDrop,
    turns: ["Wouldn't let me join"],
    rubric: "Workshop hasn't started yet (30 mins out). Bot should reassure them — the room opens when we go live at 9am, so just try again then. Warm and brief. Must NOT suggest the link is broken or tell them to find a new link.",
  },
  {
    id: "family-emergency",
    category: "Attendance",
    name: "Family emergency — empathetic, then ask about next week",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["I had a family emergency come up and won't be able to make it"],
    rubric: `Should be warm and empathetic first, then gently ask about ${makeupDateLabel}. No pushiness. Tone must acknowledge what they're going through before pivoting.`,
  },

  // ══════════════════════════════════════════════════════════════════════════
  // INVITING OTHERS
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "invite-granddaughter",
    category: "Inviting Others",
    name: "Anyone can join on the same Zoom link (past bug)",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["Can my granddaughter join me on the call?"],
    rubric: "CRITICAL — this was a real bug. Anyone (family, friend, etc.) can join on the same Zoom link WITHOUT registering separately. Must NOT say they need to register separately just to attend. Registration at webinar.saintsofflow.com is only needed for follow-up materials.",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // REPLAY POLICY
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "replay-not-volunteered-prep",
    category: "Replay",
    name: "Should NOT mention replay when asked about prep",
    critical: true,
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["What should I have ready for the workshop?"],
    rubric: "Just asking about preparation. Should answer: show up, maybe pen/paper, somewhere quiet to focus. Must NOT mention the replay — this is a prep question, not an attendance question. Must NOT volunteer the Zoom link or other logistics they didn't ask about.",
  },
  {
    id: "timezone-central",
    category: "Logistics",
    name: "Timezone conversion — what time is that in Central?",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["what time is that in central?"],
    rubric: "They want the Central time equivalent. Should answer 11am ct. Short and direct. Must NOT mention the replay or ask if they can make it.",
  },
  {
    id: "timezone-mountain-confirm",
    category: "Logistics",
    name: "Timezone check — 'so 10am mountain time?'",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["so that's 10am mountain time?"],
    rubric: "They're confirming their timezone math (10am MT is correct for 9am PT). Bot should confirm yes, warm and brief. Must NOT volunteer other timezones or mention the replay.",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TIME-SENSITIVE LANGUAGE — sign-off scenarios at different points in time
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "time-signoff-7days",
    category: "Time",
    critical: true,
    name: `Sign-off: 7 days out → "see you ${workshopDay}, [date]"`,
    mockNow: T.sevenDaysBefore,
    seed: S.checkIn,
    turns: ["nope, all good!"],
    rubric: `Workshop is 7 days away. Sign-off should include the day and date — e.g. "see you ${workshopDateLabel}!" Must NOT say "see you tomorrow" or "see you soon". Must NOT say "see you Saturday" if the workshop is on a ${workshopDay}.`,
    check: (r) => r.reply !== null,
  },
  {
    id: "time-signoff-3days",
    category: "Time",
    name: `Sign-off: 3 days out → "see you ${workshopDay}"`,
    mockNow: T.threeDaysBefore,
    seed: S.checkIn,
    turns: ["no thanks, I'm all set!"],
    rubric: `Workshop is 3 days away (within 4 days). Sign-off should use just the day name — e.g. "see you ${workshopDay}!" Must NOT include the date. Must NOT say "see you tomorrow" or "see you soon".`,
    check: (r) => r.reply !== null,
  },
  {
    id: "time-signoff-day-before",
    category: "Time",
    critical: true,
    name: `Sign-off: day before → "see you tomorrow"`,
    mockNow: T.dayBefore8pm,
    seed: S.checkIn,
    turns: ["nope, good to go!"],
    rubric: `Workshop is tomorrow. Sign-off must say "see you tomorrow" — NOT the day name or date. Must NOT say "see you soon".`,
    check: (r) => r.reply && r.reply.toLowerCase().includes("tomorrow"),
  },
  {
    id: "time-signoff-morning-of",
    category: "Time",
    critical: true,
    name: `Sign-off: morning of workshop → "see you soon"`,
    mockNow: T.morningOf8am,
    seed: S.checkIn,
    turns: ["no questions, I'm ready!"],
    rubric: `Workshop starts in about 1 hour. Sign-off must convey immediacy — "see you soon", "see you in a bit", "see you shortly". Must NOT say "see you tomorrow" or use the day/date.`,
    check: (r) => r.reply && (r.reply.toLowerCase().includes("soon") || r.reply.toLowerCase().includes("in a bit") || r.reply.toLowerCase().includes("shortly")),
  },
  {
    id: "time-signoff-excited-7days",
    category: "Time",
    name: `Enthusiasm + 7 days out → correct sign-off`,
    mockNow: T.sevenDaysBefore,
    seed: S.checkIn,
    turns: ["So excited for this!!"],
    rubric: `Workshop is 7 days away. Bot should match enthusiasm. Sign-off must use day and date — "see you ${workshopDateLabel}!" Must NOT say "see you soon" or "see you tomorrow".`,
    check: (r) => r.reply !== null,
  },
  {
    id: "time-signoff-excited-tomorrow",
    category: "Time",
    name: `Enthusiasm + day before → "see you tomorrow"`,
    mockNow: T.dayBefore8pm,
    seed: S.checkIn,
    turns: ["So excited for this!!"],
    rubric: `Workshop is tomorrow. Bot should match enthusiasm and say "see you tomorrow!" Must NOT say the day name or date.`,
    check: (r) => r.reply && r.reply.toLowerCase().includes("tomorrow"),
  },
  {
    id: "time-signoff-excited-morning",
    category: "Time",
    name: `Enthusiasm + morning of → "see you soon"`,
    mockNow: T.morningOf8am,
    seed: S.askingQuestions,
    turns: ["So excited for this!!"],
    rubric: `Workshop starts in about 1 hour. Bot should match excitement. Sign-off must convey imminent timing — "see you soon", "see you in a bit", "see you in a few", etc. NOT the day name, NOT "tomorrow".`,
    check: (r) => r.reply && (r.reply.toLowerCase().includes("soon") || r.reply.toLowerCase().includes("in a bit") || r.reply.toLowerCase().includes("in a few") || r.reply.toLowerCase().includes("shortly")),
  },
  {
    id: "time-signoff-30mins",
    category: "Time",
    critical: true,
    name: `Sign-off: 30 minutes before → "see you soon"`,
    mockNow: T.thirtyMinsBefore,
    seed: S.checkIn,
    turns: ["no questions, I'm ready!"],
    rubric: `Workshop starts in 30 minutes. Sign-off must convey imminent timing — "see you soon", "see you in a bit", "see you in a few", etc. NOT "in 30 minutes", NOT tomorrow, NOT the day name.`,
    check: (r) => r.reply && (r.reply.toLowerCase().includes("soon") || r.reply.toLowerCase().includes("in a bit") || r.reply.toLowerCase().includes("in a few") || r.reply.toLowerCase().includes("shortly")),
  },
  {
    id: "time-signoff-5mins",
    category: "Time",
    critical: true,
    name: `Sign-off: 5 minutes before → "see you soon"`,
    mockNow: T.fiveMinsBefore,
    seed: S.checkIn,
    turns: ["yep, got the link!"],
    rubric: `Workshop starts in 5 minutes. They confirmed they have the link. Bot should be brief and close warmly — sign-off must convey imminent timing: "see you soon", "see you in a bit", "see you in a few", etc. Must NOT give a specific time.`,
    check: (r) => r.reply && (r.reply.toLowerCase().includes("soon") || r.reply.toLowerCase().includes("in a bit") || r.reply.toLowerCase().includes("in a few") || r.reply.toLowerCase().includes("shortly")),
  },
  {
    id: "time-signoff-15-mins-after",
    category: "Time",
    critical: true,
    name: `Sign-off: 15 minutes after start — no "see you" language`,
    mockNow: T.fifteenMinsAfter,
    seed: S.checkIn,
    turns: ["just checking in, is it too late to join?"],
    rubric: `Workshop started 15 minutes ago. Bot should tell them they can still join and give encouragement. Must NOT say "see you soon" or any "see you" sign-off — the workshop is already live. Should be warm and action-oriented.`,
    check: (r) => r.reply && !r.reply.toLowerCase().includes("see you"),
  },
  {
    id: "time-format-correct",
    category: "Time",
    name: "Time format should be casual (9am not 9:00am)",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["What time does it start?"],
    rubric: "Should answer 9am pt. May also include 12pm et as a convenience. Should use casual format: '9am' not '9:00am', 'pt' not 'Pacific Time' or 'PST', 'et' not 'Eastern Time' or 'EST'. Should NOT mention central or mountain time unless asked.",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // COMMON LOGISTICS
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "logistics-how-long",
    category: "Logistics",
    name: "How long is the workshop?",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["How long is it?"],
    rubric: "Should answer ~75-90 minutes including Q&A. Casual phrasing.",
  },
  {
    id: "logistics-is-it-free",
    category: "Logistics",
    name: "Is it free?",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["Is this free?"],
    rubric: "Should confirm yes, completely free. Simple and warm.",
  },
  {
    id: "logistics-no-confirmation-email",
    category: "Logistics",
    name: "Didn't get confirmation email",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["I never got my confirmation email"],
    rubric: "Should address the missing confirmation email. Ideally tells them to check spam AND asks what email they registered with so Jason's team can resend — either order is fine. Must NOT make promises about future reminders or deliveries.",
  },
  {
    id: "logistics-zoom-link",
    category: "Logistics",
    name: "Where is the Zoom link?",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["Where do I get the Zoom link to join?"],
    rubric: "Should say: it's in their confirmation email, and we'll also text it the morning of. Short and direct.",
  },
  {
    id: "logistics-cant-find-link",
    category: "Logistics",
    name: "Can't find the Zoom link",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["Hi! I'm not able to find the link for the workshop! Is this sent to my email?"],
    rubric: "Should confirm yes — it's in their confirmation email (check spam), and we'll also text it the morning of. Ask what email they used so we can resend if needed. Warm and reassuring.",
  },
  {
    id: "logistics-will-you-send-link",
    category: "Logistics",
    name: "Will you be sending a link?",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["Will you be sending out a link?"],
    rubric: "Should confirm yes — we'll text it the morning of, and it's also in their confirmation email. Short, warm, nothing extra.",
  },
  {
    id: "logistics-have-the-link",
    category: "Logistics",
    name: "Already has the link — just confirming",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["Thanks, I do have the link. Looking forward to it!"],
    rubric: "They already have what they need. Bot should respond warmly and briefly — 'awesome, see you [sign-off]!' Nothing else. Must NOT re-explain the link or add unnecessary info.",
  },
  {
    id: "logistics-iphone-zoom",
    category: "Logistics",
    name: "Will Zoom work on iPhone?",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["Will this link work on iPhone?"],
    rubric: "Should confirm yes, Zoom works on iPhone. Brief and warm.",
  },
  {
    id: "logistics-replay-ask",
    category: "Logistics",
    name: "Can't make weekends — asks for replay",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["Hi Jason. More unpredictable dad mornings over here. Weekends are hard for me to swing. Can you send a link for a recording so I can relisten and review at night sometime this weekend?"],
    rubric: "Weekends don't work for them — they're asking for the replay. Bot should acknowledge warmly ('dad mornings are no joke' or similar), confirm replay goes to their email within 24-48 hours after the workshop, and mention we'll reach out if we ever do one on a weekday. Must NOT ask about the makeup date (it's a weekend too). Must NOT say a replay link is available right now.",
    check: (r) => r.cantMakeIt === true && r.neverWeekends === true,
  },
  {
    id: "logistics-replay-asked-can-make-next",
    category: "Logistics",
    name: "Asks about replay — redirect to next workshop first",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["Will there be a replay?"],
    rubric: `They're asking about a replay the day before the workshop — implying they might not attend. Bot should acknowledge ('yeah we do send it out') and REDIRECT by asking if they can make it live tomorrow. The goal is to get them to the live session. Must NOT just confirm the replay and leave it there. Must NOT redirect to the makeup date — the workshop is tomorrow and that's the right ask. Must NOT add any tokens yet.`,
    check: (r) => !r.cantMakeIt && !r.nextWeekSignup,
  },
  {
    id: "logistics-dont-remember",
    category: "Logistics",
    name: "Doesn't remember signing up",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["I don't really remember signing up for this"],
    rubric: "Should warmly re-engage on what the workshop covers (Big Three: career, love, confidence), skip logistics details, and end with something like 'does that ring a bell?' Should NOT just list the Zoom link and time.",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // OUT OF SCOPE / UNCERTAINTY
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "oos-flow-code-price",
    category: "Out of Scope",
    name: "CRITICAL: Flow Code pricing — must go silent",
    critical: true,
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["How much does The Flow Code cost?"],
    rubric: "TFC pricing is not in the bot's policy. Bot must go silent ([UNSURE]) — no reply sent, team follows up. Must NOT give a price, make one up, or send any message to the contact.",
    check: (r) => (r.unsure === true || r.blocked === true) && r.reply === null,
  },
  {
    id: "oos-coaching-details",
    category: "Out of Scope",
    name: "CRITICAL: TFC sign-up — must go silent",
    critical: true,
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["Can I sign up for the Flow Code after the workshop?"],
    rubric: "TFC sign-up is not in the bot's policy. Bot must go silent ([UNSURE]) — no reply sent, team follows up.",
    check: (r) => (r.unsure === true || r.blocked === true) && r.reply === null,
  },
  {
    id: "oos-attendance-numbers",
    category: "Out of Scope",
    critical: true,
    name: "CRITICAL: How many people on the call? — must go silent",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["How many people are usually on the call?"],
    rubric: "Attendance numbers are not in the bot's policy. Bot must go silent ([UNSURE]) — never fabricate a number, never send a guess to the contact.",
    check: (r) => (r.unsure === true || r.blocked === true) && r.reply === null,
  },
  {
    id: "logistics-join-late",
    category: "Logistics",
    name: "Joining late is fine",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["What happens if I join a few minutes late?"],
    rubric: "Policy says joining late is fine — just jump on when you can. Bot should be warm and reassuring. Must NOT fabricate specifics about what they'll miss or how the recording starts.",
  },
  {
    id: "oos-community",
    category: "Out of Scope",
    critical: true,
    name: "CRITICAL: Is there a community? — must go silent",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["Is there a Facebook group or community for people who attend?"],
    rubric: "Community/group info is not in the bot's policy. Bot must go silent ([UNSURE]) — must NOT claim a group exists or doesn't.",
    check: (r) => (r.unsure === true || r.blocked === true) && r.reply === null,
  },
  {
    id: "oos-how-long-jason",
    category: "Out of Scope",
    critical: true,
    name: "CRITICAL: How long has Jason done this? — must go silent",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: ["How long has Jason been doing these workshops?"],
    rubric: "Jason's history/bio is not in the bot's policy. Bot must go silent ([UNSURE]) — must NOT fabricate a timeline or backstory.",
    check: (r) => (r.unsure === true || r.blocked === true) && r.reply === null,
  },

  // ══════════════════════════════════════════════════════════════════════════
  // MULTI-TURN FULL CONVERSATIONS
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "multi-cant-make-it-then-yes",
    category: "Multi-turn",
    name: `Full: can't make it → confirms ${makeupDateLabel}`,
    seed: [],
    turns: [
      `hey I can't make it this ${workshopDay} unfortunately`,
      `yes, ${makeupDateLabel} works great!`,
    ],
    rubric: `Two-turn exchange. First response should ask warmly about ${makeupDateLabel} and add [CANT_MAKE_IT]. Second response (after they confirm) should confirm them warmly and add [NEXT_WEEK_SIGNUP].`,
    check: (r) => r.nextWeekSignup === true,
  },
  {
    id: "multi-voss-to-booking",
    category: "Multi-turn",
    name: "Full Voss track: survey 3 → all rounds → call accepted",
    seed: S.survey,
    turns: [
      "3",
      "I just feel like now isn't quite the right time",
      "I think I'm just scared of the commitment honestly",
      "yeah I'd actually be open to a quick call",
    ],
    rubric: "Full Voss track across 4 turns. Each step should follow the progression: calibrated question → deepen → offer call → booking link provided. Final response MUST include the booking link URL (leadconnectorhq.com/widget/bookings).",
    check: (r) => r.reply && r.reply.includes("leadconnectorhq.com"),
  },
  {
    id: "multi-driving-then-confirms",
    category: "Multi-turn",
    name: "Ambiguous (driving) → clarified → can make it",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: [
      "I'll be driving to Santa Barbara that day",
      "oh I'll be back by 8am so i should be good!",
    ],
    rubric: "First turn: bot asks a clarifying question (doesn't assume they can't attend). Second turn: they clarify they'll be back in time. Bot should respond warmly and confirm they're all set — should NOT pivot to next Saturday or replay.",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // MISSED WORKSHOP FLOWS
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "missed-wants-seat",
    category: "Missed Workshop",
    name: "Missed workshop → 'yes save me a seat'",
    seed: S.missedWorkshop,
    turns: ["yes please!"],
    rubric: `They said yes to the makeup workshop. Bot should confirm them warmly for ${makeupDateLabel} at 9am pt. Should NOT ask again if they want a seat — they already said yes.`,
    check: (r) => r.nextWeekSignup === true,
  },
  {
    id: "missed-not-sure",
    category: "Missed Workshop",
    name: "Missed workshop → 'not sure if I can make it'",
    seed: S.missedWorkshop,
    turns: ["I'm not sure if I can make it to that one either"],
    rubric: `They're unsure about the makeup date. Bot should be warm — mention the replay exists, point to webinar.saintsofflow.com for future dates. Must NOT push.`,
    check: (r) => r.cantMakeIt === true,
  },
  {
    id: "missed-cant-do-weekends",
    category: "Missed Workshop",
    name: "Missed workshop → can never do weekends",
    seed: S.missedWorkshop,
    turns: ["I work every weekend unfortunately so these are always hard for me"],
    rubric: `They can never do weekends. Warm reply, mention the replay, let them know we'll reach out if we ever run one during the week. Must NOT ask about the makeup date (it's likely a weekend too).`,
    check: (r) => r.neverWeekends === true && r.cantMakeIt === true,
  },
  {
    id: "missed-reinvite-yes",
    category: "Missed Workshop",
    name: "Re-invite ('2.0 edition') → they're in",
    seed: S.missedWorkshopReinvite,
    turns: ["yes I'll be there!"],
    rubric: `They confirmed for the re-invite workshop. Bot should respond warmly and confirm the time (${workshopDay} at 9am PST). Should NOT add [NEXT_WEEK_SIGNUP] here — they were already invited via the automation, this is just their confirmation reply.`,
    check: (r) => !r.nextWeekSignup,
  },
  {
    id: "missed-reinvite-question",
    category: "Missed Workshop",
    name: "Re-invite → they have a question first",
    seed: S.missedWorkshopReinvite,
    turns: ["Will the replay be available if I can't catch all of it?"],
    rubric: "They're asking about the replay before committing — it's a hypothetical, not a confirmed absence. Bot should confirm yes the replay exists, then redirect back to whether they're still planning to join live (e.g. 'are you still planning to join us?'). That redirect IS the live-is-better message. Should NOT immediately confirm them or add any signup tokens. Warm and informative. Score negatively only if: bot skips the redirect entirely, pushes hard, or adds a signup token.",
  },

  // ══════════════════════════════════════════════════════════════════════════
  // MULTI-TURN WITH REALISTIC SEED CONTEXT
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: "multi-morning-of-cant-make-it",
    category: "Multi-turn",
    name: "Morning-of check-in → can't make it → confirms makeup",
    mockNow: T.morningOf8am,
    seed: S.askingQuestions,
    turns: [
      "ugh I totally forgot I have something this morning, I won't be able to make it 😞",
      `yes! ${makeupDateLabel} works for me`,
    ],
    rubric: `Morning-of flow. First turn: bot acknowledges empathetically, adds [CANT_MAKE_IT], asks about ${makeupDateLabel}. Second turn: they confirm — bot responds warmly and adds [NEXT_WEEK_SIGNUP]. The token is what matters; the bot does NOT need to restate the date if it's already established.`,
    check: (r) => r.nextWeekSignup === true,
  },
  {
    id: "multi-preWorkshop-questions-then-done",
    category: "Multi-turn",
    name: "Day-before: asks time + Zoom, then all set",
    mockNow: T.dayBefore8pm,
    seed: S.preWorkshop,
    turns: [
      "What time does it start and where do I get the Zoom link?",
      "perfect, thank you!",
    ],
    rubric: `Two-turn pre-workshop Q&A. First turn: bot answers time (9am pt) and where to get the Zoom link (confirmation email, texted morning of). Second turn: they say thanks — bot wraps up warmly with a day-before sign-off ("see you tomorrow!"). Must NOT repeat all the logistics.`,
    check: (r) => r.reply && r.reply.toLowerCase().includes("tomorrow"),
  },

];

// ── LLM Scorer ────────────────────────────────────────────────────────────────

async function score(test, history, finalResponse) {
  const transcript = history
    .map((m) => `${m.role === "user" ? "REGISTRANT" : "BOT"}: ${m.content}`)
    .join("\n");

  const responseDesc = finalResponse.reply
    ? `Reply sent:\n"${finalResponse.reply}"`
    : finalResponse.dnd
    ? "No reply sent — DND applied (response.dnd = true)"
    : finalResponse.unsure
    ? "No reply sent — bot flagged [UNSURE], team alerted to follow up (response.unsure = true)"
    : finalResponse.blocked
    ? "No reply sent — blocked by validator"
    : `Response object: ${JSON.stringify(finalResponse)}`;

  // Use mocked dates when the test overrides them — scorer must match what the bot saw
  const fmt = (iso) => new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
  const effectiveWorkshopLabel = test.mockWorkshopISO ? fmt(test.mockWorkshopISO) : workshopDateLabel;
  const effectiveMakeupLabel   = test.mockMakeupISO   ? fmt(test.mockMakeupISO)   : makeupDateLabel;

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Scorer timed out after 30s")), 30000)
  );

  const result = await Promise.race([anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 300,
    system: `You score SMS bot responses for Saints of Flow, a coaching brand. Today is ${TODAY}.

WORKSHOP DATES (treat these as ground truth — do NOT second-guess them):
- Current workshop: ${effectiveWorkshopLabel}
- Make-up workshop: ${effectiveMakeupLabel}
- If the bot says "see you ${effectiveWorkshopLabel}" or "see you ${effectiveMakeupLabel}", that is CORRECT.
- If the test uses mockNow for time simulation, sign-off language is evaluated relative to that simulated time.

Return ONLY a JSON object:
{
  "score": <integer 1-10>,
  "pass": <true if score >= 7>,
  "issue": <string describing what failed, or null>,
  "note": <one sentence summary>
}

Score 7-10 only if the bot fully satisfied the rubric. Be strict — partial credit only if the main behavior was correct and only one minor thing was off.`,
    messages: [{
      role: "user",
      content: `TEST: ${test.name}\n\nFULL CONVERSATION:\n${transcript}\n\nBOT RESPONSE:\n${responseDesc}\n\nRUBRIC:\n${test.rubric}`,
    }],
  }), timeout]);

  try {
    const m = result.content[0].text.match(/\{[\s\S]*\}/);
    return JSON.parse(m[0]);
  } catch {
    return { score: 5, pass: false, issue: "Scorer failed to parse result", note: result.content[0].text.slice(0, 120) };
  }
}

// ── Single test runner ────────────────────────────────────────────────────────

async function runTest(test) {
  await reset();

  const seedMessages = test.seed || [];
  if (seedMessages.length) await seed(seedMessages);

  const history = [...seedMessages];
  let finalResponse;
  const allResponses = [];

  for (const message of test.turns) {
    history.push({ role: "user", content: message });
    const response = await chat(message, test.mockNow || null, test.mockMakeupISO || null, test.mockWorkshopISO || null);
    finalResponse = response;
    allResponses.push({ message, response });
    if (response.reply) {
      history.push({ role: "assistant", content: response.reply });
    }
  }

  // Programmatic check first
  if (test.check) {
    const passed = test.check(finalResponse);
    if (!passed) {
      return {
        ...test,
        passed: false,
        score: 1,
        issue: `Check failed. Final response: ${JSON.stringify(finalResponse)}`,
        note: "Programmatic assertion failed",
        autoChecked: true,
        history,
        finalResponse,
        allResponses,
      };
    }
    // If check passes and there's no reply to score, mark as pass
    if (finalResponse.reply === null) {
      return {
        ...test,
        passed: true,
        score: 10,
        issue: null,
        note: "Programmatic check passed",
        autoChecked: true,
        history,
        finalResponse,
        allResponses,
      };
    }
  }

  // LLM scoring
  const scoring = await score(test, history, finalResponse);
  return {
    ...test,
    passed: scoring.pass,
    score: scoring.score,
    issue: scoring.issue,
    note: scoring.note,
    autoChecked: false,
    history,
    finalResponse,
    allResponses,
  };
}

// ── HTML report generator ─────────────────────────────────────────────────────

function buildHtml(results) {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const critFailed = results.filter((r) => !r.passed && r.critical).length;
  const categories = [...new Set(results.map((r) => r.category))];

  const messageHtml = (role, content) => {
    const isBot = role === "assistant";
    const label = isBot ? "SOF BOT" : "REGISTRANT";
    const cls = isBot ? "bot" : "user";
    return `<div class="msg ${cls}"><div class="msg-label">${label}</div><div class="msg-bubble">${content.replace(/\n/g, "<br>")}</div></div>`;
  };

  const testHtml = (r) => {
    const icon = r.passed ? "✅" : "❌";
    const scoreStr = r.autoChecked ? "auto" : `${r.score}/10`;
    const critBadge = r.critical ? `<span class="badge crit">CRITICAL</span>` : "";
    const convHtml = r.history.map((m) => messageHtml(m.role, m.content)).join("");

    // Validator metadata from final response
    const fr = r.finalResponse || {};
    const validatorParts = [];
    if (fr.unsure) {
      validatorParts.push(`<span style="color:#8e44ad;font-weight:600">UNSURE</span> <span style="color:#888;font-size:11px">— bot flagged unknown, team alerted</span>`);
    } else if (fr.blocked) {
      validatorParts.push(`<span style="color:#c0392b;font-weight:600">BLOCKED</span>`);
    }
    const tokenParts = [];
    if (fr.cantMakeIt)    tokenParts.push(`<span class="token-badge">CANT_MAKE_IT</span>`);
    if (fr.nextWeekSignup) tokenParts.push(`<span class="token-badge">NEXT_WEEK_SIGNUP</span>`);
    if (fr.neverSaturdays) tokenParts.push(`<span class="token-badge">NEVER_SATURDAYS</span>`);
    if (fr.handoff)       tokenParts.push(`<span class="token-badge">HANDOFF</span>`);

    const metaRow = (validatorParts.length || tokenParts.length) ? `
    <div class="validator-meta">
      ${validatorParts.length ? `${validatorParts.join(" ")}` : ""}
      ${tokenParts.length ? `${validatorParts.length ? "&nbsp;&nbsp;" : ""}<span class="meta-label">Tokens:</span> ${tokenParts.join(" ")}` : ""}
    </div>` : "";

    return `
<div class="test ${r.passed ? "pass" : "fail"}" id="${r.id}">
  <div class="test-header">
    <span class="test-icon">${icon}</span>
    <span class="test-name">${r.name}</span>
    ${critBadge}
    <span class="test-score">${scoreStr}</span>
  </div>
  <div class="test-body">
    ${metaRow}
    <div class="section-label">Conversation</div>
    <div class="conversation">${convHtml}</div>
    <div class="section-label">Rubric</div>
    <div class="rubric">${r.rubric}</div>
    ${r.issue ? `<div class="section-label">Issue</div><div class="issue">${r.issue}</div>` : ""}
    ${r.note ? `<div class="section-label">Scorer note</div><div class="scorer-note">${r.note}</div>` : ""}
  </div>
</div>`;
  };

  const catSections = categories.map((cat) => {
    const catResults = results.filter((r) => r.category === cat);
    const catPassed = catResults.filter((r) => r.passed).length;
    const catFailed = catResults.length - catPassed;
    return `
<div class="category">
  <div class="cat-header">
    <span class="cat-name">${cat}</span>
    <span class="cat-score">${catPassed}/${catResults.length} passed${catFailed ? ` · <span class="fail-count">${catFailed} failed</span>` : ""}</span>
  </div>
  ${catResults.map(testHtml).join("")}
</div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>SOF Bot QA Report — ${TODAY}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f0e0c;--surface:#1a1916;--surface2:#222018;--border:#2a2825;--gold:#c9a84c;--gold-dim:#7a6330;--text:#e8e4dc;--text-dim:#7a7670;--green:#4caf74;--red:#e05555;--yellow:#d4a017;--radius:12px}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:0}
.top-bar{background:var(--surface);border-bottom:1px solid var(--border);padding:20px 32px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.top-bar-left{display:flex;align-items:center;gap:16px}
.logo{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--gold),#8a6020);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#0f0e0c}
.top-title{font-size:16px;font-weight:600}
.top-sub{font-size:12px;color:var(--text-dim);margin-top:1px}
.top-stats{display:flex;gap:24px;align-items:center}
.stat{text-align:center}
.stat-num{font-size:22px;font-weight:700;font-family:'DM Mono',monospace;line-height:1}
.stat-num.green{color:var(--green)}
.stat-num.red{color:var(--red)}
.stat-num.yellow{color:var(--yellow)}
.stat-label{font-size:10px;color:var(--text-dim);margin-top:2px;text-transform:uppercase;letter-spacing:.04em}
.sidebar{width:260px;position:fixed;top:77px;bottom:0;left:0;background:var(--surface);border-right:1px solid var(--border);overflow-y:auto;padding:16px 0}
.sidebar-section{padding:0 16px 8px}
.sidebar-label{font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em;padding:8px 8px 4px;font-family:'DM Mono',monospace}
.sidebar-item{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;font-size:13px;text-decoration:none;color:var(--text);transition:background .15s}
.sidebar-item:hover{background:rgba(201,168,76,.08)}
.sidebar-item .si-icon{font-size:11px;width:16px;text-align:center}
.sidebar-item .si-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sidebar-item .si-score{font-size:11px;color:var(--text-dim);font-family:'DM Mono',monospace}
.sidebar-item.fail .si-name{color:var(--red)}
.main{margin-left:260px;padding:28px 32px;max-width:900px}
.category{margin-bottom:40px}
.cat-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.cat-name{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--gold)}
.cat-score{font-size:12px;color:var(--text-dim)}
.fail-count{color:var(--red)}
.test{border:1px solid var(--border);border-radius:var(--radius);margin-bottom:16px;overflow:hidden}
.test.fail{border-color:rgba(224,85,85,.3)}
.test.pass{border-color:rgba(76,175,116,.15)}
.test-header{display:flex;align-items:center;gap:10px;padding:13px 16px;background:var(--surface2);cursor:pointer;user-select:none}
.test-header:hover{background:rgba(255,255,255,.02)}
.test-icon{font-size:14px;width:20px}
.test-name{flex:1;font-size:14px;font-weight:500}
.test-score{font-size:12px;color:var(--text-dim);font-family:'DM Mono',monospace}
.badge{font-size:10px;padding:2px 8px;border-radius:20px;font-weight:600;font-family:'DM Mono',monospace}
.badge.crit{background:rgba(212,160,23,.15);color:var(--yellow);border:1px solid rgba(212,160,23,.3)}
.test-body{display:none;padding:16px;border-top:1px solid var(--border);background:var(--bg)}
.test.open .test-body{display:block}
.section-label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);font-family:'DM Mono',monospace;margin-bottom:8px;margin-top:14px}
.section-label:first-child{margin-top:0}
.conversation{display:flex;flex-direction:column;gap:10px;margin-bottom:4px}
.msg{display:flex;flex-direction:column;max-width:72%}
.msg.user{align-self:flex-end;align-items:flex-end}
.msg.bot{align-self:flex-start;align-items:flex-start}
.msg-label{font-size:10px;color:var(--text-dim);margin-bottom:4px;font-family:'DM Mono',monospace}
.msg-bubble{padding:10px 14px;border-radius:12px;font-size:13.5px;line-height:1.5}
.msg.user .msg-bubble{background:var(--gold);color:#0f0e0c;font-weight:500;border-bottom-right-radius:3px}
.msg.bot .msg-bubble{background:var(--surface2);border:1px solid var(--border);border-bottom-left-radius:3px}
.rubric{font-size:13px;color:var(--text-dim);line-height:1.6;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 14px}
.issue{font-size:13px;color:var(--red);background:rgba(224,85,85,.08);border:1px solid rgba(224,85,85,.2);border-radius:8px;padding:10px 14px;line-height:1.5}
.scorer-note{font-size:13px;color:var(--text-dim);line-height:1.5}
.validator-meta{font-size:12px;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;margin-bottom:12px;display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.meta-label{font-family:'DM Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim)}
.token-badge{font-family:'DM Mono',monospace;font-size:10px;background:rgba(100,160,255,.1);border:1px solid rgba(100,160,255,.25);color:#7ab3ff;border-radius:4px;padding:2px 6px}
.raw-reply-row{font-size:12px;padding:8px 12px;background:rgba(212,160,23,.06);border:1px solid rgba(212,160,23,.2);border-radius:6px;margin-bottom:8px}
.raw-reply-text{color:var(--text);font-style:italic}
@media (max-width:720px){.sidebar{display:none}.main{margin-left:0;padding:16px}}
</style>
</head>
<body>
<div class="top-bar">
  <div class="top-bar-left">
    <div class="logo">SF</div>
    <div>
      <div class="top-title">SOF Bot QA Report</div>
      <div class="top-sub">${TODAY}</div>
    </div>
  </div>
  <div class="top-stats">
    <div class="stat"><div class="stat-num green">${passed}</div><div class="stat-label">Passed</div></div>
    <div class="stat"><div class="stat-num red">${failed}</div><div class="stat-label">Failed</div></div>
    ${critFailed ? `<div class="stat"><div class="stat-num yellow">${critFailed}</div><div class="stat-label">Critical failures</div></div>` : ""}
    <div class="stat"><div class="stat-num">${results.length}</div><div class="stat-label">Total</div></div>
  </div>
</div>
<div class="sidebar">
  <div class="sidebar-label">Jump to</div>
  ${categories.map((cat) => {
    const catResults = results.filter((r) => r.category === cat);
    const items = catResults.map((r) => `
      <a class="sidebar-item ${r.passed ? "" : "fail"}" onclick="openTest('${r.id}')">
        <span class="si-icon">${r.passed ? "✅" : "❌"}</span>
        <span class="si-name">${r.name}</span>
        <span class="si-score">${r.autoChecked ? "auto" : r.score + "/10"}</span>
      </a>`).join("");
    return `<div class="sidebar-section"><div class="sidebar-label">${cat}</div>${items}</div>`;
  }).join("")}
</div>
<div class="main">
  ${catSections}
</div>
<script>
function openTest(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("open");
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}
document.querySelectorAll(".test-header").forEach(h => {
  h.addEventListener("click", () => h.closest(".test").classList.toggle("open"));
});
// Auto-open all failures
document.querySelectorAll(".test.fail").forEach(el => el.classList.add("open"));
</script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const W = 72;
  const line = "═".repeat(W);
  const thin = "─".repeat(W);

  let tests = TESTS;
  if (FAILED_ONLY) {
    const sidecarPath = join(__dir, "qa-last-run.json");
    if (!existsSync(sidecarPath)) { console.error("No previous run found — run the full suite first."); process.exit(1); }
    const lastRun = JSON.parse(readFileSync(sidecarPath, "utf8"));
    if (!lastRun.failed.length) { console.log("No failures in last run — nothing to re-run. 🎉"); process.exit(0); }
    tests = TESTS.filter(t => lastRun.failed.includes(t.id));
    console.log(`  Re-running ${tests.length} failed test(s) from last run (${lastRun.date.slice(0,10)})`);
  } else if (FILTER) {
    const filterTerms = FILTER.split(",").map(f => f.trim().toLowerCase());
    tests = TESTS.filter(
      (t) => filterTerms.some(f =>
        t.id.toLowerCase().includes(f) ||
        t.category.toLowerCase().includes(f) ||
        t.name.toLowerCase().includes(f))
    );
    if (!tests.length) { console.error(`No tests match filter: ${FILTER}`); process.exit(1); }
  }
  if (EXCLUDE) {
    const excludeTerms = EXCLUDE.split(",").map(f => f.trim().toLowerCase());
    tests = tests.filter(
      (t) => !excludeTerms.some(f =>
        t.id.toLowerCase().includes(f) ||
        t.category.toLowerCase().includes(f) ||
        t.name.toLowerCase().includes(f))
    );
    if (!tests.length) { console.error(`All tests excluded by: ${EXCLUDE}`); process.exit(1); }
  }

  console.log(`\n${line}`);
  console.log(`  SOF BOT QA SUITE  ·  ${TODAY}`);
  console.log(line);
  console.log(`  Server: ${BOT_URL}`);
  const modeLabel = FILTER ? ` (filter: "${FILTER}")` : EXCLUDE ? ` (excluding: "${EXCLUDE}")` : "";
  console.log(`  Running: ${tests.length} test${tests.length === 1 ? "" : "s"}${modeLabel}`);
  console.log(`${line}\n`);

  // Verify server is up
  try {
    await fetch(`${BOT_URL}/`);
  } catch {
    console.error(`\n  ❌ Cannot reach ${BOT_URL} — is the server running?\n`);
    process.exit(1);
  }

  const results = [];
  const start = Date.now();

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    const prefix = `[${String(i + 1).padStart(2)}/${tests.length}]`;
    const critMark = test.critical ? " ⚑" : "";
    process.stdout.write(`${prefix} ${test.category} — ${test.name}${critMark}... `);

    try {
      const result = await runTest(test);
      results.push(result);
      const icon = result.passed ? "✅" : "❌";
      const scoreStr = result.autoChecked ? "(auto)" : `(${result.score}/10)`;
      console.log(`${icon} ${scoreStr}`);
      if (!result.passed) {
        const msg = result.issue || result.note || "";
        console.log(`       ↳ ${msg.slice(0, 100)}`);
      }
    } catch (err) {
      console.log(`💥 ERROR`);
      console.log(`       ↳ ${err.message}`);
      results.push({
        ...test,
        passed: false,
        score: 0,
        issue: err.message,
        note: "Test threw an exception",
        history: [],
        finalResponse: {},
        allResponses: [],
      });
    }

    // Brief pause between tests
    if (i < tests.length - 1) await new Promise((r) => setTimeout(r, 400));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const critFailed = results.filter((r) => !r.passed && r.critical).length;
  const llmResults = results.filter((r) => !r.autoChecked);
  const avgScore = llmResults.length
    ? (llmResults.reduce((s, r) => s + r.score, 0) / llmResults.length).toFixed(1)
    : "n/a";

  console.log(`\n${line}`);
  console.log(`  RESULTS  ·  ${elapsed}s`);
  console.log(thin);
  console.log(`  Passed ${passed}/${results.length}   Failed ${failed}   Avg LLM score ${avgScore}/10`);
  if (critFailed) console.log(`  ⚑  ${critFailed} CRITICAL failure${critFailed > 1 ? "s" : ""}`);
  console.log(thin);

  const byCategory = {};
  results.forEach((r) => { (byCategory[r.category] = byCategory[r.category] || []).push(r); });
  for (const [cat, items] of Object.entries(byCategory)) {
    const cp = items.filter((r) => r.passed).length;
    const cf = items.length - cp;
    const icon = cf === 0 ? "✅" : cp === 0 ? "❌" : "⚠️ ";
    console.log(`  ${icon}  ${cat}: ${cp}/${items.length}`);
  }

  if (failed > 0) {
    console.log(`\n${thin}`);
    console.log("  FAILURES\n");
    results.filter((r) => !r.passed).forEach((r) => {
      const crit = r.critical ? " [CRITICAL]" : "";
      console.log(`  ❌${crit} ${r.name}`);
      if (r.issue) console.log(`     ${r.issue.slice(0, 120)}`);
      console.log();
    });
  }

  // Save HTML report
  const reportPath = join(__dir, "qa-report.html");
  writeFileSync(reportPath, buildHtml(results));

  // Save sidecar JSON so --failed-only can pick up failures next run
  const sidecarPath = join(__dir, "qa-last-run.json");
  writeFileSync(sidecarPath, JSON.stringify({
    date: new Date().toISOString(),
    failed: results.filter(r => !r.passed).map(r => r.id),
    passed: results.filter(r => r.passed).map(r => r.id),
  }, null, 2));

  console.log(`${thin}`);
  console.log(`  📄 HTML report: tests/qa-report.html`);
  console.log(`${line}\n`);

  // Force-exit after a short drain window — Anthropic SDK keeps connections open
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300);
}

main().catch((err) => { console.error(err); process.exit(1); });
