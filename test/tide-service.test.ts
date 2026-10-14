import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTideData } from "../src/services/tide";
import type { CloudflareEnv } from "../src/types";

const page = readFileSync(new URL("./fixtures/tide-75.html", import.meta.url), "utf8");

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null)),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  };
}

function fakeEnv(kv = fakeKv()) {
  const env = {
    TIDE_KV: kv,
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ id: "75", name: "L'Aber Benoît" }) }),
      }),
    },
  } as unknown as CloudflareEnv;
  return { env, kv };
}

const request = () => new Request("https://data.test/tide?id=75");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("getTideData", () => {
  it("scrapes once, then serves raw data from KV", async () => {
    const fetchMock = vi.fn(async () => new Response(page));
    vi.stubGlobal("fetch", fetchMock);
    const { env, kv } = fakeEnv();

    const first = await getTideData(request(), env);
    expect(first.cached).toBe(false);
    expect(first.id).toBe("75");
    expect(kv.store.has("tide:75")).toBe(true);

    const second = await getTideData(request(), env);
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.data).toEqual(first.data);
  });

  it("does not cache when maree.info returns an error page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>maintenance</p>")));
    const { env, kv } = fakeEnv();

    await expect(getTideData(request(), env)).rejects.toThrow();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("does not cache on an upstream HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const { env, kv } = fakeEnv();

    await expect(getTideData(request(), env)).rejects.toThrow();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("refetches when the cached data starts before today (Paris)", async () => {
    const fetchMock = vi.fn(async () => new Response(page));
    vi.stubGlobal("fetch", fetchMock);
    const { env } = fakeEnv();

    await getTideData(request(), env);
    vi.setSystemTime(new Date("2026-10-15T00:30:00Z")); // 02:30 Paris, next day
    const next = await getTideData(request(), env);

    expect(next.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports upstream failures as 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const { env } = fakeEnv();

    await expect(getTideData(request(), env)).rejects.toMatchObject({ status: 502 });
  });
});
