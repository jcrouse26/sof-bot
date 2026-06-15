/**
 * SOF Workshop Schedule
 * ─────────────────────────────────────────────────────────────────────────
 * Add upcoming workshop dates here. The bot uses this to:
 *   1. Cross-check the date scraped from the website (Slacks if they differ)
 *   2. Find the make-up date (first entry after the current workshop)
 *
 * Format: ISO 8601 with explicit UTC offset
 *   PDT (Mar 2nd Sun → Nov 1st Sun): -07:00
 *   PST (Nov 1st Sun → Mar 2nd Sun): -08:00
 *
 * All workshops are 9am Pacific. Add non-Saturday exceptions as needed.
 * Past dates are ignored automatically — safe to leave them in.
 */

export const WORKSHOP_SCHEDULE = [
  // ── June 2026 ─────────────────────────────────────────────────────────
  "2026-06-21T09:00:00-07:00",  // Sunday June 21  ← current (exception)
  "2026-06-27T09:00:00-07:00",  // Saturday June 27

  // ── July 2026 ─────────────────────────────────────────────────────────
  "2026-07-04T09:00:00-07:00",  // Saturday July 4
  "2026-07-11T09:00:00-07:00",  // Saturday July 11
  "2026-07-18T09:00:00-07:00",  // Saturday July 18
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
