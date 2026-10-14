import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildTideArray,
  coefficientLabel,
  extractElementHtml,
  extractExtraData,
  extractInnerHtmlFromJs,
  parseHarbourList,
  parseHarbourSearchResults,
  parseTideTable,
} from "../src/scrapers/maree-info";
import type { RawTideData } from "../src/types";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const tideTable = () =>
  parseTideTable(extractElementHtml(fixture("tide-75.html"), "MareeJours_Content"));

describe("parseTideTable (live fixture)", () => {
  const data = tideTable();

  it("returns one entry per displayed day, keyed yyyymmddx", () => {
    const keys = Object.keys(data);
    expect(keys.length).toBeGreaterThanOrEqual(7);
    for (const key of keys) expect(key).toMatch(/^\d{9}$/);
  });

  it("alternates tide types and pairs every time with a height", () => {
    for (const day of Object.values(data)) {
      expect(day.tide_data.length).toBeGreaterThanOrEqual(3);
      day.tide_data.forEach((t, i) => {
        expect(t.time).toMatch(/^\d{2}h\d{2}$/);
        expect(t.high).toMatch(/^\d+,\d{2}m$/);
        if (i > 0) expect(t.type).not.toBe(day.tide_data[i - 1].type);
      });
    }
  });

  it("attaches coefficients to high tides only", () => {
    for (const day of Object.values(data)) {
      for (const t of day.tide_data) {
        if (t.type === "low_tide") expect(t.coeff).toBeUndefined();
        else expect(t.coeff).toMatch(/^\d{2,3}$/);
      }
    }
  });
});

describe("parseTideTable (synthetic rows)", () => {
  const page = (rows: string) =>
    `<table id="MareeJours">${rows}</table>`;
  const row = (d: string, times: string[], heights: string[], coeffs: string[]) =>
    `<tr class="MJ"><th><a onmouseover="QSr(this,'?d=${d}');">Lun.<br><b>${d.slice(6, 8)}</b></a></th>` +
    `<td>${times.join("<br>")}</td><td>${heights.join("<br>")}</td><td>${coeffs.join("<br>")}</td></tr>`;

  it("handles a day starting with a high tide", () => {
    const html = page(
      row("202601150", ["05h10", "<b>11h20</b>"], ["7,10m", "<b>1,50m</b>"], ["<b>90</b>", "&nbsp;"]),
    );
    const [day] = Object.values(parseTideTable(html));
    expect(day.tide_data.map((t) => t.type)).toEqual(["high_tide", "low_tide"]);
    expect(day.tide_data[0].coeff).toBe("90");
    expect(day.tide_data[0].coeff_label).toBe("vive-eau");
  });

  it("handles a day starting with a low tide", () => {
    const html = page(
      row("202601150", ["01h00", "07h00", "13h00", "19h00"], ["1,00m", "7,00m", "1,10m", "7,20m"], ["&nbsp;", "79", "&nbsp;", "74"]),
    );
    const [day] = Object.values(parseTideTable(html));
    expect(day.tide_data.map((t) => t.coeff)).toEqual([undefined, "79", undefined, "74"]);
  });

  it("handles days with only three tides", () => {
    const html = page(
      row("202601150", ["00h30", "06h40", "12h50"], ["1,00m", "7,00m", "1,10m"], ["&nbsp;", "70", "&nbsp;"]),
    );
    const [day] = Object.values(parseTideTable(html));
    expect(day.tide_data).toHaveLength(3);
    expect(day.tide_data[1].coeff).toBe("70");
  });

  it("computes the displayed date from the day offset across month and year ends", () => {
    const html = page(
      row("202612310", ["01h00", "07h00"], ["1,00m", "7,00m"], ["&nbsp;", "70"]) +
        row("202612311", ["01h00", "07h00"], ["1,00m", "7,00m"], ["&nbsp;", "70"]),
    );
    const data = parseTideTable(html);
    expect(data["202612310"].date).toBe("Lun. 31 décembre 2026");
    expect(data["202612311"].date).toContain("janvier 2027");
  });

  it("returns nothing for unrelated HTML", () => {
    expect(parseTideTable("<p>maintenance</p>")).toEqual({});
  });
});

describe("buildTideArray", () => {
  it("does not crash when coefficients are missing", () => {
    const out = buildTideArray(["06h00", "12h00"], ["7,00m", "1,00m"], []);
    expect(out[0].coeff).toBeUndefined();
  });
});

describe("coefficientLabel", () => {
  it.each([
    ["20", "morte-eau"],
    ["45", "morte-eau"],
    ["46", "normale"],
    ["70", "normale"],
    ["71", "vive-eau"],
    ["95", "vive-eau"],
    ["96", "vive-eau exceptionnelle"],
  ])("%s -> %s", (coeff, label) => {
    expect(coefficientLabel(coeff)).toBe(label);
  });

  it("returns null for non-numeric input", () => {
    expect(coefficientLabel("-")).toBeNull();
  });
});

describe("extractExtraData", () => {
  const data = (): RawTideData => ({
    "202601150": {
      date: "d",
      tide_data: [
        { type: "high_tide", time: "05h00", high: "7,00m" },
        { type: "low_tide", time: "11h00", high: "1,00m" },
      ],
    },
    "202601151": {
      date: "d2",
      tide_data: [{ type: "high_tide", time: "05h30", high: "7,10m" }],
    },
  });
  // 08:00 Paris on 15 Jan 2026 (UTC+1) == 07:00Z
  const at = (iso: string) => new Date(iso);

  it("picks last and next tide around now (Paris time)", () => {
    const r = extractExtraData(data(), at("2026-01-15T07:00:00Z"));
    expect(r.last_tide?.time).toBe("05h00");
    expect(r.next_tide?.time).toBe("11h00");
    expect(r.forecast.date_index).toBe("20260115");
  });

  it("rolls over to the next day's first tide", () => {
    const r = extractExtraData(data(), at("2026-01-15T11:00:00Z"));
    expect(r.last_tide?.time).toBe("11h00");
    expect(r.next_tide?.time).toBe("05h30");
    expect(r.next_tide?.timestamp).toBe("16/01/2026 05:30:00");
  });

  it("leaves last_tide null before the first tide of the day", () => {
    const r = extractExtraData(data(), at("2026-01-15T00:00:00Z"));
    expect(r.last_tide).toBeNull();
    expect(r.next_tide?.time).toBe("05h00");
  });

  it("uses Paris summer time", () => {
    // 05:30Z in July is 07:30 Paris, after the 05h00 tide
    const d = data();
    const r = extractExtraData(
      { "202607150": d["202601150"], "202607151": d["202601151"] },
      at("2026-07-15T05:30:00Z"),
    );
    expect(r.last_tide?.time).toBe("05h00");
  });

  it("rolls the timestamp across month ends", () => {
    const r = extractExtraData(
      {
        "202601310": { date: "d", tide_data: [{ type: "high_tide", time: "05h00", high: "7,00m" }] },
        "202601311": { date: "d", tide_data: [{ type: "high_tide", time: "05h30", high: "7,00m" }] },
      },
      at("2026-01-31T12:00:00Z"),
    );
    expect(r.next_tide?.timestamp).toBe("01/02/2026 05:30:00");
  });
});

describe("harbour parsing", () => {
  it("parses the harbour list from the home page", () => {
    const harbours = parseHarbourList(
      extractElementHtml(fixture("home.html"), "PortsListe_Content_0"),
    );
    expect(Object.keys(harbours).length).toBeGreaterThan(50);
    expect(harbours["75"]).toBe("L'Aber Benoît");
    for (const id of Object.keys(harbours)) expect(id).toMatch(/^\d+$/);
  });

  it("parses the search JS response", () => {
    const html = extractInnerHtmlFromJs(fixture("search-brest.js"));
    const { availableHarbours, nearHarbours } = parseHarbourSearchResults(html);
    expect(availableHarbours).toEqual([{ id: 82 }]);
    expect(nearHarbours.length).toBeGreaterThan(0);
  });

  it("returns empty results when the session expired", () => {
    const html = extractInnerHtmlFromJs(
      'alert("Votre session terminée, veuillez actualiser la page.");',
    );
    expect(html).toBe("");
    expect(parseHarbourSearchResults(html)).toEqual({
      availableHarbours: [],
      nearHarbours: [],
    });
  });
});
