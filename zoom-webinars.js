/**
 * SOF Bot — Zoom webinar creation
 * ─────────────────────────────────────────────────────────────────────────
 * Creates the Zoom room for upcoming workshops so the GHL sync has something
 * to publish, closing the one manual step in the chain.
 *
 * Uses its OWN Server-to-Server OAuth app (ZOOM_WEBINAR_* vars), separate from
 * the recording pipeline's ZOOM_* credentials on sof-pipeline-automation. That
 * app is scoped to read recordings and nothing else; keeping them apart means
 * this can't widen the blast radius of a pipeline that already works.
 *
 * Inert unless ZOOM_AUTOCREATE="true" AND all four credential vars are set —
 * no calls, no errors, nothing created.
 *
 * IDEMPOTENCY: a room is created only when the row has neither a link nor an
 * id, and the id
 * is written back immediately. A crash between the Zoom call and the database
 * write would orphan one webinar in Zoom (harmless, unlinked) rather than
 * publish a wrong link — the safe direction to fail.
 */

const ZOOM_API = "https://api.zoom.us/v2";
const TZ = "America/Los_Angeles";

// Create rooms this far ahead. Long enough that the link is ready well before
// promotion starts, short enough that moving a date rarely strands a room.
const LEAD_DAYS = 21;

const TOPIC = "The Big Three Mastery Workshop";
const DURATION_MIN = 120;

/** Accepts true/TRUE/1/yes/on — a switch that only understands one spelling
 *  fails silently and looks identical to a variable that was never set. */
export function autoCreateRequested() {
  return ["true", "1", "yes", "on"].includes(String(process.env.ZOOM_AUTOCREATE ?? "").trim().toLowerCase());
}

/** Credentials present — independent of whether creation is switched on. */
export function hasCredentials() {
  return Boolean(
    process.env.ZOOM_WEBINAR_ACCOUNT_ID &&
    process.env.ZOOM_WEBINAR_CLIENT_ID &&
    process.env.ZOOM_WEBINAR_CLIENT_SECRET &&
    process.env.ZOOM_WEBINAR_HOST
  );
}

export function isConfigured() {
  // ZOOM_AUTOCREATE is a deliberate second switch. Credentials alone must not
  // start creating rooms: the first run would happily create one for a
  // workshop that already has a room people were emailed, and replace the link
  // under them. Set it to "true" only once the schedule's existing links are
  // in the database.
  return Boolean(autoCreateRequested() && hasCredentials());
}

let cachedToken = { value: null, expiresAt: 0 };

async function getToken() {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const creds = Buffer.from(
    `${process.env.ZOOM_WEBINAR_CLIENT_ID}:${process.env.ZOOM_WEBINAR_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${process.env.ZOOM_WEBINAR_ACCOUNT_ID}`,
    { method: "POST", headers: { Authorization: `Basic ${creds}` } }
  );
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`Zoom token failed: ${res.status} ${body.reason || body.error || ""}`.trim());
  }
  // Refresh a minute early rather than racing the expiry.
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cachedToken.value;
}

/** The scopes Zoom actually granted — used by the setup check, not the sync. */
export async function grantedScopes() {
  const creds = Buffer.from(
    `${process.env.ZOOM_WEBINAR_CLIENT_ID}:${process.env.ZOOM_WEBINAR_CLIENT_SECRET}`
  ).toString("base64");
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${process.env.ZOOM_WEBINAR_ACCOUNT_ID}`,
    { method: "POST", headers: { Authorization: `Basic ${creds}` } }
  );
  const body = await res.json();
  if (!res.ok) throw new Error(`Zoom token failed: ${res.status} ${body.reason || ""}`);
  return String(body.scope || "").split(" ").filter(Boolean).sort();
}

/**
 * Create one scheduled webinar.
 *
 * type 5          = scheduled webinar, not a meeting
 * approval_type 0 = registration required, auto-approved. Zoom collects each
 *                 attendee's name and email, which is what no-show detection
 *                 downstream depends on — without it Zoom's attendee report
 *                 can't be matched back to a GHL contact.
 *
 * PUBLISH registration_url, NOT join_url. With registration on, Zoom returns
 * both: join_url walks straight into the room and skips registration entirely,
 * which would silently defeat the setting. registration_url is the public page.
 */
export async function createWebinar(startsAt) {
  const token = await getToken();
  const res = await fetch(`${ZOOM_API}/users/${encodeURIComponent(process.env.ZOOM_WEBINAR_HOST)}/webinars`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: TOPIC,
      type: 5,
      start_time: startsAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
      duration: DURATION_MIN,
      timezone: TZ,
      settings: {
        host_video: true,
        panelists_video: true,
        practice_session: false,
        approval_type: 0,
        auto_recording: "cloud",
      },
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    // 400 with code 3000-ish usually means the host has no Webinars license.
    throw new Error(`Zoom create failed: ${res.status} ${body.message || ""}`.trim());
  }
  // start_url is a host credential — deliberately not returned or stored.
  //
  // Publish the short /w/{id} form rather than the long registration URL. Both
  // land on the same registration page (verified: /w/ 302s to it), but this one
  // goes out in SMS, where a 60-character URL is most of the message. It also
  // matches the format the team has been sending by hand for 45 webinars.
  //
  // Only safe while registration is required. Without it Zoom hands out /j/
  // links and /w/ has nothing to resolve to, so fall back rather than guess.
  const host = new URL(body.registration_url || body.join_url).host;
  const publicUrl = body.registration_url
    ? `https://${host}/w/${body.id}`
    : body.join_url;
  if (!publicUrl) throw new Error(`Zoom returned no usable URL for webinar ${body.id}`);
  return { id: String(body.id), joinUrl: publicUrl };
}

/**
 * Give every upcoming workshop inside the lead window a room, if it lacks one.
 * Never throws — a Zoom outage must leave the rest of the bot untouched, and
 * the GHL gate already handles "no link yet" correctly.
 */
export async function ensureRooms({ listWorkshops, updateWorkshop, notify = async () => {} } = {}) {
  if (!isConfigured()) {
    const why = autoCreateRequested() ? "ZOOM_WEBINAR_* not set" : "ZOOM_AUTOCREATE not enabled";
    return { status: "skipped", detail: why, created: [] };
  }

  let rows;
  try {
    rows = await listWorkshops({ activeOnly: true });
  } catch (err) {
    return { status: "error", detail: `schedule read failed: ${err.message}`, created: [] };
  }

  const horizon = Date.now() + LEAD_DAYS * 86_400_000;
  const needy = rows
    .map((r) => ({ ...r, startsAt: new Date(r.starts_at) }))
    // Skip anything that already has a room, by id OR by link. A row can have
    // a hand-made link and no id — that is the normal case for every workshop
    // booked before this existed, and creating a second room for it would
    // orphan the link already sent to registrants.
    .filter((r) => !r.zoom_webinar_id && !r.zoom_link && r.startsAt.getTime() > Date.now() && r.startsAt.getTime() <= horizon)
    .sort((a, b) => a.startsAt - b.startsAt);

  const created = [];
  for (const w of needy) {
    try {
      const room = await createWebinar(w.startsAt);
      await updateWorkshop(w.id, {
        zoomLink: room.joinUrl,
        zoomWebinarId: room.id,
        updatedBy: "zoom-auto",
      });
      created.push({ id: w.id, startsAt: w.startsAt.toISOString(), joinUrl: room.joinUrl });
      await notify(`🎥 *Zoom room created* for ${w.local_date} ${w.local_time} PT\n${room.joinUrl}`);
    } catch (err) {
      // Stop after the first failure: if the license or scope is wrong, every
      // remaining call fails the same way and would spam Slack.
      await notify(`🛑 *Zoom room creation failed* for ${w.local_date}: ${err.message}`);
      return { status: "error", detail: err.message, created };
    }
  }

  return { status: created.length ? "created" : "in-sync", detail: `${created.length} room(s) created`, created };
}

/**
 * Keep each existing room's start time matching the schedule.
 *
 * ensureRooms only ever CREATED rooms, so moving a date at /schedule left the
 * Zoom room behind: GHL and every email said the new time while Zoom told
 * registrants the old one. Nothing surfaced the disagreement, because both
 * systems were internally consistent.
 *
 * Runs on credentials alone, deliberately NOT behind ZOOM_AUTOCREATE — that
 * switch governs making new rooms. A room whose time is wrong is wrong whether
 * or not you want new ones created.
 *
 * Zoom emails registrants when a webinar moves, so a correction here reaches
 * the people who already signed up.
 */
export async function syncRoomTimes({ listWorkshops, notify = async () => {} } = {}) {
  if (!hasCredentials()) return { status: "skipped", detail: "ZOOM_WEBINAR_* not set", moved: [] };

  let rows;
  try {
    rows = await listWorkshops({ activeOnly: true });
  } catch (err) {
    return { status: "error", detail: `schedule read failed: ${err.message}`, moved: [] };
  }

  const upcoming = rows.filter((r) => r.zoom_webinar_id && new Date(r.starts_at).getTime() > Date.now());
  if (!upcoming.length) return { status: "in-sync", detail: "no upcoming rooms", moved: [] };

  const stamp = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
  let token;
  try {
    token = await getToken();
  } catch (err) {
    return { status: "error", detail: err.message, moved: [] };
  }

  const moved = [];
  for (const w of upcoming) {
    try {
      const res = await fetch(`${ZOOM_API}/webinars/${w.zoom_webinar_id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) continue;              // deleted in Zoom, or not visible — leave it alone
      const live = await res.json();
      const want = stamp(w.starts_at);
      if (live.start_time && stamp(live.start_time) === want) continue;

      const patch = await fetch(`${ZOOM_API}/webinars/${w.zoom_webinar_id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ start_time: want, timezone: TZ, duration: DURATION_MIN }),
      });
      if (!patch.ok) throw new Error(`HTTP ${patch.status}`);

      const pretty = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" });
      moved.push({ id: w.zoom_webinar_id, from: live.start_time, to: want });
      await notify(
        `🕒 *Zoom room moved* to match the schedule\n` +
        `${pretty(live.start_time)} → ${pretty(want)} PT\nZoom has emailed everyone already registered.`
      );
    } catch (err) {
      await notify(`🛑 *Could not move Zoom room* ${w.zoom_webinar_id}: ${err.message}`);
      return { status: "error", detail: err.message, moved };
    }
  }
  return { status: moved.length ? "moved" : "in-sync", detail: `${moved.length} room(s) moved`, moved };
}
