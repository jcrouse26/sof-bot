/**
 * SOF Bot — GHL custom-value sync
 * ─────────────────────────────────────────────────────────────────────────
 * Keeps the webinar custom values in GHL pointed at the next workshop.
 *
 * This is a RECONCILER, not a scheduled job. On every tick it asks one
 * question — "given the time right now, what should these values say?" — and
 * writes only the ones that differ. That makes it safe across Railway
 * restarts, safe if a tick is missed, and self-healing if someone edits a
 * value by hand in GHL or moves a date on the /schedule page.
 *
 * THE ZOOM GATE
 * The Zoom room is created by hand, so it cannot be derived from a date. If
 * the next workshop has no zoom_link, we publish NOTHING — flipping the date
 * while leaving the previous webinar's Zoom link in place would send people
 * to a dead room, which is worse than a stale date. Instead we hold the old
 * values and raise a Slack alert.
 *
 * All five values move together or not at all. Two of them (the calendar link
 * and the Zoom link itself) embed the room URL, so a partial write is exactly
 * the broken state the gate exists to prevent.
 */

const API = "https://services.leadconnectorhq.com";
const TZ = "America/Los_Angeles";
const ET = "America/New_York";

const WEBINAR_TITLE = "The Big Three Mastery Workshop";
const WEBINAR_DETAILS =
  "Learn how to master the big three in life: career, love, and confidence\n\n" +
  "Join the workshop live:\n";

// Matches the 2-hour block the existing calendar links already use. The
// workshop itself runs 75-90 minutes; the extra padding is deliberate.
const DURATION_MIN = 120;

// How long after a webinar starts before the values roll to the next one.
// Deliberately NOT the same as the SMS bot's 24-hour rule (getWorkshopDate in
// server.js) — the bot needs to keep answering "was that this morning?" long
// after the marketing pages should have moved on.
const CUTOVER_MIN = 90;

// Warn this far ahead if the next workshop still has no Zoom room.
const ZOOM_WARN_HOURS = 48;

// The GHL fields this owns, keyed by fieldKey so a rename in the UI surfaces
// as a loud "field not found" rather than a silent write to the wrong place.
const FIELDS = ["webinar_date", "webinar_time", "custom_zoom_webinar_link", "webinar_google_add_to_calendar_link", "webinar_internal_date_time"];

// Feeds the "Set Webinar Event Start Date & Time" action in the reminder
// workflows, which accepts a custom field but only in its own date format —
// so it can't reuse webinar_internal_date_time. Kept OPTIONAL: until someone
// creates it in GHL the rest of the sync carries on as normal, rather than
// aborting every pass over a field that isn't there yet.
// Also optional, and additionally conditional on the workshop having an
// edition number — see desiredValues.
const OPTIONAL_FIELDS = ["webinar_event_start", "webinar_tag"];

// the-big-three-webinar-v45
const TAG_PREFIX = "the-big-three-webinar-v";

// ─── Formatting ──────────────────────────────────────────────────────────────
// Every string below is reproduced from what is already live in GHL. These
// render straight into member-facing emails, so "close enough" is not enough:
// the date carries an ordinal suffix and the time is dual-timezone, neither of
// which any stock date formatter produces.

function partsIn(date, tz, opts) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).formatToParts(date);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

function ordinalSuffix(day) {
  const n = Number(day);
  if (n >= 11 && n <= 13) return "th";
  return { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
}

/** "Wednesday, August 19th" */
export function formatDate(date) {
  const p = partsIn(date, TZ, { weekday: "long", month: "long", day: "numeric" });
  return `${p.weekday}, ${p.month} ${p.day}${ordinalSuffix(p.day)}`;
}

/** "4pm" / "9:30am" — the :00 is dropped on the hour, as in the live values. */
function shortClock(date, tz) {
  const p = partsIn(date, tz, { hour: "numeric", minute: "2-digit", hour12: true });
  const period = p.dayPeriod.toLowerCase().replace(/[\s.]/g, "");
  return p.minute === "00" ? `${p.hour}${period}` : `${p.hour}:${p.minute}${period}`;
}

/** "4pm PT / 7pm ET" — both zones derived from the same instant, so DST is
 *  handled on both coasts independently and the offset between them is never
 *  assumed to be three hours. */
export function formatTime(date) {
  return `${shortClock(date, TZ)} PT / ${shortClock(date, ET)} ET`;
}

/** "2026-08-19 4:00pm" — minutes always shown here, unlike the display time. */
export function formatInternal(date) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
  const p = partsIn(date, TZ, { hour: "numeric", minute: "2-digit", hour12: true });
  return `${ymd} ${p.hour}:${p.minute}${p.dayPeriod.toLowerCase().replace(/[\s.]/g, "")}`;
}

/**
 * "19-AUG-2026 04:00 PM" — feeds GHL's Set Event Start Date action.
 *
 * That action accepts two formats. This uses DD-MMM-YYYY rather than
 * MM-DD-YYYY because an alphabetic month cannot be misread: with the numeric
 * form, a Saturday webinar on 09-05-2026 parses as September 5th or May 9th
 * depending on which way the parser leans, and both are plausible dates that
 * would silently send every reminder months out. "05-SEP-2026" has no such
 * reading. The cost is nothing; the failure it avoids is invisible.
 *
 * 12-hour with a meridiem, matching GHL's own examples (08:30 AM) — the
 * "HH:MM" in their hint notwithstanding.
 */
export function formatEventStart(date) {
  const p = partsIn(date, TZ, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
  const meridiem = p.dayPeriod.toUpperCase().replace(/[\s.]/g, "");
  return `${p.day}-${p.month.toUpperCase()}-${p.year} ${p.hour.padStart(2, "0")}:${p.minute} ${meridiem}`;
}

/** "20260819T230000Z" */
function stampUTC(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Google's "add to calendar" URL, rebuilt from the workshop.
 *
 * Encoded with URLSearchParams rather than encodeURIComponent so spaces come
 * out as "+" — matching the links already in GHL byte for byte, which keeps a
 * diff of old-vs-new readable when something looks wrong.
 */
export function formatCalendarLink(date, zoomLink) {
  const enc = (s) => new URLSearchParams({ v: s }).toString().slice(2);
  const end = new Date(date.getTime() + DURATION_MIN * 60_000);
  return (
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    `&text=${enc(WEBINAR_TITLE)}` +
    `&dates=${stampUTC(date)}/${stampUTC(end)}` +
    `&details=${enc(WEBINAR_DETAILS + zoomLink)}` +
    `&location=${enc(zoomLink)}`
  );
}

/** The full set of values a given workshop should produce. */
export function desiredValues(startsAt, zoomLink, edition = null) {
  const values = {
    webinar_date: formatDate(startsAt),
    webinar_time: formatTime(startsAt),
    custom_zoom_webinar_link: zoomLink,
    webinar_google_add_to_calendar_link: formatCalendarLink(startsAt, zoomLink),
    webinar_internal_date_time: formatInternal(startsAt),
    webinar_event_start: formatEventStart(startsAt),
  };
  // No edition, no tag. A tag is applied to real contacts and read back by a
  // workflow trigger, so publishing a guessed or blank one would mis-segment
  // people in a way that is tedious to unpick — better to leave the previous
  // tag in place and say so.
  if (Number.isInteger(edition)) values.webinar_tag = `${TAG_PREFIX}${edition}`;
  return values;
}

// ─── GHL client ──────────────────────────────────────────────────────────────

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
  };
}

function isConfigured() {
  return Boolean(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID);
}

/** Every custom value on the location, indexed by fieldKey. */
async function fetchCustomValues() {
  const res = await fetch(`${API}/locations/${process.env.GHL_LOCATION_ID}/customValues`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`GHL customValues read failed: ${res.status}`);
  const body = await res.json();
  const list = body.customValues || [];
  const byKey = {};
  for (const cv of list) {
    // fieldKey arrives as "{{ custom_values.webinar_date }}"
    const key = String(cv.fieldKey || "").replace(/[{}\s]/g, "").replace(/^custom_values\./, "");
    if (key) byKey[key] = { id: cv.id, name: cv.name, value: cv.value ?? "" };
  }
  return byKey;
}

/** The update endpoint takes name as well as value — send the existing name
 *  back untouched, or the write silently renames the field. */
async function putCustomValue(id, name, value) {
  const res = await fetch(
    `${API}/locations/${process.env.GHL_LOCATION_ID}/customValues/${id}`,
    { method: "PUT", headers: headers(), body: JSON.stringify({ name, value }) }
  );
  if (!res.ok) throw new Error(`GHL write failed for "${name}": ${res.status}`);
}

// ─── Reconcile ───────────────────────────────────────────────────────────────

/**
 * The workshop the custom values should currently describe: the first active
 * one that hasn't yet passed its cutover. Reads the same rows the admin page
 * writes, so an edit at /schedule is picked up on the next tick.
 */
export function selectWorkshop(rows, now = new Date()) {
  const cutoff = now.getTime() - CUTOVER_MIN * 60_000;
  return rows
    .filter((r) => r.active !== false)
    .map((r) => ({ ...r, startsAt: new Date(r.starts_at) }))
    .sort((a, b) => a.startsAt - b.startsAt)
    .find((r) => r.startsAt.getTime() > cutoff) || null;
}

let lastState = { at: null, status: "never run", detail: null, workshop: null, changed: [] };

export function getStatus() {
  return lastState;
}

/**
 * One reconcile pass. Never throws — a GHL outage must not take the bot down
 * or stop it answering texts.
 *
 * @param {object} opts.listWorkshops  async () => rows
 * @param {function} opts.notify       async (text) => void   (Slack)
 * @param {boolean} opts.dryRun        compute and report, write nothing
 */
export async function reconcile({ listWorkshops, notify = async () => {}, dryRun = false } = {}) {
  const finish = (status, detail, extra = {}) => {
    const state = { at: new Date().toISOString(), status, detail, workshop: null, changed: [], ...extra };
    // A dry run must not clobber the record of the last real pass — that record
    // is what you look at when something published wrongly.
    if (!dryRun) lastState = state;
    return state;
  };

  if (!isConfigured()) return finish("skipped", "GHL_API_KEY or GHL_LOCATION_ID not set");

  let workshop;
  try {
    workshop = selectWorkshop(await listWorkshops({ activeOnly: true }));
  } catch (err) {
    return finish("error", `schedule read failed: ${err.message}`);
  }
  if (!workshop) return finish("skipped", "no upcoming workshop on the schedule");

  const label = `${formatDate(workshop.startsAt)} at ${formatTime(workshop.startsAt)}`;

  // The gate. No room, no publish.
  if (!workshop.zoom_link) {
    const hoursOut = (workshop.startsAt - Date.now()) / 3_600_000;
    if (hoursOut <= ZOOM_WARN_HOURS) {
      await notify(
        `⚠️ *Webinar sync held* — ${label} is ${Math.max(0, Math.round(hoursOut))}h away and has no Zoom link yet.\n` +
        `GHL still shows the previous webinar. Add the link at /schedule and it publishes within a minute.`
      );
    }
    return finish("held", "next workshop has no zoom_link", { workshop: label });
  }

  let current;
  try {
    current = await fetchCustomValues();
  } catch (err) {
    return finish("error", err.message, { workshop: label });
  }

  const missing = FIELDS.filter((k) => !current[k]);
  if (missing.length) {
    // A rename in the GHL UI lands here. Writing the rest would leave the set
    // inconsistent, so refuse the whole pass and say which field moved.
    await notify(`🛑 *Webinar sync aborted* — custom value(s) not found in GHL: ${missing.join(", ")}`);
    return finish("error", `custom values not found: ${missing.join(", ")}`, { workshop: label });
  }

  const desired = desiredValues(workshop.startsAt, workshop.zoom_link, workshop.edition);

  // Optional fields join the set only once they exist in GHL *and* this
  // workshop can produce a value for them.
  const active = [...FIELDS, ...OPTIONAL_FIELDS.filter((k) => current[k] && desired[k] !== undefined)];

  if (current.webinar_tag && !Number.isInteger(workshop.edition)) {
    await notify(`⚠️ *Webinar tag not updated* — ${label} has no edition number set. Add it at /schedule; the other values published normally.`);
  }

  const changed = active.filter((k) => current[k].value !== desired[k]);
  if (!changed.length) return finish("in-sync", "all values already correct", { workshop: label });

  if (dryRun) return finish("dry-run", `${changed.length} value(s) would change`, { workshop: label, changed });

  try {
    for (const key of changed) {
      await putCustomValue(current[key].id, current[key].name, desired[key]);
    }
  } catch (err) {
    // Partial write: some fields moved, some didn't. Say so loudly — the next
    // tick will finish the job, but someone should know it happened.
    await notify(`🛑 *Webinar sync failed mid-write* — ${err.message}\nSome values may be inconsistent; next tick will retry.`);
    return finish("error", err.message, { workshop: label, changed });
  }

  await notify(
    `✅ *Webinar values updated* → ${label}\n` +
    changed.map((k) => `• \`${k}\`: ${current[k].value || "(empty)"} → ${desired[k]}`).join("\n")
  );
  return finish("updated", `${changed.length} value(s) written`, { workshop: label, changed });
}
