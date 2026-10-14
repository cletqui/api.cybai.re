import { load } from "cheerio";
import { parse } from "acorn";
import type {
  TideEntry,
  TideType,
  CoeffLabel,
  DayForecast,
  RawTideData,
  TideExtraData,
  DayForecastWithIndex,
  HarbourDatabase,
  NearestHarboursRaw,
} from "../types";

const BASE_URL = "https://maree.info/";
const HTML_OPTIONS: RequestInit = {
  method: "GET",
  headers: { "Content-Type": "text/html;charset=utf-8" },
};

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetches and parses the full harbour list from maree.info.
 * Returns an object mapping harbour ID → harbour name.
 */
export async function fetchHarboursData(): Promise<HarbourDatabase> {
  try {
    const html = await fetchPage(BASE_URL);
    const content = extractElementHtml(html, "PortsListe_Content_0");
    const harbours = parseHarbourList(content);
    if (Object.keys(harbours).length === 0) {
      throw new Error("Harbour list on maree.info is empty.");
    }
    return harbours;
  } catch (error) {
    console.error("Error fetching harbour list:", error);
    (error as any).status = 502;
    throw error;
  }
}

/**
 * Fetches and parses tide data for a given harbour ID.
 * Returns an object keyed by date (yyyymmddx) with tide entries for each day.
 */
export async function fetchTideData(harbourId: string): Promise<RawTideData> {
  try {
    const html = await fetchPage(`${BASE_URL}${harbourId}`);
    const content = extractElementHtml(html, "MareeJours_Content");
    const data = parseTideTable(content);
    if (Object.keys(data).length === 0) {
      throw new Error(`No tide data found on maree.info for harbour ${harbourId}.`);
    }
    return data;
  } catch (error) {
    console.error(`Error fetching tide data for harbour ${harbourId}:`, error);
    (error as any).status = 502;
    throw error;
  }
}

/**
 * Searches maree.info for harbours matching a given name.
 * Returns { availableHarbours, nearHarbours } or throws on failure.
 */
export async function fetchNearestHarbours(
  name: string
): Promise<NearestHarboursRaw> {
  try {
    const js = await fetchNearestHarboursJs(name);
    const innerHtml = extractInnerHtmlFromJs(js);
    return parseHarbourSearchResults(innerHtml);
  } catch (error) {
    console.error("Error fetching nearest harbours:", error);
    (error as any).status = 502;
    throw error;
  }
}

/**
 * Processes raw tide data into a summary object.
 * Always computed fresh — never cached — so last_tide and next_tide are accurate.
 */
export function extractExtraData(
  tideData: RawTideData,
  now: Date = new Date()
): TideExtraData {
  let forecast: Partial<DayForecastWithIndex> = {};
  let lastTide: TideEntry | null = null;
  let nextTide: TideEntry | null = null;
  let nowFound = false;

  // Tide times from maree.info are in Europe/Paris local time. We store them
  // with a Z suffix so the UTC numeric value equals the Paris clock value.
  // Mirror that trick for `now` so both sides are directly comparable.
  const nowParisNaive = new Date(
    now.toLocaleString("sv", { timeZone: "Europe/Paris" }).replace(" ", "T") +
      ".000Z"
  );

  for (const [key, value] of Object.entries(tideData)) {
    const dateIndex = key.slice(0, -1);
    const dayOffset = Number(key.slice(-1));
    const year = dateIndex.slice(0, 4);
    const month = dateIndex.slice(4, 6);
    const day = dateIndex.slice(6, 8);

    if (dayOffset === 0) {
      forecast = { date_index: dateIndex, ...value };
    }

    for (const tide of value.tide_data) {
      const dateString = `${year}-${month}-${day}T${tide.time.replace("h", ":")}:00.000Z`;
      const date = new Date(dateString);
      date.setUTCDate(date.getUTCDate() + dayOffset);

      // Read UTC fields: the naive-UTC trick stores Paris local time there, and
      // toLocaleString() output varies with the runtime locale.
      const p = (n: number) => String(n).padStart(2, "0");
      tide.timestamp = `${p(date.getUTCDate())}/${p(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`;

      // TODO: the first tide of the day has no visibility into the previous
      // day's last tide. Handled in services/tide.ts via KV fallback.
      if (!nowFound) {
        if (date > nowParisNaive) {
          nextTide = tide;
          nowFound = true;
        } else {
          lastTide = tide;
        }
      }
    }
  }

  return { forecast, last_tide: lastTide, next_tide: nextTide, data: tideData };
}

// ── Fetching ───────────────────────────────────────────────────────────────

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, HTML_OPTIONS);
  if (!response.ok) {
    throw new Error(`maree.info responded ${response.status} for ${url}`);
  }
  return response.text();
}

async function fetchNearestHarboursJs(name: string): Promise<string> {
  // maree.info requires a session cookie for the search endpoint
  const page = await fetch(BASE_URL, HTML_OPTIONS);
  const cookies = page.headers.get("set-cookie");

  const response = await fetch(
    `${BASE_URL}do/ports-liste-recherche.php?q=${encodeURIComponent(name)}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "text/javascript;charset=utf-8",
        Cookie: cookies ?? "",
      },
    }
  );
  return response.text();
}

// ── Parsing ────────────────────────────────────────────────────────────────

export function extractElementHtml(html: string, elementId: string): string {
  const $ = load(html);
  const el = $(`#${elementId}`);
  if (el.length === 0) {
    console.error(`Element #${elementId} not found in HTML`);
    return "";
  }
  return el.html() ?? "";
}

export function parseHarbourList(html: string): HarbourDatabase {
  const $ = load(html);
  const result: HarbourDatabase = {};
  $("a").each((_, el) => {
    const id = $(el).attr("href")?.replace("/", "") ?? "";
    const name = $(el).text();
    if (id) result[id] = name;
  });
  return result;
}

export function parseTideTable(html: string): RawTideData {
  const $ = load(html);
  const result: RawTideData = {};

  $("#MareeJours tr.MJ").each((_, element) => {
    const row = $(element);
    const dateLink = row.find("th a");

    const match = (dateLink.attr("onmouseover") ?? "").match(/\?d=(\d{8})(\d)/);
    if (!match) return;
    const [, baseDate, offset] = match;
    const dateKey = baseDate + offset;

    // Each <td> is a column (times, heights, coefficients) whose values are
    // separated by <br>; empty slots are &nbsp;.
    const columns = row
      .find("td")
      .toArray()
      .map((td) =>
        ($(td).html() ?? "")
          .split(/<br\s*\/?>/i)
          .map((cell) => load(`<i>${cell}</i>`)("i").text().replace(/\u00a0/g, " ").trim())
      );
    const [times = [], heights = [], coeffs = []] = columns.map(splitColumn);

    const actual = new Date(
      Date.UTC(
        parseInt(baseDate.slice(0, 4), 10),
        parseInt(baseDate.slice(4, 6), 10) - 1,
        parseInt(baseDate.slice(6, 8), 10) + parseInt(offset, 10)
      )
    );
    const monthName = new Intl.DateTimeFormat("fr", {
      month: "long",
      timeZone: "UTC",
    }).format(actual);
    const dateNum = dateLink.find("b").text();
    const dayName = dateLink.text().replace(dateNum, "").trim();

    result[dateKey] = {
      date: `${dayName} ${dateNum} ${monthName} ${actual.getUTCFullYear()}`,
      tide_data: buildTideArray(times, heights, coeffs),
    };
  });

  return result;
}

function splitColumn(cells: string[]): string[] {
  return cells.filter((c) => c !== "");
}

export function buildTideArray(
  times: string[],
  heights: string[],
  coeffs: string[]
): TideEntry[] {
  const firstType = inferFirstTideType(heights);
  const secondType: TideType = firstType === "high_tide" ? "low_tide" : "high_tide";

  // maree.info lists one coefficient per high tide, in order.
  let coeffIndex = 0;
  return times.map((time, i) => {
    const type = i % 2 === 0 ? firstType : secondType;
    const entry: TideEntry = { type, time, high: heights[i] };
    if (type === "high_tide" && coeffs[coeffIndex] !== undefined) {
      const coeff = coeffs[coeffIndex++];
      entry.coeff = coeff;
      entry.coeff_label = coefficientLabel(coeff);
    }
    return entry;
  });
}

/**
 * Returns a French tidal range label for a given coefficient (0–120).
 *
 * Standard French classification:
 *   ≤ 45  → morte-eau (neap tide — weak range)
 *   ≤ 70  → normale
 *   ≤ 95  → vive-eau (spring tide)
 *   > 95  → vive-eau exceptionnelle
 */
export function coefficientLabel(coeff: string): CoeffLabel | null {
  const n = parseInt(coeff, 10);
  if (isNaN(n)) return null;
  if (n <= 45) return "morte-eau";
  if (n <= 70) return "normale";
  if (n <= 95) return "vive-eau";
  return "vive-eau exceptionnelle";
}

export function inferFirstTideType(heights: string[]): TideType {
  try {
    const first = parseFloat(heights[0].replace(",", "."));
    const second = parseFloat(heights[1].replace(",", "."));
    return first > second ? "high_tide" : "low_tide";
  } catch {
    return "high_tide";
  }
}

// maree.info returns a JS snippet that sets e.innerHTML; we parse the AST to
// extract the HTML string rather than relying on fragile regex.
export function extractInnerHtmlFromJs(jsString: string): string {
  try {
    const ast = parse(jsString, { ecmaVersion: "latest" });
    let value: string | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function traverse(node: any): void {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "AssignmentExpression" &&
        node.left?.object?.name === "e" &&
        node.left?.property?.name === "innerHTML" &&
        node.right?.type === "Literal"
      ) {
        value = node.right.value as string;
      } else {
        for (const key in node) {
          if (node[key] && typeof node[key] === "object") traverse(node[key]);
        }
      }
    }

    traverse(ast);
    return value ?? "";
  } catch (error) {
    console.error("Error parsing maree.info JS response:", error);
    return "";
  }
}

export function parseHarbourSearchResults(html: string): NearestHarboursRaw {
  const $ = load(html);

  const pick = (selector: string): Array<{ id: number }> =>
    $(selector)
      .map((_, el) => ({
        id: parseInt($(el).attr("href")?.split("/").pop() ?? "0", 10),
      }))
      .get();

  return {
    availableHarbours: pick('div.TYPE:contains("ports disponibles") + a'),
    nearHarbours: pick('div.TYPE:contains("au plus proche d\'un port") + a'),
  };
}
