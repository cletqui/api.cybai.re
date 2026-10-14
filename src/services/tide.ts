import {
  getHarbourDatabase,
  getHarbourByName,
  getHarbourById,
  updateHarbourDatabase,
} from "./harbour";
import {
  extractExtraData,
  fetchHarboursData,
  fetchTideData,
  fetchNearestHarbours,
} from "../scrapers/maree-info";
import type {
  CloudflareEnv,
  HarbourDatabase,
  HarbourLookupResult,
  RawTideData,
  TideEntry,
  TideResponse,
} from "../types";

// Raw tide data is cached for 12 hours. last_tide / next_tide are always
// recomputed on the fly so they're never stale regardless of cache age.
const TIDE_CACHE_TTL = 43200; // 12h

// The "previous last tide" fallback is kept alive for 24h — long enough to
// survive from the evening scrape into the following morning.
const PREVIOUS_LAST_TIDE_TTL = 86400; // 24h

// ── Tide data ──────────────────────────────────────────────────────────────

/**
 * Returns full tide data for the harbour requested.
 *
 * Raw scraped data is served from KV when available; last_tide and next_tide
 * are computed fresh every time. When last_tide would be null (i.e. before
 * the first tide of the day), the value persisted from the previous scrape
 * cycle is used as a fallback.
 */
export async function getTideData(
  req: Request,
  env: CloudflareEnv
): Promise<TideResponse> {
  const harbour = await getHarbourFromRequest(req, env);

  if (!harbour || !("harbour" in harbour)) {
    const error = Object.assign(new Error("Harbour doesn't exist on maree.info."), { status: 404 });
    throw error;
  }

  const { id, name } = harbour.harbour;
  const { rawData, fromCache } = await getRawTideData(String(id), env);
  const result = extractExtraData(rawData);

  if (env.TIDE_KV) {
    await applyLastTideFallback(String(id), env.TIDE_KV, result, fromCache);
  }

  return { id: String(id), name, cached: fromCache, ...result };
}

/**
 * Returns raw tide data from KV if available, otherwise scrapes maree.info
 * and stores the result.
 */
async function getRawTideData(
  id: string,
  env: CloudflareEnv
): Promise<{ rawData: RawTideData; fromCache: boolean }> {
  const key = `tide:${id}`;

  if (env.TIDE_KV) {
    const cached = await env.TIDE_KV.get<RawTideData>(key, "json");
    if (cached && !isStale(cached)) return { rawData: cached, fromCache: true };
  }

  const rawData = await fetchTideData(id);

  if (env.TIDE_KV) {
    await env.TIDE_KV.put(key, JSON.stringify(rawData), {
      expirationTtl: TIDE_CACHE_TTL,
    });
  }

  return { rawData, fromCache: false };
}

/**
 * Cached data is stale once its first day is no longer today in Paris, e.g.
 * data scraped at 23:00 and read after midnight.
 */
function isStale(data: RawTideData): boolean {
  const today = new Date()
    .toLocaleDateString("sv", { timeZone: "Europe/Paris" })
    .replaceAll("-", "");
  const firstDay = Object.keys(data)
    .sort()[0]
    ?.slice(0, 8);
  return firstDay === undefined || firstDay < today;
}

/**
 * Handles the last_tide fallback for the period before the first tide of the day.
 *
 * Problem: maree.info only returns data from today onward. Before the first
 * tide of the day has passed, last_tide is null — we can't see yesterday.
 *
 * Solution: on each fresh scrape where last_tide is not null, persist it in
 * KV with a 24h TTL (longer than the 12h data cache). Next morning, when the
 * cache is cold and last_tide would be null again, read that persisted value
 * as the fallback.
 *
 * The key is never overwritten when last_tide is null, so the previous
 * evening's value is preserved through the overnight gap.
 */
async function applyLastTideFallback(
  id: string,
  kv: KVNamespace,
  result: ReturnType<typeof extractExtraData>,
  fromCache: boolean
): Promise<void> {
  const fallbackKey = `tide:${id}:previous_last_tide`;

  if (!fromCache && result.last_tide !== null) {
    await kv.put(fallbackKey, JSON.stringify(result.last_tide), {
      expirationTtl: PREVIOUS_LAST_TIDE_TTL,
    });
  }

  if (result.last_tide === null) {
    const fallback = await kv.get<TideEntry>(fallbackKey, "json");
    if (fallback) result.last_tide = fallback;
  }
}

// ── Harbour registry ───────────────────────────────────────────────────────

/**
 * Returns all harbours from D1, refreshing the registry first if the request
 * contains a `?refresh` query parameter.
 * Falls back to a live scrape of maree.info when D1 is empty (local dev or
 * first run before the nightly cron has populated the table).
 */
export async function getHarboursData(
  req: Request,
  env: CloudflareEnv
): Promise<HarbourDatabase> {
  await maybeRefreshHarbourRegistry(req, env);
  const db = await getHarbourDatabase(env);
  if (Object.keys(db).length === 0) {
    return fetchHarboursData();
  }
  return db;
}

async function maybeRefreshHarbourRegistry(
  req: Request,
  env: CloudflareEnv
): Promise<void> {
  const params = new URL(req.url).searchParams;
  if (params.has("refresh")) {
    const harbourData = await fetchHarboursData();
    await updateHarbourDatabase(harbourData, env);
    console.log("Harbour registry refreshed on request.");
  }
}

/**
 * Resolves a harbour from `?id` or `?harbour` / `?name` query parameters.
 *
 * Resolution order:
 *   1. D1 lookup (fast path)
 *   2. Live maree.info harbour list (if not in D1 yet)
 *   3. Fuzzy search via maree.info search API (when name doesn't exact-match)
 */
export async function getHarbourFromRequest(
  req: Request,
  env: CloudflareEnv
): Promise<HarbourLookupResult | null> {
  const params = new URL(req.url).searchParams;

  if (params.has("id")) return resolveById(params.get("id")!, env);
  if (params.has("name") || params.has("harbour")) {
    return resolveByName((params.get("name") ?? params.get("harbour"))!, env);
  }

  return null;
}

// ── Internal resolution helpers ────────────────────────────────────────────

async function resolveById(
  id: string,
  env: CloudflareEnv
): Promise<HarbourLookupResult | null> {
  const fromDb = await getHarbourById(id, env);
  if (fromDb) return { harbour: fromDb };

  const all = await fetchHarboursData();
  if (id in all) return { harbour: { id, name: all[id] } };

  return null;
}

async function resolveByName(
  name: string,
  env: CloudflareEnv
): Promise<HarbourLookupResult | null> {
  const fromDb = await getHarbourByName(name, env);
  if (fromDb) return { harbour: fromDb };

  const all = await fetchHarboursData();
  const exactId = Object.keys(all).find((id) => all[id] === name);
  if (exactId) return { harbour: { id: exactId, name } };

  const nearest = await fetchNearestHarbours(name);
  if (!nearest) return null;

  const { availableHarbours, nearHarbours } = nearest;

  const [resolvedAvailable, resolvedNear] = await Promise.all([
    Promise.all(
      availableHarbours.map((h) =>
        getHarbourById(h.id, env).then((harbour) => ({ harbour }))
      )
    ),
    Promise.all(
      nearHarbours.map((h) =>
        getHarbourById(h.id, env).then((harbour) => ({ harbour }))
      )
    ),
  ]);

  return { availableHarbours: resolvedAvailable, nearHarbours: resolvedNear };
}
