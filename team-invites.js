/**
 * SOF Bot — team calendar invites
 * ─────────────────────────────────────────────────────────────────────────
 * Emails the team a real calendar invitation per workshop, so it lands on
 * their calendars the way any meeting invite does. This is for the HOSTS —
 * attendees get theirs from Zoom registration.
 *
 * Chosen over both a subscribed .ics feed (Google refreshes those on its own
 * cadence, often 8-24h — useless when a workshop moves three days out) and the
 * Calendar API (needs an OAuth consent per calendar).
 *
 * METHOD:REQUEST with a UID stable per workshop row and a SEQUENCE that only
 * ever increases. That combination is what makes a second send *update* the
 * existing event instead of adding a duplicate — calendars ignore a re-send
 * whose SEQUENCE hasn't advanced. sof-ics-builder derives its UID from the
 * contact id instead, which is why this isn't just a call to that service.
 *
 * Sends when: a workshop has never been invited, or it changed since the last
 * invite (time moved, Zoom room added). Cancels when a workshop is switched
 * inactive. Inert unless TEAM_INVITE_EMAILS and the Gmail vars are all set.
 */

const TZ = "America/Los_Angeles";
const TITLE = "The Big Three Mastery Workshop";
const DURATION_MIN = 120;

// Don't invite the team to something that already happened — on first run this
// would otherwise mail an invite for every past workshop still in the table.
const HORIZON_DAYS = 60;

export function recipients() {
  return String(process.env.TEAM_INVITE_EMAILS || "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

export function isConfigured() {
  return Boolean(
    recipients().length &&
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN &&
    process.env.GMAIL_USER
  );
}

// ─── Gmail over REST ─────────────────────────────────────────────────────────
// Deliberately no googleapis dependency: this is two HTTP calls, and sof-bot's
// dependency list is currently three packages.

async function accessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`Gmail token failed: ${res.status} ${body.error_description || body.error || ""}`.trim());
  }
  return body.access_token;
}

async function sendRaw(mime) {
  const token = await accessToken();
  const raw = Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// ─── iCalendar ───────────────────────────────────────────────────────────────

function stamp(d) {
  return new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function esc(t) {
  return String(t ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

export function buildInvite(workshop, { method = "REQUEST", sequence = 0, organizer, to = [] } = {}) {
  const start = new Date(workshop.starts_at);
  const end = new Date(start.getTime() + DURATION_MIN * 60_000);
  const summary = workshop.edition ? `${TITLE} #${workshop.edition}` : TITLE;
  const description = [
    workshop.zoom_link ? `Zoom: ${workshop.zoom_link}` : "Zoom room not set yet.",
    workshop.note ? `Note: ${workshop.note}` : null,
    "Schedule: https://sof-bot-production.up.railway.app/schedule",
  ].filter(Boolean).join("\n");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Saints of Flow//Workshops//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:sof-workshop-${workshop.id}@saintsofflow.com`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SEQUENCE:${sequence}`,
    `SUMMARY:${esc(summary)}`,
    `DESCRIPTION:${esc(description)}`,
    workshop.zoom_link ? `LOCATION:${esc(workshop.zoom_link)}` : null,
    `ORGANIZER;CN=Jason Crouse:mailto:${organizer}`,
    ...to.map((e) => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${e}`),
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${esc(summary)} starts in 30 minutes`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
}

function buildMime({ from, to, subject, text, ics, method }) {
  const boundary = `sof_${Math.abs(hashCode(subject + to.join()))}`;
  return [
    `From: Jason Crouse <${from}>`,
    `To: ${to.join(", ")}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
    "",
    `--${boundary}`,
    // method= on the part is what makes Gmail render this as an invitation
    // with RSVP buttons rather than an attachment to download.
    `Content-Type: text/calendar; charset=UTF-8; method=${method}`,
    "Content-Transfer-Encoding: 7bit",
    "",
    ics,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Deterministic — Math.random would give the same email a new boundary on
 *  every retry, which makes duplicates harder to spot in a mail log. */
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function prettyWhen(startsAt) {
  const d = new Date(startsAt);
  const date = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: TZ });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
  return `${date} at ${time} PT`;
}

// ─── Reconcile ───────────────────────────────────────────────────────────────

/**
 * Send or refresh invites. Never throws.
 *
 * @param {function} opts.listWorkshops async ({activeOnly}) => rows
 * @param {function} opts.markInvited   async (id, sequence) => void
 */
export async function sendInvites({ listWorkshops, markInvited, notify = async () => {} } = {}) {
  if (!isConfigured()) {
    const why = recipients().length ? "GMAIL_* not set" : "TEAM_INVITE_EMAILS not set";
    return { status: "skipped", detail: why, sent: [] };
  }

  let rows;
  try {
    rows = await listWorkshops({ activeOnly: false });
  } catch (err) {
    return { status: "error", detail: `schedule read failed: ${err.message}`, sent: [] };
  }

  const from = process.env.GMAIL_USER;
  const to = recipients();
  const horizon = Date.now() + HORIZON_DAYS * 86_400_000;
  const sent = [];

  for (const w of rows) {
    const startsAt = new Date(w.starts_at).getTime();
    if (startsAt < Date.now() || startsAt > horizon) continue;

    const cancelling = w.active === false;
    // Changed since the last invite? updated_at moves on every edit.
    const changed = !w.invite_sent_at || new Date(w.updated_at) > new Date(w.invite_sent_at);
    if (!changed) continue;
    if (cancelling && !w.invite_sequence) continue;   // never invited, nothing to cancel

    const sequence = (w.invite_sequence ?? -1) + 1;
    const method = cancelling ? "CANCEL" : "REQUEST";
    const when = prettyWhen(w.starts_at);
    const label = w.edition ? `#${w.edition}` : "";

    try {
      const ics = buildInvite(w, { method, sequence, organizer: from, to });
      const isUpdate = sequence > 0 && !cancelling;
      const subject = cancelling
        ? `Cancelled: ${TITLE} ${label} — ${when}`
        : `${isUpdate ? "Updated: " : ""}${TITLE} ${label} — ${when}`;
      const text = cancelling
        ? `This workshop has been taken off the schedule.\n\n${when}`
        : `${when}\n\n${w.zoom_link ? `Zoom: ${w.zoom_link}\n\n` : "Zoom room not set yet.\n\n"}Schedule: https://sof-bot-production.up.railway.app/schedule`;

      await sendRaw(buildMime({ from, to, subject, text, ics, method }));
      await markInvited(w.id, sequence);
      sent.push({ id: w.id, method, sequence, when });
    } catch (err) {
      await notify(`🛑 *Team invite failed* for ${when}: ${err.message}`);
      return { status: "error", detail: err.message, sent };
    }
  }

  if (sent.length) {
    await notify(
      `📅 *Team calendar invites sent* (${to.length} recipients)\n` +
      sent.map((s) => `• ${s.method === "CANCEL" ? "Cancelled" : s.sequence > 0 ? "Updated" : "Invited"}: ${s.when}`).join("\n")
    );
  }
  return { status: sent.length ? "sent" : "in-sync", detail: `${sent.length} invite(s)`, sent };
}
