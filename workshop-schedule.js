/**
 * SOF Workshop Schedule — SEED / FALLBACK ONLY
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️  THIS FILE IS NO LONGER WHERE YOU EDIT THE SCHEDULE.
 *     Edit it at  https://sof-bot-production.up.railway.app/schedule
 *
 * The live schedule lives in the `workshops` table on the sof-bot Postgres.
 * This array is used in exactly two situations:
 *   1. First boot against an empty table — it seeds the database.
 *   2. Total database outage — the bot serves these dates rather than nothing.
 *
 * Changing a date here will NOT change what the bot says once the table has
 * rows. See schedule-store.js for the degradation ladder.
 *
 * Format: ISO 8601 with explicit UTC offset
 *   PDT (Mar 2nd Sun → Nov 1st Sun): -07:00
 *   PST (Nov 1st Sun → Mar 2nd Sun): -08:00
 * (The admin page stores Pacific wall-clock instead, so DST is handled for you
 *  there — this manual-offset format only survives here for the seed path.)
 */

export const WORKSHOP_SCHEDULE = [
  // ── June 2026 ─────────────────────────────────────────────────────────
  "2026-06-21T09:00:00-07:00",  // Sunday June 21  ← current (exception)
  "2026-06-27T09:00:00-07:00",  // Saturday June 27

  // ── July 2026 ─────────────────────────────────────────────────────────
  "2026-07-05T10:00:00-07:00",  // Sunday July 5 (exception — 10am PT)
  "2026-07-11T09:00:00-07:00",  // Saturday July 11
  "2026-07-19T09:00:00-07:00",  // Sunday July 19 (exception)
  "2026-07-22T16:00:00-07:00",  // Wednesday July 22 (exception — 4pm PT)
  "2026-07-25T09:00:00-07:00",  // Saturday July 25

  // ── August 2026 ───────────────────────────────────────────────────────
  "2026-08-01T09:00:00-07:00",  // Saturday August 1
  "2026-08-08T09:00:00-07:00",  // Saturday August 8
  "2026-08-15T09:00:00-07:00",  // Saturday August 15
  "2026-08-22T09:00:00-07:00",  // Saturday August 22
  "2026-08-29T09:00:00-07:00",  // Saturday August 29

  // ── September 2026 ────────────────────────────────────────────────────
  "2026-09-05T09:00:00-07:00",  // Saturday September 5
  "2026-09-12T09:00:00-07:00",  // Saturday September 12
  "2026-09-19T09:00:00-07:00",  // Saturday September 19
  "2026-09-26T09:00:00-07:00",  // Saturday September 26

  // ── October 2026 ──────────────────────────────────────────────────────
  "2026-10-03T09:00:00-07:00",  // Saturday October 3
  "2026-10-10T09:00:00-07:00",  // Saturday October 10
  "2026-10-17T09:00:00-07:00",  // Saturday October 17
  "2026-10-24T09:00:00-07:00",  // Saturday October 24
  "2026-10-31T09:00:00-07:00",  // Saturday October 31

  // ── November 2026 — DST ends Nov 1 at 2am → switch to PST (-08:00) ───
  "2026-11-07T09:00:00-08:00",  // Saturday November 7
  "2026-11-14T09:00:00-08:00",  // Saturday November 14
  "2026-11-21T09:00:00-08:00",  // Saturday November 21
  "2026-11-28T09:00:00-08:00",  // Saturday November 28

  // ── December 2026 ─────────────────────────────────────────────────────
  "2026-12-05T09:00:00-08:00",  // Saturday December 5
  "2026-12-12T09:00:00-08:00",  // Saturday December 12
  "2026-12-19T09:00:00-08:00",  // Saturday December 19
  "2026-12-26T09:00:00-08:00",  // Saturday December 26
];
