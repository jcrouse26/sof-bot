/**
 * SOF Bot — schedule cache
 * ─────────────────────────────────────────────────────────────────────────
 * The bot must always be able to answer "when is the next workshop?", so it
 * never reads Postgres on the request path. It reads this in-memory cache,
 * which is refreshed on a timer and immediately after any edit.
 *
 * Degradation ladder, worst case last:
 *   1. database   — normal operation
 *   2. last good  — DB unreachable, serve the last successful read (stale but valid)
 *   3. seed-file  — DB unreachable and we never got a good read; use workshop-schedule.js
 *   4. (server.js falls back to next Saturday 9am PT if the list is exhausted)
 *
 * Once the table has rows, the database is the source of truth. The seed file
 * is only for first-boot import and total-outage fallback — editing it will not
 * change the bot's behavior anymore.
 */

import { WORKSHOP_SCHEDULE } from "./workshop-schedule.js";
import * as db from "./db.js";

const REFRESH_MS = 60_000;

let cache = {
  iso: [...WORKSHOP_SCHEDULE],
  source: "seed-file",
  loadedAt: null,
  error: null,
};

let timer = null;

/** ISO strings, ascending. Synchronous — safe to call from the request path. */
export function getScheduleISO() {
  return cache.iso;
}

export function getMeta() {
  return {
    source: cache.source,
    loadedAt: cache.loadedAt,
    count: cache.iso.length,
    error: cache.error,
  };
}

export async function refresh() {
  if (!db.isConfigured()) {
    cache = { ...cache, source: "seed-file", error: "DATABASE_URL not set" };
    return cache;
  }
  try {
    const rows = await db.listWorkshops({ activeOnly: true });
    cache = {
      iso: rows.map((r) => r.starts_at.toISOString()),
      source: "database",
      loadedAt: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    // Keep whatever we had. A stale date beats a crash or a wrong answer.
    console.error("[schedule] refresh failed, serving cached:", err.message);
    cache = { ...cache, error: err.message };
  }
  return cache;
}

/**
 * Called once at boot. Creates the table, seeds it from workshop-schedule.js if
 * it's empty, loads the cache, and starts the refresh timer. Never throws — a
 * database problem must not stop the bot from booting and answering texts.
 */
export async function init() {
  if (!db.isConfigured()) {
    console.warn("[schedule] DATABASE_URL not set — using workshop-schedule.js only");
    return;
  }
  try {
    await db.initSchema();
    if (await db.isEmpty()) {
      console.log(`[schedule] empty table — seeding ${WORKSHOP_SCHEDULE.length} dates from workshop-schedule.js`);
      await db.seedFrom(WORKSHOP_SCHEDULE);
    }
    await refresh();
    console.log(`[schedule] loaded ${cache.iso.length} dates from ${cache.source}`);
  } catch (err) {
    console.error("[schedule] init failed — falling back to workshop-schedule.js:", err.message);
    cache = { ...cache, error: err.message };
  }

  if (!timer) {
    timer = setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS);
    timer.unref?.();
  }
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}
