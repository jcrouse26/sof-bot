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

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const TITLE = "The Big Three Mastery Workshop";
const DURATION_MIN = 120;
const HORIZON_DAYS = 90;

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
  if (!res.ok) throw new Error(`calendarList failed: ${res.status}`);
  return (body.items || []).map((c) => ({ id: c.id, name: c.summary, primary: !!c.primary }));
}

/** The event body for a workshop. Times are sent as wall-clock plus an explicit
 *  timeZone, so Google resolves DST rather than us pre-computing an offset. */
function eventFor(workshop, attendees) {
  const start = new Date(workshop.starts_at);
  const end = new Date(start.getTime() + DURATION_MIN * 60_000);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    summary: workshop.edition ? `${TITLE} #${workshop.edition}` : TITLE,
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
export async function syncEvents({ listWorkshops, setEventId, refreshToken, calendarId = "primary", attendees = [], notify = async () => {} } = {}) {
  if (!hasClient() || !refreshToken) {
    return { status: "skipped", detail: "Google Calendar not connected", changed: [] };
  }

  let rows;
  try {
    rows = await listWorkshops({ activeOnly: false });
  } catch (err) {
    return { status: "error", detail: `schedule read failed: ${err.message}`, changed: [] };
  }

  let token;
  try {
    token = await accessToken(refreshToken);
  } catch (err) {
    await notify(`🛑 *Google Calendar disconnected* — ${err.message}\nReconnect at /schedule.`);
    return { status: "error", detail: err.message, changed: [] };
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
        await fetch(`${API}/calendars/${cal}/events/${w.google_event_id}?sendUpdates=all`, {
          method: "DELETE", headers: { Authorization: `Bearer ${token}` },
        });
        await setEventId(w.id, null);
        changed.push({ id: w.id, action: "cancelled" });
        continue;
      }

      const body = eventFor(w, attendees);
      const url = hasEvent
        ? `${API}/calendars/${cal}/events/${w.google_event_id}?sendUpdates=all`
        : `${API}/calendars/${cal}/events?sendUpdates=all`;
      const res = await fetch(url, {
        method: hasEvent ? "PATCH" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // A 404 on PATCH means the event was deleted in the calendar UI. Drop the
      // stale id so the next pass recreates it rather than failing forever.
      if (hasEvent && res.status === 404) {
        await setEventId(w.id, null);
        changed.push({ id: w.id, action: "event missing, will recreate" });
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);

      const created = await res.json();
      if (!hasEvent) {
        await setEventId(w.id, created.id);
        changed.push({ id: w.id, action: "created", when: `${w.local_date} ${w.local_time}` });
      }
    } catch (err) {
      await notify(`🛑 *Google Calendar sync failed* for ${w.local_date}: ${err.message}`);
      return { status: "error", detail: err.message, changed };
    }
  }

  const created = changed.filter((c) => c.action === "created");
  if (created.length) {
    await notify(`📅 *Google Calendar updated* — ${created.length} workshop(s) added.`);
  }
  return { status: changed.length ? "changed" : "in-sync", detail: `${changed.length} change(s)`, changed };
}
