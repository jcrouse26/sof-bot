/**
 * SOF Bot — Google Calendar events
 * ─────────────────────────────────────────────────────────────────────────
 * Writes each workshop straight onto a Google Calendar and keeps it in step
 * with the schedule, the same way the Zoom rooms and GHL values already are.
 *
 * Why this exists alongside team-invites.js: emailed invitations work for
 * everyone EXCEPT the person sending them. Jason is the organizer, so Gmail
 * treats an invitation from his own account as something he already authored
 * and never adds it to his calendar. No amount of MIME tuning fixes that.
 * Writing the event through the API does, and Google then emails the other
 * attendees its own invitations — so when this is connected, the app stops
 * sending its own and there are no duplicates.
 *
 * Auth: the OAuth client already used for Gmail, re-consented with calendar
 * scope. The refresh token lives in app_settings rather than an env var, so
 * reconnecting is a click rather than a redeploy.
 */

const OAUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const TZ = "America/Los_Angeles";

import { createHash } from "node:crypto";
const hash = (v) => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const TITLE = "The Big Three Mastery Workshop";

/**
 * Deterministic event id, so creating the same workshop twice is impossible.
 *
 * Google lets the caller supply an id and returns 409 if it already exists,
 * which turns "create" into an idempotent operation. Without it, two sync
 * passes overlapping — the 60s tick and a route-triggered run, say — both read
 * google_event_id as null and both insert, and the calendar ends up with two
 * of everything. That is exactly what happened.
 *
 * Ids must be base32hex: digits and a-v only, so no "w", "x", "y" or "z".
 */
export function eventIdFor(workshopId) {
  return `sofevt${workshopId}`;
}
const DURATION_MIN = 120;
const HORIZON_DAYS = 90;

/**
 * Guest notifications are OFF unless explicitly switched on.
 *
 * On 2026-08-20 this loop PATCHed all 25 events every 60 seconds with
 * sendUpdates=all, and Google emailed the guest list on every pass — hundreds
 * of messages to Emily before it was caught. Attendees added with
 * sendUpdates=none still get the event on their calendar; they just are not
 * mailed about it. That is the right default, because the cost of getting this
 * wrong again is a quiet calendar update rather than a flooded inbox.
 */
function notifyMode(explicit) {
  return process.env.CALENDAR_NOTIFY_GUESTS === "true" && explicit ? "all" : "none";
}

export function hasClient() {
  return Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
}

export function authUrl(redirectUri, state = "") {
  const p = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    // offline + consent so Google actually returns a refresh token; without
    // prompt=consent a repeat authorisation silently returns none.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${OAUTH}?${p}`;
}

export async function exchangeCode(code, redirectUri) {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.refresh_token) {
    throw new Error(`Google token exchange failed: ${body.error_description || body.error || res.status}`);
  }
  return body.refresh_token;
}

async function accessToken(refreshToken) {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`Google refresh failed: ${body.error_description || body.error || res.status}`);
  }
  return body.access_token;
}

export async function listCalendars(refreshToken) {
  const token = await accessToken(refreshToken);
  const res = await fetch(`${API}/users/me/calendarList?minAccessRole=writer`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  // Carry Google's own message through — "Google Calendar API has not been
  // used in project X before or it is disabled" is the whole diagnosis, and
  // a bare status code throws that away.
  if (!res.ok) throw new Error(`calendarList ${res.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 200)}`);
  return (body.items || []).map((c) => ({ id: c.id, name: c.summary, primary: !!c.primary }));
}

/** The event body for a workshop. Times are sent as wall-clock plus an explicit
 *  timeZone, so Google resolves DST rather than us pre-computing an offset. */
function eventFor(workshop, attendees) {
  const start = new Date(workshop.starts_at);
  const end = new Date(start.getTime() + DURATION_MIN * 60_000);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    // No edition number in the title. Editions re-sequence whenever a date is
    // added or cancelled, so carrying one here meant a single cancellation
    // re-titled every later event — churn on three calendars for a number
    // nobody reads there. The number still matters where it is load-bearing:
    // the GHL registration tag.
    summary: TITLE,
    description: [
      workshop.zoom_link ? `Zoom: ${workshop.zoom_link}` : "Zoom room not set yet.",
      workshop.note ? `Note: ${workshop.note}` : null,
      "Schedule: https://sof-bot-production.up.railway.app/schedule",
    ].filter(Boolean).join("\n"),
    location: workshop.zoom_link || "",
    start: { dateTime: iso(start), timeZone: TZ },
    end: { dateTime: iso(end), timeZone: TZ },
    attendees: attendees.map((e) => ({ email: e })),
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
  };
}

/**
 * Create or update the event for each upcoming workshop; cancel deactivated
 * ones. Never throws.
 */
let lastState = { at: null, status: "never run", detail: null };
export function getStatus() { return lastState; }

export async function syncEvents({ listWorkshops, setEventId, refreshToken, calendarId = "primary", attendees = [], notify = async () => {} } = {}) {
  const finish = (status, detail, extra = {}) => {
    lastState = { at: new Date().toISOString(), status, detail };
    return { status, detail, changed: [], ...extra };
  };
  if (!hasClient() || !refreshToken) return finish("skipped", "Google Calendar not connected");

  let rows;
  try {
    rows = await listWorkshops({ activeOnly: false });
  } catch (err) {
    return finish("error", `schedule read failed: ${err.message}`);
  }

  let token;
  try {
    token = await accessToken(refreshToken);
  } catch (err) {
    await notify(`🛑 *Google Calendar disconnected* — ${err.message}\nReconnect at /schedule.`);
    return finish("error", err.message);
  }

  const horizon = Date.now() + HORIZON_DAYS * 86_400_000;
  const changed = [];
  const cal = encodeURIComponent(calendarId);

  for (const w of rows) {
    const startsAt = new Date(w.starts_at).getTime();
    if (startsAt < Date.now() || startsAt > horizon) continue;

    const wantsEvent = w.active !== false;
    const hasEvent = Boolean(w.google_event_id);
    if (!wantsEvent && !hasEvent) continue;

    try {
      if (!wantsEvent && hasEvent) {
        await fetch(`${API}/calendars/${cal}/events/${w.google_event_id}?sendUpdates=${notifyMode(true)}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${token}` },
        });
        await setEventId(w.id, null);
        changed.push({ id: w.id, action: "cancelled" });
        continue;
      }

      const wanted = eventIdFor(w.id);
      const body = eventFor(w, attendees);

      // Two fingerprints: the whole event, and just the parts a guest would
      // want an email about. Without this the loop PATCHed all 25 events every
      // 60 seconds forever.
      const guestFacing = { start: body.start, end: body.end, location: body.location, attendees: body.attendees };
      const sig = hash(body) + "." + hash(guestFacing);
      if (hasEvent && w.google_event_sig === sig) continue;
      const guestsCare = !w.google_event_sig || w.google_event_sig.split(".")[1] !== hash(guestFacing);
      const sendUpdates = notifyMode(guestsCare);
      const url = hasEvent
        ? `${API}/calendars/${cal}/events/${w.google_event_id}?sendUpdates=${sendUpdates}`
        : `${API}/calendars/${cal}/events?sendUpdates=${notifyMode(true)}`;
      const res = await fetch(url, {
        method: hasEvent ? "PATCH" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(hasEvent ? body : { ...body, id: wanted }),
      });

      // 409 means this workshop's event already exists — another pass won the
      // race, or it is left over from before. Adopt it instead of inserting.
      if (!hasEvent && res.status === 409) {
        await setEventId(w.id, wanted, sig);
        changed.push({ id: w.id, action: "adopted existing event" });
        continue;
      }

      // A 404 on PATCH means the event was deleted in the calendar UI. Drop the
      // stale id so the next pass recreates it rather than failing forever.
      if (hasEvent && res.status === 404) {
        await setEventId(w.id, null);
        changed.push({ id: w.id, action: "event missing, will recreate" });
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);

      const created = await res.json();
      await setEventId(w.id, hasEvent ? w.google_event_id : (created.id || wanted), sig);
      changed.push({
        id: w.id,
        action: hasEvent ? (guestsCare ? "updated (guests notified)" : "updated quietly") : "created",
        when: `${w.local_date} ${w.local_time}`,
      });
    } catch (err) {
      await notify(`🛑 *Google Calendar sync failed* for ${w.local_date}: ${err.message}`);
      return finish("error", err.message, { changed });
    }
  }

  const created = changed.filter((c) => c.action === "created");
  if (created.length) {
    await notify(`📅 *Google Calendar updated* — ${created.length} workshop(s) added.`);
  }
  return finish(changed.length ? "changed" : "in-sync", `${changed.length} change(s)`, { changed });
}

/**
 * One-shot repair: remove every workshop event this app has put on the
 * calendar, so the next sync recreates exactly one per workshop under a
 * deterministic id.
 *
 * Matching is deliberately narrow — the summary must start with the workshop
 * title AND the start time must be one the schedule actually holds. A stray
 * meeting that merely mentions the workshop is left alone.
 *
 * Deletes are sent with sendUpdates=none: guests already received invitations
 * for these, and a cancellation storm followed by a re-invitation storm is a
 * worse experience than the duplicates being repaired.
 */
export async function purgeWorkshopEvents({ listWorkshops, clearEventIds, refreshToken, calendarId = "primary", dryRun = false } = {}) {
  if (!hasClient() || !refreshToken) return { status: "skipped", detail: "not connected", removed: 0 };

  const rows = await listWorkshops({ activeOnly: false });
  const scheduleStarts = new Set(rows.map((w) => new Date(w.starts_at).getTime()));
  const token = await accessToken(refreshToken);
  const cal = encodeURIComponent(calendarId);

  const timeMin = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const timeMax = new Date(Date.now() + HORIZON_DAYS * 86_400_000).toISOString();

  const matches = [];
  let pageToken = "";
  do {
    const url = `${API}/calendars/${cal}/events?singleEvents=true&maxResults=250` +
      `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
      (pageToken ? `&pageToken=${pageToken}` : "");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    if (!res.ok) throw new Error(`events.list ${res.status}: ${body?.error?.message || ""}`);
    for (const ev of body.items || []) {
      if (!String(ev.summary || "").startsWith(TITLE)) continue;
      const startsAt = new Date(ev.start?.dateTime || ev.start?.date || 0).getTime();
      if (!scheduleStarts.has(startsAt)) continue;
      matches.push({ id: ev.id, summary: ev.summary, start: ev.start?.dateTime });
    }
    pageToken = body.nextPageToken || "";
  } while (pageToken);

  if (dryRun) return { status: "dry-run", detail: `${matches.length} event(s) would be removed`, removed: 0, matches };

  let removed = 0;
  for (const ev of matches) {
    const res = await fetch(`${API}/calendars/${cal}/events/${ev.id}?sendUpdates=none`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok || res.status === 410) removed++;   // 410 = already gone
  }
  await clearEventIds();
  return { status: "purged", detail: `${removed} event(s) removed`, removed };
}
