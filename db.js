/**
 * SOF Bot — Postgres layer
 * ─────────────────────────────────────────────────────────────────────────
 * Owns the `workshops` table on the sof-bot database (Postgres--SN8).
 * This is NOT the tfc-platform database — do not point DATABASE_URL at that one.
 *
 * Times are stored as a Pacific *calendar date* + *wall-clock time*, never as a
 * UTC offset. Postgres converts to a real instant with `AT TIME ZONE`, which
 * handles DST on its own — so nobody has to remember that Nov 1 flips -07:00 to
 * -08:00 the way workshop-schedule.js required.
 */

import pg from "pg";

const TZ = "America/Los_Angeles";

let pool = null;

export function isConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!isConfigured()) throw new Error("DATABASE_URL is not set");
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
      // Railway's internal network doesn't present a cert chain node trusts.
      ssl: process.env.DATABASE_URL.includes(".railway.internal")
        ? false
        : { rejectUnauthorized: false },
    });
    pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  }
  return pool;
}

// Selected on every read: the stored Pacific wall-clock converted to a true
// instant. `local_date` goes through to_char so node-pg doesn't hand back a
// Date that shifts under the server's own timezone.
const SELECT_COLUMNS = `
  id,
  to_char(local_date, 'YYYY-MM-DD')        AS local_date,
  to_char(local_time, 'HH24:MI')           AS local_time,
  note,
  active,
  edition,
  zoom_link,
  zoom_webinar_id,
  updated_by,
  updated_at,
  (local_date + local_time) AT TIME ZONE '${TZ}' AS starts_at
`;

export async function initSchema() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS workshops (
        id          SERIAL PRIMARY KEY,
        local_date  DATE        NOT NULL,
        local_time  TIME        NOT NULL DEFAULT '09:00',
        note        TEXT        NOT NULL DEFAULT '',
        active      BOOLEAN     NOT NULL DEFAULT TRUE,
        updated_by  TEXT        NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Additive migration for tables created before the audit trail existed.
    await client.query(`
      ALTER TABLE workshops
        ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT ''
    `);
    // The Zoom room for this workshop. `zoom_link` is what gets published to
    // GHL; `zoom_webinar_id` is Zoom's own id, and its presence is what stops
    // the scheduler from creating a second webinar for the same slot.
    // Nullable on purpose: a slot with no link yet is a real state the
    // reconciler must recognise rather than paper over.
    await client.query(`
      ALTER TABLE workshops
        ADD COLUMN IF NOT EXISTS zoom_link TEXT,
        ADD COLUMN IF NOT EXISTS zoom_webinar_id TEXT
    `);
    // The workshop's edition number, as used in the registration tag
    // (the-big-three-webinar-v45). Stored, not derived from position: a
    // cancelled or inserted date must not renumber every workshop after it,
    // and tags already applied to real contacts can never be rewritten.
    await client.query(`
      ALTER TABLE workshops
        ADD COLUMN IF NOT EXISTS edition INTEGER
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS workshops_slot_idx
        ON workshops (local_date, local_time)
    `);
  } finally {
    client.release();
  }
}

/** True when the table has no rows at all — used to decide whether to seed. */
export async function isEmpty() {
  const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM workshops`);
  return rows[0].n === 0;
}

/**
 * Seed from the legacy workshop-schedule.js array. Only ever called when the
 * table is empty, so re-running it is a no-op rather than a duplicate import.
 */
export async function seedFrom(isoList) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const iso of isoList) {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      const localDate = d.toLocaleDateString("en-CA", { timeZone: TZ });          // YYYY-MM-DD
      const localTime = d.toLocaleTimeString("en-GB", { timeZone: TZ, hour12: false }); // HH:MM:SS
      await client.query(
        `INSERT INTO workshops (local_date, local_time, note, updated_by)
         VALUES ($1, $2, '', 'seed import')
         ON CONFLICT (local_date, local_time) DO NOTHING`,
        [localDate, localTime]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listWorkshops({ activeOnly = false, includePast = true } = {}) {
  const where = [];
  if (activeOnly) where.push("active");
  // "Past" is judged against the real instant, not the server's calendar day.
  if (!includePast) where.push(`(local_date + local_time) AT TIME ZONE '${TZ}' > now() - interval '24 hours'`);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { rows } = await getPool().query(
    `SELECT ${SELECT_COLUMNS} FROM workshops ${clause} ORDER BY local_date, local_time`
  );
  return rows;
}

export async function addWorkshop({ localDate, localTime, note, updatedBy }) {
  // Edition continues the sequence rather than counting rows — deleting a past
  // workshop must not hand its number to a future one, since the old number is
  // already on real contacts in GHL.
  const { rows } = await getPool().query(
    `INSERT INTO workshops (local_date, local_time, note, updated_by, edition)
     VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(edition), 0) + 1 FROM workshops))
     RETURNING ${SELECT_COLUMNS}`,
    [localDate, localTime, note || "", updatedBy || ""]
  );
  return rows[0];
}

export async function updateWorkshop(id, { localDate, localTime, note, active, edition, zoomLink, zoomWebinarId, updatedBy }) {
  const sets = [];
  const vals = [];
  const push = (frag, val) => { vals.push(val); sets.push(`${frag} = $${vals.length}`); };

  if (localDate !== undefined) push("local_date", localDate);
  if (localTime !== undefined) push("local_time", localTime);
  if (note !== undefined) push("note", note);
  if (active !== undefined) push("active", active);
  // Empty string from the admin form means "no link", which must be stored as
  // NULL — the reconciler treats NULL as "not ready to publish", and "" would
  // slip past that check and publish a blank Zoom link.
  if (edition !== undefined) push("edition", Number.isInteger(edition) ? edition : null);
  if (zoomLink !== undefined) push("zoom_link", zoomLink?.trim() || null);
  if (zoomWebinarId !== undefined) push("zoom_webinar_id", zoomWebinarId?.trim() || null);
  if (!sets.length) return null;

  // Stamped on every write, so "last edited by" is always the person who
  // actually made the change rather than whoever created the row.
  push("updated_by", updatedBy || "");
  sets.push("updated_at = now()");
  vals.push(id);

  const { rows } = await getPool().query(
    `UPDATE workshops SET ${sets.join(", ")} WHERE id = $${vals.length}
     RETURNING ${SELECT_COLUMNS}`,
    vals
  );
  return rows[0] || null;
}

/**
 * Renumber upcoming workshops so editions run in date order.
 *
 * Only rows from the current workshop forward are touched. Past editions are
 * already applied to real contacts in GHL and can never move. Future ones have
 * never been applied to anyone — nobody can be tagged with an edition that
 * isn't the current one — so inserting a date mid-schedule should slot in and
 * push the rest down.
 *
 * The current workshop is the anchor: it keeps its number, and everything
 * after it counts up from there. Set the anchor's edition by hand once and the
 * whole forward schedule numbers itself.
 */
export async function renumberUpcoming({ cutoverMinutes = 30 } = {}) {
  const { rows } = await getPool().query(
    `WITH upcoming AS (
       SELECT id, row_number() OVER (ORDER BY local_date, local_time) AS rn
       FROM workshops
       WHERE active
         AND (local_date + local_time) AT TIME ZONE '${TZ}' > now() - ($1 || ' minutes')::interval
     ),
     anchor AS (
       SELECT COALESCE(
         (SELECT w.edition FROM workshops w JOIN upcoming u ON u.id = w.id WHERE u.rn = 1),
         (SELECT MAX(w2.edition) + 1 FROM workshops w2 WHERE w2.id NOT IN (SELECT id FROM upcoming)),
         1
       ) AS base
     )
     UPDATE workshops w
     SET edition = anchor.base + upcoming.rn - 1
     FROM upcoming, anchor
     WHERE w.id = upcoming.id
       AND w.edition IS DISTINCT FROM anchor.base + upcoming.rn - 1
     RETURNING w.id, w.edition`,
    [String(cutoverMinutes)]
  );
  return rows;
}

export async function deleteWorkshop(id) {
  const { rowCount } = await getPool().query(`DELETE FROM workshops WHERE id = $1`, [id]);
  return rowCount > 0;
}

export async function close() {
  if (pool) { await pool.end(); pool = null; }
}
