/**
 * Verify the workshops table on the sof-bot Postgres.
 *
 * Run (from your own terminal — NOT from inside Railway):
 *   railway run --service Postgres--SN8 -- node test-schedule-db.mjs
 *
 * `railway run` injects the database's own env vars into the process, so the
 * password is never typed, echoed, or written to shell history. The script
 * prefers DATABASE_PUBLIC_URL, which is Railway's public TCP proxy — that's
 * what makes this reachable from a laptop.
 *
 * What it does (same work the server does on boot, nothing more):
 *   - CREATE TABLE IF NOT EXISTS workshops
 *   - seeds from workshop-schedule.js ONLY if the table is empty
 *   - prints every row with its true UTC instant so you can eyeball the
 *     Pacific -> UTC conversion, including the November DST rollover
 *
 * Safe to run repeatedly. It never drops, truncates, or updates existing rows.
 *
 * ⚠️  Point this at Postgres--SN8 (the sof-bot database), NEVER at
 *     Postgres-ENka (tfc-platform production — members and payments).
 */

import * as db from "./db.js";
import { WORKSHOP_SCHEDULE } from "./workshop-schedule.js";

// Prefer the public proxy: the .railway.internal host only resolves inside
// Railway's network, so it can't be reached from a laptop.
const chosen = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

if (!chosen) {
  console.error("No database URL found. Run it as:");
  console.error("  railway run --service Postgres--SN8 -- node test-schedule-db.mjs");
  process.exit(1);
}
if (chosen.includes(".railway.internal")) {
  console.error("Only the internal host is available, which a laptop can't reach.");
  console.error("Run it against the Postgres service so DATABASE_PUBLIC_URL is injected:");
  console.error("  railway run --service Postgres--SN8 -- node test-schedule-db.mjs");
  process.exit(1);
}

// db.js reads process.env.DATABASE_URL lazily, on first query.
process.env.DATABASE_URL = chosen;

const host = chosen.replace(/.*@/, "").replace(/\?.*/, "");
console.log(`Connecting to: @${host}`);
if (/enka/i.test(host)) {
  console.error("\nREFUSING TO RUN: that host looks like Postgres-ENka (tfc-platform production).");
  process.exit(1);
}

console.log("\n1. Creating schema if needed…");
await db.initSchema();
console.log("   ✓ workshops table present");

const empty = await db.isEmpty();
console.log(`\n2. Table is ${empty ? "EMPTY" : "already populated"}`);
if (empty) {
  console.log(`   Seeding ${WORKSHOP_SCHEDULE.length} dates from workshop-schedule.js…`);
  await db.seedFrom(WORKSHOP_SCHEDULE);
  console.log("   ✓ seeded");
} else {
  console.log("   Skipping seed (existing rows are left untouched).");
}

console.log("\n3. Rows, with the UTC instant Postgres derives from Pacific wall-clock:\n");
const rows = await db.listWorkshops();
const pad = (s, n) => String(s).padEnd(n);
console.log(
  "   " + pad("DATE", 12) + pad("TIME", 7) + pad("WEEKDAY", 10) +
  pad("-> UTC INSTANT", 26) + "OFFSET"
);
console.log("   " + "-".repeat(70));

let pdtCount = 0, pstCount = 0;
for (const r of rows) {
  const utc = r.starts_at.toISOString();
  // Recover the offset Postgres actually applied, as a sanity check.
  const [y, m, d] = r.local_date.split("-").map(Number);
  const [hh, mm] = r.local_time.split(":").map(Number);
  const offsetHrs = (Date.UTC(y, m - 1, d, hh, mm) - r.starts_at.getTime()) / 3600000;
  const label = offsetHrs === -7 ? "-07:00 PDT" : offsetHrs === -8 ? "-08:00 PST" : `${offsetHrs} ??`;
  if (offsetHrs === -7) pdtCount++;
  if (offsetHrs === -8) pstCount++;
  const weekday = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  console.log("   " + pad(r.local_date, 12) + pad(r.local_time, 7) + pad(weekday, 10) + pad(utc, 26) + label);
}

console.log(`\n4. DST check: ${pdtCount} rows resolved to PDT (-07:00), ${pstCount} to PST (-08:00)`);
console.log(rows.length
  ? "   Dates before Nov 1 should be PDT, on/after should be PST. Confirm above."
  : "   (no rows)");

await db.close();
console.log("\nDone. Nothing was deleted or overwritten.\n");
