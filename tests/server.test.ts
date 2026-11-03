import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { GMAIL_TOKEN_PATH, UI_PORT, isoWeek, localDate } from "../src/config.ts";
import { actionsFor, getLead, insertDraft, insertIdeas } from "../src/db.ts";
import { clearToken, deps, readToken } from "../src/mail/gmail.ts";
import { createServer } from "../src/server.ts";
import { minimalConfig, nowS, seedEntity, seedItem, seedLead, seedScore, tempDb } from "./helpers.ts";
import { GOOGLE_ENV, clearGoogleEnv, setGoogleEnv } from "./mail-fixtures.ts";

// Ids with ":" and "/" on purpose: the UI sends them encodeURIComponent-ed and the server decodes them.
const REPLY_ID = "reddit:t3_abc/def";
const HOT_ID = "lead_hot0000001";
const WATCH_ID = "lead_watch00002";
const PERSON_ID = "lead_person0003";
const HEADER_LINE = "Navn;Firma;E-mail;Telefon;Hjemmeside;Rolle;Fase;Noter";

const enc = encodeURIComponent;
/** Response JSON in assertions. */
type Json = any;

let t: Awaited<ReturnType<typeof tempDb>>;
let server: ReturnType<typeof createServer>;
let base = "";
let ideaId = "";

async function get(path: string): Promise<{ status: number; body: Json }> {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json() };
}

async function post(path: string, body: unknown = {}): Promise<{ status: number; body: Json }> {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

beforeAll(async () => {
  t = await tempDb();
  const now = nowS();
  seedItem({ id: REPLY_ID, title: "Looking for a simple follow-up tool", created_at: now - 2 * 3600 });
  seedScore(REPLY_ID, { tier: "asking_for_tool", confidence: 0.92 });
  insertDraft({ id: "d-default", item_id: REPLY_ID, variant: "default", direction: null, text: "Default draft https://alpha.example", model: "test", created_at: now });
  insertDraft({ id: "d-nolink", item_id: REPLY_ID, variant: "no_link", direction: null, text: "Default draft", model: "test", created_at: now });
  seedLead({ id: HOT_ID, product_id: "beta", org_name: "Hot Klub", total: 78, classification: "HOT" });
  seedLead({ id: WATCH_ID, product_id: "beta", org_name: "Watch Klub", total: 40, classification: "WATCH" });
  seedEntity({ id: PERSON_ID, kind: "person", name: "Some Person" });
  const week = isoWeek(localDate()).key;
  ideaId = `beta:${week}:0`;
  insertIdeas([
    { id: ideaId, product_id: "beta", week, title: "Comparison page vs Rival", why: "Rival lacks search", kind: "comparison_page", gap_refs: [], created_at: now },
  ]);
  server = createServer({ port: 0, cfg: minimalConfig() });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  t.cleanup();
});

describe("static", () => {
  test("GET / serves the UI", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("<title>");
  });
});

describe("today", () => {
  test("shape and counts", async () => {
    const { status, body } = await get("/api/today");
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["counts", "items", "later", "products", "run"]);
    expect(ids(body.items)).toEqual([REPLY_ID, HOT_ID, WATCH_ID]);
    expect(body.later).toEqual([]);
    expect(body.counts.open).toBe(3);
    expect(typeof body.counts.expiring_before_noon).toBe("number");
    expect(body.products.alpha.name).toBe("Alpha");
    const reply = body.items[0];
    expect(reply.kind).toBe("reply");
    expect(reply.state).toBe("open");
    expect(reply.drafts.default).toBe("Default draft https://alpha.example");
    expect(reply.drafts.no_link).toBe("Default draft");
    expect(reply.drafts.current.id).toBe("d-default");
    expect(reply.source_label).toBe("r/freelance");
    const lead = body.items[1];
    expect(lead.kind).toBe("lead");
    expect(lead.breakdown.map((b: Json) => b.key)).toEqual(["intent", "operational_pain", "mio_fit", "timing", "reachability"]);
    expect(lead.brief_note).toBe("No call brief yet. Run research to get one.");
  });

  test("later, skip, posted and undo round trips", async () => {
    const path = `/api/items/${enc(REPLY_ID)}`;

    expect((await post(`${path}/later`)).body).toEqual({ ok: true, state: "later" });
    let today = (await get("/api/today")).body;
    expect(ids(today.items)).not.toContain(REPLY_ID);
    expect(ids(today.later)).toEqual([REPLY_ID]);

    expect((await post(`${path}/skip`, { reason: "bogus" })).status).toBe(400);
    expect((await post(`${path}/skip`, { reason: "answered" })).body).toEqual({ ok: true, state: "skipped" });
    today = (await get("/api/today")).body;
    expect(ids(today.items)).not.toContain(REPLY_ID);
    expect(ids(today.later)).not.toContain(REPLY_ID);
    expect(actionsFor(REPLY_ID).at(-1)?.payload).toEqual({ reason: "answered" });

    expect((await post(`${path}/posted`)).body).toEqual({ ok: true, state: "posted" });
    expect(ids((await get("/api/today")).body.items)).not.toContain(REPLY_ID);

    expect((await post(`${path}/undo-posted`)).body).toEqual({ ok: true, state: "open" });
    today = (await get("/api/today")).body;
    expect(ids(today.items)[0]).toBe(REPLY_ID);
  });

  test("rating", async () => {
    expect((await post(`/api/drafts/${enc(REPLY_ID)}/rating`, { rating: "great" })).status).toBe(400);
    expect((await post(`/api/drafts/${enc(REPLY_ID)}/rating`, { rating: "good" })).body).toEqual({ ok: true });
    const reply = (await get("/api/today")).body.items.find((i: Json) => i.id === REPLY_ID);
    expect(reply.rating).toBe("good");
    expect(actionsFor(REPLY_ID).at(-1)?.payload).toEqual({ rating: "good", draft_id: "d-default" });
  });

  test("redraft validates without calling the model", async () => {
    expect((await post(`/api/drafts/${enc("reddit:t3_nope")}/redraft`, { direction: "shorter" })).status).toBe(404);
    expect((await post(`/api/drafts/${enc(REPLY_ID)}/redraft`, { direction: "  " })).status).toBe(400);
  });
});

describe("leads", () => {
  test("status and note", async () => {
    const path = `/api/leads/${enc(HOT_ID)}`;
    const bad = await post(`${path}/status`, { status: "won" });
    expect(bad.status).toBe(400);
    expect(typeof bad.body.error).toBe("string");

    const ok = await post(`${path}/status`, { status: "contacted" });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.lead.status).toBe("contacted");
    expect(getLead(HOT_ID)?.status).toBe("contacted");
    const pipe = (await get("/api/pipeline")).body;
    expect(pipe.leads.find((l: Json) => l.id === HOT_ID).status).toBe("contacted");
    expect(ids((await get("/api/today")).body.items)).not.toContain(HOT_ID);

    expect((await post(`${path}/note`, { note: "Ring i januar · æøå" })).body).toEqual({ ok: true });
    expect(getLead(HOT_ID)?.note).toBe("Ring i januar · æøå");
    expect((await post(`${path}/note`, { note: 5 })).status).toBe(400);
  });

  test("export-salgsro writes a CSV and marks the lead", async () => {
    expect((await post("/api/leads/export-salgsro", { ids: [] })).status).toBe(400);
    expect((await post("/api/leads/export-salgsro", { ids: ["lead_unknown"] })).status).toBe(400);

    const { status, body } = await post("/api/leads/export-salgsro", { ids: [WATCH_ID] });
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    const path: string = body.path;
    try {
      expect(path.startsWith(process.env.SALGSRO_DIR ?? "<unset>")).toBe(true);
      expect(existsSync(path)).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text.slice(1).split("\r\n")[0]).toBe(HEADER_LINE);
      expect(getLead(WATCH_ID)?.salgsro_exported_at).not.toBeNull();
      expect(ids((await get("/api/today")).body.items)).not.toContain(WATCH_ID);
      const lead = (await get("/api/pipeline")).body.leads.find((l: Json) => l.id === WATCH_ID);
      expect(lead.salgsro_path).toBe(path);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("research refuses persons and unknown ids without calling the model", async () => {
    const person = await post(`/api/leads/${enc(PERSON_ID)}/research`);
    expect(person.status).toBe(400);
    expect(person.body.error).toContain("Off for people");
    expect((await post(`/api/leads/${enc("lead_nope")}/research`)).status).toBe(404);
  });
});

describe("intel and setup", () => {
  test("intel shape, week validation, idea save/dismiss", async () => {
    const { status, body } = await get("/api/intel");
    expect(status).toBe(200);
    for (const k of ["week", "monday", "sunday", "competitors", "gaps", "praise", "switching", "ideas", "products"]) {
      expect(body).toHaveProperty(k);
    }
    expect(body.competitors.map((c: Json) => c.name)).toEqual(["Rival"]);
    expect(body.ideas.map((i: Json) => [i.id, i.state])).toEqual([[ideaId, "open"]]);

    const bad = await get("/api/intel?week=bad");
    expect(bad.status).toBe(400);
    expect(typeof bad.body.error).toBe("string");
    expect((await get(`/api/intel?week=${body.week}`)).status).toBe(200);

    expect((await post(`/api/ideas/${enc(ideaId)}/save`, { saved: true })).body).toEqual({ ok: true, state: "saved" });
    expect((await get("/api/intel")).body.ideas[0].state).toBe("saved");
    expect((await post(`/api/ideas/${enc(ideaId)}/dismiss`)).body).toEqual({ ok: true, state: "dismissed" });
    expect((await get("/api/intel")).body.ideas[0].state).toBe("dismissed");
    expect((await post(`/api/ideas/${enc("beta:2026-W01:9")}/save`)).status).toBe(404);
  });

  test("setup shape", async () => {
    const { status, body } = await get("/api/setup");
    expect(status).toBe(200);
    for (const k of ["run", "funnel", "sources", "plays", "play_locks", "products", "schedule", "runs", "caps"]) {
      expect(body).toHaveProperty(k);
    }
    expect(body.sources.find((s: Json) => s.id === "gplay").status).toBe("unavailable");
    expect(body.plays.alpha.reply_drafts).toBe(true);
    expect(body.plays.beta.lead_research).toBe(true);
    expect(body.play_locks["alpha:lead_research"]).toContain("Off for people");
    expect(body.products.map((p: Json) => p.id)).toEqual(["alpha", "beta"]);
  });
});

describe("errors", () => {
  test("unknown ids and routes are 404 JSON", async () => {
    expect((await post(`/api/items/${enc("reddit:t3_nope")}/skip`, { reason: "answered" })).status).toBe(404);
    expect((await post(`/api/items/${enc(HOT_ID)}/posted`)).status).toBe(404); // leads cannot be posted
    expect((await post(`/api/leads/${enc("lead_nope")}/status`, { status: "contacted" })).status).toBe(404);
    expect((await post(`/api/drafts/${enc("nope")}/rating`, { rating: "good" })).status).toBe(404);
    const r = await get("/api/nope");
    expect(r.status).toBe(404);
    expect(typeof r.body.error).toBe("string");
  });

  test("invalid JSON body is 400", async () => {
    const r = await post(`/api/leads/${enc(HOT_ID)}/note`, "{not json");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid JSON body");
  });

  test("cross-origin POST is refused", async () => {
    const r = await fetch(`${base}/api/items/${enc(REPLY_ID)}/later`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(r.status).toBe(403);
  });

  test("a foreign Host header is refused (DNS rebinding)", async () => {
    const r = await fetch(`${base}/api/today`, { headers: { host: "evil.example" } });
    expect(r.status).toBe(403);
  });
});

describe("gmail", () => {
  const realFetch = deps.fetch;
  /** No redirect following: the tests read the 302 Location. */
  const raw = (path: string) => fetch(base + path, { redirect: "manual" });

  afterEach(() => {
    deps.fetch = realFetch;
    clearGoogleEnv();
    clearToken();
  });

  test("auth is 503 without a Google client; the source is unavailable", async () => {
    const r = await raw("/api/gmail/auth");
    expect(r.status).toBe(503);
    expect(typeof ((await r.json()) as Json).error).toBe("string");
    const setup = (await get("/api/setup")).body;
    expect(setup.gmail.state).toBe("not_configured");
    expect(setup.sources.find((s: Json) => s.id === "mail").status).toBe("unavailable");
  });

  test("auth redirects to Google's consent screen with a state", async () => {
    setGoogleEnv();
    const r = await raw("/api/gmail/auth");
    expect(r.status).toBe(302);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const loc = new URL(r.headers.get("location") ?? "");
    expect(loc.host).toBe("accounts.google.com");
    expect(loc.searchParams.get("client_id")).toBe(GOOGLE_ENV.GOOGLE_CLIENT_ID);
    expect(loc.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${UI_PORT}/api/gmail/callback`);
    expect(loc.searchParams.get("state")?.length ?? 0).toBeGreaterThan(10);
    expect(loc.searchParams.has("client_secret")).toBe(false);
  });

  test("callback: unknown state is refused, also with an error; Google's error needs a known state", async () => {
    let r = await raw("/api/gmail/callback?state=nope&code=abc");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/#setup?gmail=error&reason=state");
    r = await raw("/api/gmail/callback?error=access_denied&state=nope");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/#setup?gmail=error&reason=state");

    setGoogleEnv();
    const auth = await raw("/api/gmail/auth");
    const state = new URL(auth.headers.get("location") ?? "").searchParams.get("state") ?? "";
    r = await raw(`/api/gmail/callback?error=access_denied&state=${enc(state)}`);
    expect(r.headers.get("location")).toBe("/#setup?gmail=error&reason=access_denied");
    // The state was used up.
    r = await raw(`/api/gmail/callback?error=access_denied&state=${enc(state)}`);
    expect(r.headers.get("location")).toBe("/#setup?gmail=error&reason=state");
  });

  test("at most 20 pending states: minting more drops the oldest", async () => {
    setGoogleEnv();
    const states: string[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await raw("/api/gmail/auth");
      states.push(new URL(r.headers.get("location") ?? "").searchParams.get("state") ?? "");
    }
    const oldest = await raw(`/api/gmail/callback?error=access_denied&state=${enc(states[0]!)}`);
    expect(oldest.headers.get("location")).toBe("/#setup?gmail=error&reason=state");
    const newest = await raw(`/api/gmail/callback?error=access_denied&state=${enc(states[20]!)}`);
    expect(newest.headers.get("location")).toBe("/#setup?gmail=error&reason=access_denied");
  });

  test("connect flow, setup status, state replay and disconnect", async () => {
    setGoogleEnv();
    const auth = await raw("/api/gmail/auth");
    const state = new URL(auth.headers.get("location") ?? "").searchParams.get("state") ?? "";
    expect(state).not.toBe("");

    const calls: string[] = [];
    deps.fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.get("code") !== "the-code" || body.get("grant_type") !== "authorization_code") {
          return Response.json({ error: "invalid_request" }, { status: 400 });
        }
        return Response.json({ access_token: "a-1", refresh_token: "r-1", expires_in: 3600 });
      }
      if (url.endsWith("/gmail/v1/users/me/profile")) return Response.json({ emailAddress: "me@example.com" });
      return Response.json({ error: { message: "unexpected" } }, { status: 500 });
    };

    const cb = await raw(`/api/gmail/callback?state=${enc(state)}&code=the-code`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/#setup?gmail=connected");
    const saved = readToken();
    expect(saved?.refresh_token).toBe("r-1");
    expect(saved?.email).toBe("me@example.com");
    expect(calls).toHaveLength(2);

    const replay = await raw(`/api/gmail/callback?state=${enc(state)}&code=the-code`);
    expect(replay.headers.get("location")).toBe("/#setup?gmail=error&reason=state");
    expect(calls).toHaveLength(2);

    const setup = (await get("/api/setup")).body;
    expect(setup.gmail.state).toBe("connected");
    expect(setup.gmail.email).toBe("me@example.com");
    const row = setup.sources.find((s: Json) => s.id === "mail");
    expect(row.status).toBe("on");
    expect(row.note).toContain('label "Signals"');

    expect((await post("/api/gmail/disconnect")).body).toEqual({ ok: true });
    expect(existsSync(GMAIL_TOKEN_PATH)).toBe(false);
    expect((await get("/api/setup")).body.gmail.state).toBe("not_connected");
  });
});

describe("capture", () => {
  const TEXT = "Hej alle, hvad bruger I til vagtplaner i jeres forening? Vi drukner i regneark.";

  test("validation", async () => {
    expect((await post("/api/capture", { text: "for kort" })).status).toBe(400);
    expect((await post("/api/capture", { text: 5 })).status).toBe(400);
    expect((await post("/api/capture", { text: "x".repeat(5001) })).status).toBe(400);
    expect((await post("/api/capture", { text: TEXT, url: "javascript:alert(1)" })).status).toBe(400);
    expect((await post("/api/capture", { text: TEXT, url: "not a url" })).status).toBe(400);
    expect((await post("/api/capture", { text: TEXT, url: `https://example.com/${"x".repeat(500)}` })).status).toBe(400);
    expect((await post("/api/capture", { text: TEXT, channel: 5 })).status).toBe(400);
  });

  test("stores a mail item without author; a repeat is a duplicate", async () => {
    const url = "https://www.facebook.com/groups/1/posts/2/";
    const r = await post("/api/capture", { text: `  ${TEXT}  `, url, channel: " Foreningsledere DK " });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.duplicate).toBe(false);
    expect(r.body.note).toBe("Scored in the next daily run");
    expect(r.body.id.startsWith("mail:paste:")).toBe(true);
    const row = t.db
      .query<{ source: string; kind: string; author: string; found_via: string; subreddit: string; body: string; url: string }, [string]>(
        "SELECT source, kind, author, found_via, subreddit, body, url FROM items WHERE id = ?",
      )
      .get(r.body.id);
    expect(row).toEqual({ source: "mail", kind: "post", author: "", found_via: "paste", subreddit: "Foreningsledere DK", body: TEXT, url });

    const again = await post("/api/capture", { text: TEXT });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.id).toBe(r.body.id);
  });

  test("cross-origin capture is refused", async () => {
    const r = await fetch(`${base}/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ text: TEXT }),
    });
    expect(r.status).toBe(403);
  });
});
