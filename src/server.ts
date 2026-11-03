/**
 * Local web UI: serves ui/index.html and a small JSON API on 127.0.0.1 only. No auth: never expose it.
 * Usage: bun run ui   (port UI_PORT, default 8787)
 */
import type { Server } from "bun";
import { join } from "node:path";
import { intel, leadView, pipeline, setup, today } from "./api.ts";
import { ROOT, UI_PORT, loadConfig, localTime, requireApiKey } from "./config.ts";
import type { Config } from "./config.ts";
import {
  draftsForItem,
  getEntity,
  getLead,
  ideasForWeek,
  insertAction,
  insertItems,
  scoredItem,
  setLeadNote,
  setLeadStatus,
} from "./db.ts";
import type { LeadStatus } from "./db.ts";
import { STATE_TTL_MS, clearToken, consentUrl, exchangeCode, getGmailConfig, isConfigured, mintState } from "./mail/gmail.ts";
import { redraft } from "./plays/drafts.ts";
import { ResearchFailed, researchLead } from "./plays/research.ts";
import { exportSalgsro } from "./plays/salgsro.ts";
import { pasteItem } from "./strategies/mail.ts";
import { errMsg } from "./strategies/shared.ts";

const HOSTNAME = "127.0.0.1";
const INDEX_PATH = join(ROOT, "ui", "index.html");
const NO_STORE = { "cache-control": "no-store" };
const SKIP_REASONS = new Set(["not-user", "answered", "wrong-product", "other"]);
const LEAD_STATUSES: LeadStatus[] = ["new", "contacted", "replied", "meeting", "no_interest"];
const NOTE_MAX = 10_000;
const CAPTURE_MIN = 20;
const CAPTURE_MAX = 5000;
const CAPTURE_URL_MAX = 500;
const CAPTURE_CHANNEL_MAX = 100;
const OAUTH_REASON_MAX = 100;
/** Pending OAuth states kept per server; minting more drops the oldest. */
const OAUTH_STATES_MAX = 20;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

type Body = Record<string, unknown>;
type Ctx = {
  cfg: Config;
  now: number;
  url: URL;
  /** Lifts the idle timeout for this request (model calls take minutes). */
  noTimeout: () => void;
};
type Route = {
  method: "GET" | "POST";
  re: RegExp;
  /** Returns JSON data, or a Response (used for redirects) that is sent as is. */
  handler: (params: string[], body: Body, ctx: Ctx) => unknown;
};
/** OAuth state nonce → expiry (ms). One Map per server; a state is used once. */
type OAuthStates = Map<string, number>;

export type ServerOptions = {
  port: number;
  /** products.yaml to load (default: the repo's). Ignored when `cfg` is given. */
  configPath?: string;
  cfg?: Config;
};

const nowS = () => Math.floor(Date.now() / 1000);
const log = (m: string) => console.log(`${localTime(new Date(), true)} ${m}`);

function isLeadStatus(s: unknown): s is LeadStatus {
  return typeof s === "string" && (LEAD_STATUSES as string[]).includes(s);
}

function validWeek(w: string): boolean {
  const m = /^\d{4}-W(\d{2})$/.exec(w);
  const n = Number(m?.[1]);
  return !!m && n >= 1 && n <= 53;
}

function decodeParam(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "malformed id in URL");
  }
}

async function readBody(req: Request): Promise<Body> {
  const text = await req.text();
  if (!text.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "JSON body must be an object");
  return v as Body;
}

/**
 * Localhost guard: the Host header must name this machine (blocks DNS rebinding), and a POST that carries an
 * Origin header must come from the same origin (blocks other web pages from triggering paid model calls).
 */
function checkRequest(req: Request): void {
  const host = req.headers.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "");
  if (hostname !== "127.0.0.1" && hostname !== "localhost") throw new HttpError(403, "forbidden host");
  const origin = req.headers.get("origin");
  if (req.method !== "GET" && origin) {
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      throw new HttpError(403, "cross-origin request refused");
    }
    if (o.host !== host) throw new HttpError(403, "cross-origin request refused");
  }
}

function currentDraft(itemId: string) {
  const drafts = draftsForItem(itemId); // newest first
  return drafts.find((d) => d.variant !== "no_link") ?? drafts[0] ?? null;
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, ...NO_STORE } });
}

/** Back to the UI's Setup tab, which toasts the outcome and strips the query from the hash. */
function redirectToSetup(flag: "connected" | "error", reason?: string): Response {
  return redirect(`/#setup?gmail=${flag}${reason ? `&reason=${encodeURIComponent(reason.slice(0, OAUTH_REASON_MAX))}` : ""}`);
}

/** Validated POST /api/capture body. */
function captureInput(body: Body): { text: string; url: string | null; channel: string | null } {
  const rawText = body.text;
  if (typeof rawText !== "string") throw new HttpError(400, "text must be a string");
  const text = rawText.trim();
  if (text.length < CAPTURE_MIN) throw new HttpError(400, `text must be at least ${CAPTURE_MIN} characters`);
  if (text.length > CAPTURE_MAX) throw new HttpError(400, `text is longer than ${CAPTURE_MAX} characters`);

  let url: string | null = null;
  const rawUrl = body.url;
  if (rawUrl !== undefined && rawUrl !== null && rawUrl !== "") {
    const raw = typeof rawUrl === "string" ? rawUrl.trim() : "";
    let ok = raw.length > 0 && raw.length <= CAPTURE_URL_MAX;
    if (ok) {
      try {
        const u = new URL(raw);
        ok = u.protocol === "http:" || u.protocol === "https:";
      } catch {
        ok = false;
      }
    }
    if (!ok) throw new HttpError(400, `url must be an http(s) link of at most ${CAPTURE_URL_MAX} characters`);
    url = raw;
  }

  let channel: string | null = null;
  const rawChannel = body.channel;
  if (rawChannel !== undefined && rawChannel !== null) {
    if (typeof rawChannel !== "string" || rawChannel.length > CAPTURE_CHANNEL_MAX) {
      throw new HttpError(400, `channel must be a string of at most ${CAPTURE_CHANNEL_MAX} characters`);
    }
    channel = rawChannel.trim() || null;
  }
  return { text, url, channel };
}

function buildRoutes(researching: Set<string>, oauthStates: OAuthStates): Route[] {
  return [
    { method: "GET", re: /^\/api\/today$/, handler: (_p, _b, c) => today(c.cfg, c.now) },
    { method: "GET", re: /^\/api\/pipeline$/, handler: (_p, _b, c) => pipeline(c.cfg, c.now) },
    {
      method: "GET",
      re: /^\/api\/intel$/,
      handler: (_p, _b, c) => {
        const week = c.url.searchParams.get("week");
        if (week !== null && !validWeek(week)) throw new HttpError(400, "week must look like 2026-W45");
        return intel(c.cfg, c.now, week ?? undefined);
      },
    },
    { method: "GET", re: /^\/api\/setup$/, handler: (_p, _b, c) => setup(c.cfg, c.now) },

    // Gmail OAuth for the mail source. GET (a link in the UI and Google's redirect): only the Host check applies.
    {
      method: "GET",
      re: /^\/api\/gmail\/auth$/,
      handler: () => {
        const cfg = getGmailConfig();
        if (!isConfigured(cfg)) {
          throw new HttpError(503, "Gmail is not set up: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env and restart the UI");
        }
        const now = Date.now();
        for (const [s, expires] of oauthStates) if (expires <= now) oauthStates.delete(s);
        // At most OAUTH_STATES_MAX pending: the oldest goes first (a Map iterates in insertion order).
        while (oauthStates.size >= OAUTH_STATES_MAX) {
          const oldest = oauthStates.keys().next().value;
          if (oldest === undefined) break;
          oauthStates.delete(oldest);
        }
        const state = mintState();
        oauthStates.set(state, now + STATE_TTL_MS);
        return redirect(consentUrl(cfg, state));
      },
    },
    {
      method: "GET",
      re: /^\/api\/gmail\/callback$/,
      handler: async (_p, _b, c) => {
        const q = c.url.searchParams;
        // Only a state this server minted (unexpired, unused) gets anything but reason=state, Google's error included.
        const state = q.get("state") ?? "";
        const expires = state ? oauthStates.get(state) : undefined;
        if (expires === undefined) return redirectToSetup("error", "state");
        oauthStates.delete(state); // single use
        if (expires <= Date.now()) return redirectToSetup("error", "state");
        const error = q.get("error");
        if (error) return redirectToSetup("error", error);
        const code = q.get("code");
        if (!code) return redirectToSetup("error", "no_code");
        try {
          await exchangeCode(code);
          log("gmail: connected");
          return redirectToSetup("connected");
        } catch (e) {
          // Never log the code; the message is Google's error description.
          log(`[gmail] connect failed: ${errMsg(e)}`);
          return redirectToSetup("error", "exchange");
        }
      },
    },
    {
      method: "POST",
      re: /^\/api\/gmail\/disconnect$/,
      handler: () => {
        clearToken();
        log("gmail: disconnected");
        return { ok: true };
      },
    },
    {
      method: "POST",
      re: /^\/api\/capture$/,
      handler: (_p, body, c) => {
        const { text, url, channel } = captureInput(body);
        const item = pasteItem(text, url, channel, c.now);
        const { inserted, dups } = insertItems([item]);
        return { ok: true, id: item.id, duplicate: inserted === 0 || dups > 0, note: "Scored in the next daily run" };
      },
    },

    {
      method: "POST",
      re: /^\/api\/items\/([^/]+)\/(skip|later|posted|undo-posted)$/,
      handler: ([id = "", action = ""], body) => {
        const isItem = scoredItem(id) !== null;
        const itemsOnly = action === "posted" || action === "undo-posted";
        if (!isItem && (itemsOnly || !getLead(id))) throw new HttpError(404, `unknown item ${id}`);
        if (action === "skip") {
          const reason = body.reason ?? "other";
          if (typeof reason !== "string" || !SKIP_REASONS.has(reason)) {
            throw new HttpError(400, `reason must be one of ${[...SKIP_REASONS].join(", ")}`);
          }
          insertAction("skip", id, { reason });
          return { ok: true, state: "skipped" };
        }
        if (action === "later") {
          insertAction("later", id);
          return { ok: true, state: "later" };
        }
        if (action === "posted") {
          insertAction("posted", id);
          return { ok: true, state: "posted" };
        }
        insertAction("undo_posted", id);
        return { ok: true, state: "open" };
      },
    },

    {
      method: "POST",
      re: /^\/api\/drafts\/([^/]+)\/redraft$/,
      handler: async ([id = ""], body, c) => {
        if (!scoredItem(id) || !currentDraft(id)) throw new HttpError(404, `no draft for ${id}`);
        const direction = body.direction;
        if (typeof direction !== "string" || !direction.trim()) throw new HttpError(400, "direction must be a non-empty string");
        requireApiKey();
        c.noTimeout();
        const r = await redraft(id, direction, undefined, c.cfg);
        log(`redraft ${id} · $${r.costUsd.toFixed(4)}`);
        return { draft: { id: r.draft.id, variant: r.draft.variant, text: r.draft.text }, cost_usd: r.costUsd };
      },
    },
    {
      method: "POST",
      re: /^\/api\/drafts\/([^/]+)\/rating$/,
      handler: ([id = ""], body) => {
        const current = currentDraft(id);
        if (!current) throw new HttpError(404, `no draft for ${id}`);
        const rating = body.rating ?? null;
        if (rating !== null && rating !== "good" && rating !== "needs_work") {
          throw new HttpError(400, 'rating must be "good", "needs_work" or null');
        }
        insertAction("rating", id, { rating, draft_id: current.id });
        return { ok: true };
      },
    },

    // Registered before the /api/leads/:id/... routes (their patterns cannot match it anyway).
    {
      method: "POST",
      re: /^\/api\/leads\/export-salgsro$/,
      handler: (_p, body) => {
        const ids = body.ids;
        if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x): x is string => typeof x === "string")) {
          throw new HttpError(400, "ids must be a non-empty array of lead ids");
        }
        const unknown = ids.filter((id) => !getLead(id));
        if (unknown.length > 0) throw new HttpError(400, `unknown lead ids: ${unknown.join(", ")}`);
        const r = exportSalgsro(ids);
        log(`salgsro: wrote ${r.count} leads to ${r.path}`);
        return { path: r.path, count: r.count };
      },
    },
    {
      method: "POST",
      re: /^\/api\/leads\/([^/]+)\/status$/,
      handler: ([id = ""], body, c) => {
        if (!getLead(id)) throw new HttpError(404, `unknown lead ${id}`);
        const status = body.status;
        if (!isLeadStatus(status)) throw new HttpError(400, `status must be one of ${LEAD_STATUSES.join(", ")}`);
        setLeadStatus(id, status);
        insertAction("status", id, { status });
        return { ok: true, lead: leadView(id, c.cfg, c.now) };
      },
    },
    {
      method: "POST",
      re: /^\/api\/leads\/([^/]+)\/note$/,
      handler: ([id = ""], body) => {
        if (!getLead(id)) throw new HttpError(404, `unknown lead ${id}`);
        const note = body.note;
        if (typeof note !== "string") throw new HttpError(400, "note must be a string");
        if (note.length > NOTE_MAX) throw new HttpError(400, `note is longer than ${NOTE_MAX} characters`);
        setLeadNote(id, note);
        insertAction("note", id, { note });
        return { ok: true };
      },
    },
    {
      method: "POST",
      re: /^\/api\/leads\/([^/]+)\/research$/,
      handler: async ([id = ""], _b, c) => {
        const entity = getEntity(id);
        if (!entity) throw new HttpError(404, `unknown lead ${id}`);
        if (entity.kind === "person") throw new HttpError(400, "Off for people. We don't research individuals.");
        if (researching.has(id)) throw new HttpError(409, `research already running for ${id}`);
        requireApiKey();
        researching.add(id);
        c.noTimeout();
        try {
          // On-demand research bypasses MAX_RESEARCH_PER_DAY by design.
          const r = await researchLead(id, c.cfg, undefined, log);
          log(`research ${id}: done · $${r.costUsd.toFixed(4)}`);
          return { lead: leadView(id, c.cfg, nowS()), cost_usd: r.costUsd, downgraded: r.downgraded };
        } catch (e) {
          if (e instanceof ResearchFailed) throw new Error(`${e.message} (spent $${e.costUsd.toFixed(2)})`);
          throw e;
        } finally {
          researching.delete(id);
        }
      },
    },

    {
      method: "POST",
      re: /^\/api\/ideas\/([^/]+)\/(save|dismiss)$/,
      handler: ([id = "", action = ""], body) => {
        const week = id.split(":")[1] ?? "";
        if (!ideasForWeek(week).some((i) => i.id === id)) throw new HttpError(404, `unknown idea ${id}`);
        if (action === "dismiss") {
          insertAction("idea_dismissed", id);
          return { ok: true, state: "dismissed" };
        }
        const saved = body.saved ?? true;
        if (typeof saved !== "boolean") throw new HttpError(400, "saved must be a boolean");
        insertAction(saved ? "idea_saved" : "idea_unsaved", id);
        return { ok: true, state: saved ? "saved" : "open" };
      },
    },
  ];
}

async function handle(req: Request, srv: Server<undefined>, cfg: Config, routes: Route[]): Promise<Response> {
  const url = new URL(req.url);
  try {
    checkRequest(req);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(Bun.file(INDEX_PATH), { headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } });
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = m.slice(1).map(decodeParam);
      const body = req.method === "POST" ? await readBody(req) : {};
      const ctx: Ctx = {
        cfg,
        now: nowS(),
        url,
        noTimeout: () => {
          if (typeof srv.timeout === "function") srv.timeout(req, 0);
        },
      };
      const data = await r.handler(params, body, ctx);
      return data instanceof Response ? data : Response.json(data, { headers: NO_STORE });
    }
    throw new HttpError(404, `not found: ${req.method} ${url.pathname}`);
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status, headers: NO_STORE });
    log(`error ${req.method} ${url.pathname}: ${errMsg(e)}`);
    return Response.json({ error: errMsg(e) }, { status: 500, headers: NO_STORE });
  }
}

/** Starts the UI server on 127.0.0.1 (always; never another interface). Config is loaded once, here. */
export function createServer(opts: ServerOptions): Server<undefined> {
  const cfg = opts.cfg ?? loadConfig(opts.configPath);
  const routes = buildRoutes(new Set<string>(), new Map<string, number>());
  return Bun.serve<undefined>({
    hostname: HOSTNAME,
    port: opts.port,
    // Research and redraft lift the timeout per request; 255 s (the maximum) covers runtimes without server.timeout().
    idleTimeout: 255,
    fetch: (req, srv) => handle(req, srv, cfg, routes),
  });
}

if (import.meta.main) {
  try {
    const server = createServer({ port: UI_PORT });
    console.log(`SocialSelling UI on http://${HOSTNAME}:${server.port} (localhost only, no auth)`);
  } catch (e) {
    console.error(`ui: ${errMsg(e)}`);
    process.exit(1);
  }
}
