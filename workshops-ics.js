/**
 * SOF Bot — subscribable workshop calendar
 * ─────────────────────────────────────────────────────────────────────────
 * Serves the workshop schedule as an .ics feed so Jason and the team can
 * subscribe once and stop tracking dates by hand. This is for the HOSTS, not
 * for registrants — attendees get their calendar entry from Zoom registration.
 *
 * METHOD:PUBLISH, not REQUEST: a subscribed feed is a read-only calendar, not
 * a set of invitations. Using REQUEST here would make Google treat each entry
 * as an invite needing an RSVP.
 *
 * SEQUENCE is driven by updated_at, so when a workshop moves, subscribers see
 * a genuinely newer version of the event rather than a duplicate.
 *
 * Caveat worth knowing: Google refreshes external feeds on its own schedule,
 * often 8-24 hours. A same-week time change may not reach the team quickly.
 * That's the argument for real Calendar API events, not a feed.
 */

const TZ = "America/Los_Angeles";
const TITLE = "The Big Three Mastery Workshop";
const DURATION_MIN = 120;

function stamp(date) {
  return new Date(date).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** RFC 5545 escaping: commas, semicolons and backslashes are structural. */
function esc(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Folds lines at 75 octets, as the spec requires — Google tolerates long
 *  lines, but Apple Calendar has historically not. */
function fold(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const out = [];
  let current = "";
  for (const char of line) {
    if (Buffer.byteLength(current + char) > 74) { out.push(current); current = " "; }
    current += char;
  }
  out.push(current);
  return out.join("\r\n");
}

export function buildFeed(rows, { now = new Date() } = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Saints of Flow//Workshop Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc("SOF Workshops")}`,
    `X-WR-TIMEZONE:${TZ}`,
    // Hints to the subscriber to re-fetch hourly. Google may ignore both.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const w of rows) {
    const start = new Date(w.starts_at);
    const end = new Date(start.getTime() + DURATION_MIN * 60_000);
    const summary = w.edition ? `${TITLE} #${w.edition}` : TITLE;
    const details = [
      w.zoom_link ? `Registration / join: ${w.zoom_link}` : "No Zoom room yet — add one at /schedule",
      w.note ? `Note: ${w.note}` : null,
      w.edition ? `Tag: the-big-three-webinar-v${w.edition}` : null,
    ].filter(Boolean).join("\n");

    lines.push(
      "BEGIN:VEVENT",
      // Stable per workshop row, so an edit updates the event instead of
      // creating a second one on everybody's calendar.
      `UID:sof-workshop-${w.id}@saintsofflow.com`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SEQUENCE:${w.updated_at ? Math.floor(new Date(w.updated_at).getTime() / 1000) : 0}`,
      fold(`SUMMARY:${esc(summary)}`),
      fold(`DESCRIPTION:${esc(details)}`),
      w.zoom_link ? fold(`LOCATION:${esc(w.zoom_link)}`) : null,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "BEGIN:VALARM",
      "TRIGGER:-PT30M",
      "ACTION:DISPLAY",
      fold(`DESCRIPTION:${esc(summary)} starts in 30 minutes`),
      "END:VALARM",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.filter(Boolean).join("\r\n") + "\r\n";
}
