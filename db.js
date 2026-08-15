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
  const { rows } = await getPool().query(
    `INSERT INTO workshops (local_date, local_time, note, updated_by)
     VALUES ($1, $2, $3, $4)
     RETURNING ${SELECT_COLUMNS}`,
    [localDate, localTime, note || "", updatedBy || ""]
  );
  return rows[0];
}

export async function updateWorkshop(id, { localDate, localTime, note, active, updatedBy }) {
  const sets = [];
  const vals = [];
  const push = (frag, val) => { vals.push(val); sets.push(`${frag} = $${vals.length}`); };

  if (localDate !== undefined) push("local_date", localDate);
  if (localTime !== undefined) push("local_time", localTime);
  if (note !== undefined) push("note", note);
  if (active !== undefined) push("active", active);
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

export async function deleteWorkshop(id) {
  const { rowCount } = await getPool().query(`DELETE FROM workshops WHERE id = $1`, [id]);
  return rowCount > 0;
}

export async function close() {
  if (pool) { await pool.end(); pool = null; }
}
