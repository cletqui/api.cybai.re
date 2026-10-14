import type { Harbour, HarbourDatabase, CloudflareEnv } from "../types";

// ── D1 harbour registry ────────────────────────────────────────────────────
// All reads and writes go through parameterised queries to prevent injection.

/**
 * Returns all harbours from D1 as an { id: name } map.
 * Returns an empty object if D1 is unavailable or the table doesn't exist yet
 * (e.g. local dev before the first migration / cron run).
 */
export async function getHarbourDatabase(
  env: CloudflareEnv
): Promise<HarbourDatabase> {
  if (!env.DB) return {};
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name FROM harbour_table;`
    ).all<{ id: string; name: string }>();
    return Object.fromEntries(results.map((r) => [r.id, r.name]));
  } catch {
    return {}; // Table doesn't exist yet (local dev, first run)
  }
}

/**
 * Returns a single harbour row by ID, or null if not found.
 */
export async function getHarbourById(
  id: string | number,
  env: CloudflareEnv
): Promise<Harbour | null> {
  try {
    return await env.DB.prepare(
      `SELECT id, name FROM harbour_table WHERE id = ?`
    )
      .bind(id)
      .first<Harbour>();
  } catch {
    return null;
  }
}

/**
 * Returns a single harbour row by name (case-insensitive), or null if not found.
 */
export async function getHarbourByName(
  name: string,
  env: CloudflareEnv
): Promise<Harbour | null> {
  try {
    return await env.DB.prepare(
      `SELECT id, name FROM harbour_table WHERE UPPER(name) LIKE UPPER(?)`
    )
      .bind(name)
      .first<Harbour>();
  } catch {
    return null;
  }
}

export interface HarbourSyncResult {
  upserted: number;
  deleted: number;
}

const BATCH_SIZE = 50;

/**
 * Syncs the D1 table with a fresh { id: name } map from maree.info.
 * Upserts new or renamed harbours and deletes ones no longer listed.
 * Refuses to run on an empty map so a scraping failure can't wipe the registry.
 */
export async function updateHarbourDatabase(
  harbourData: HarbourDatabase,
  env: CloudflareEnv
): Promise<HarbourSyncResult> {
  if (Object.keys(harbourData).length === 0) {
    throw new Error("Refusing to sync an empty harbour list.");
  }

  const existing = await getHarbourDatabase(env);

  const upserts = Object.entries(harbourData)
    .filter(([id, name]) => existing[id] !== name)
    .map(([id, name]) =>
      env.DB.prepare(
        `INSERT INTO harbour_table (id, name) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`
      ).bind(id, name)
    );
  const deletes = Object.keys(existing)
    .filter((id) => !(id in harbourData))
    .map((id) => env.DB.prepare(`DELETE FROM harbour_table WHERE id = ?`).bind(id));

  const statements = [...upserts, ...deletes];
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await env.DB.batch(statements.slice(i, i + BATCH_SIZE));
  }

  return { upserted: upserts.length, deleted: deletes.length };
}
