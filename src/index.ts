import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";

import {
  name,
  version,
  description,
  repository,
  author,
  homepage,
  license,
} from "../package.json";

import { domain } from "./routes/cyber/domain";
import { ip } from "./routes/cyber/ip";
import { ua } from "./routes/cyber/ua";
import { cve } from "./routes/cyber/cve";
import { asn } from "./routes/cyber/asn";
import { hash } from "./routes/cyber/hash";
import { url } from "./routes/cyber/url";
import { tide } from "./routes/data/tide";
import { weather } from "./routes/data/weather";
import { apero } from "./routes/data/apero";
import { fetchHarboursData } from "./scrapers/maree-info";
import { updateHarbourDatabase } from "./services/harbour";
import type { CloudflareEnv } from "./types";

// Origins allowed to call the /data/* endpoints (tide, weather, apero)
const DATA_ORIGINS = [
  "https://tide.cybai.re",
  "https://tide.pages.dev",
  "https://cletqui.github.io/tide",
  "https://apero.cybai.re",
  "https://apero.pages.dev",
  "https://cletqui.github.io/apero",
  "https://callot.cybai.re",
  "https://callot.pages.dev",
  "https://cletqui.github.io/callot",
];

// Allow localhost in any form for local development
function isAllowedDataOrigin(origin: string): string | null {
  if (DATA_ORIGINS.includes(origin)) return origin;
  // file:// protocol — browsers send Origin: null
  if (origin === "null") return origin;
  // localhost in any form (http/https, any port, IPv4 and IPv6)
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return origin;
  return null;
}

/* APP */
const app = new OpenAPIHono<{ Bindings: CloudflareEnv }>();

/* MIDDLEWARES */
app.use("*", logger());
app.use("*", prettyJSON());

// /cyber/* — open CORS (public API)
app.use("/cyber/*", cors({ origin: "*", allowMethods: ["GET"] }));

// /data/* — restricted to known frontends + localhost for local dev
app.use(
  "/data/*",
  cors({
    origin: isAllowedDataOrigin,
    allowMethods: ["GET"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  })
);

/* ERROR HANDLER */
app.onError((err: any, c) => {
  const status = err.status ?? 500;
  console.error(`[${status}] ${err.message}`);
  return c.text(err.message, status);
});

/* ROOT */
app.get("/", (c) => c.redirect("/docs", 301));

/* CYBER ROUTES */
app.route("/cyber/domain", domain);
app.route("/cyber/ip", ip);
app.route("/cyber/ua", ua);
app.route("/cyber/cve", cve);
app.route("/cyber/asn", asn);
app.route("/cyber/hash", hash);
app.route("/cyber/url", url);

/* DATA ROUTES */
app.route("/data", tide);
app.route("/data", weather);
app.route("/data", apero);

/* DOCS */
app.get("/docs", swaggerUI({ url: "/docs/json" }));

app.doc("/docs/json", {
  openapi: "3.0.0",
  info: {
    title: name,
    version: version,
    description: `[${description}](${homepage}) — [${repository.type}](${repository.url})`,
    contact: {
      name: author.name,
      url: `${repository.url}/issues`,
    },
    license: { name: license },
  },
  servers: [{ url: homepage, description: "Production" }],
  tags: [
    { name: "Domain", description: "Domain information (certs, DNS, mail security)" },
    { name: "IP", description: "IP information (geolocation, reverse DNS, Shodan InternetDB)" },
    { name: "User-Agent", description: "User-Agent parsing" },
    { name: "CVE", description: "CVE / vulnerability lookup" },
    { name: "ASN", description: "Autonomous System Number intel (BGPView)" },
    { name: "Hash", description: "Malware hash lookup (MalwareBazaar)" },
    { name: "URL", description: "URL redirect chain tracing" },
    { name: "Tide", description: "French harbour tide data (maree.info)" },
    { name: "Weather", description: "Weather data (wttr.in)" },
    { name: "Apero", description: "Global apéritif customs by timezone" },
  ],
});

/* EXPORT */
export default {
  fetch: app.fetch,

  /**
   * Cron trigger — runs daily at 3am UTC.
   * Re-scrapes the maree.info harbour list and syncs any additions or name
   * changes to D1. Tide data itself is cached per-harbour in KV on demand.
   * Errors propagate so failed runs show up as failures in the dashboard.
   */
  async scheduled(
    _event: ScheduledEvent,
    env: CloudflareEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    const { upserted, deleted } = await updateHarbourDatabase(
      await fetchHarboursData(),
      env
    );
    console.log(`Cron: harbour registry synced (${upserted} upserted, ${deleted} deleted).`);
  },
};
