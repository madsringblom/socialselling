import { REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME } from "./config.ts";
import type { Product } from "./config.ts";
import type { Item } from "./db.ts";

/** errors count toward the run's error total; notes are informational. */
export type CollectResult = { items: Item[]; errors: string[]; notes: string[] };
type Log = (msg: string) => void;

export const WINDOW_S = 36 * 3600;
const BODY_MAX = 1500;
const REMOVED = new Set(["[removed]", "[deleted]"]);

const REDDIT_API = "https://oauth.reddit.com";
const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_TOKEN_MARGIN_MS = 60_000;
const REDDIT_MIN_GAP_MS = 1000;
const REDDIT_JITTER_MS = 300;
const REDDIT_BACKOFF_S = [5, 15, 45];
const REDDIT_RETRY_AFTER_CAP_S = 60;
const REDDIT_RATELIMIT_FLOOR = 5;
const REDDIT_RATELIMIT_MAX_WAIT_S = 600;
const REDDIT_MAX_CONSECUTIVE_FAILURES = 3;
export const REDDIT_SKIPPED_NOTE = "reddit skipped: set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env";
const REDDIT_NEW_MAX_PAGES = 2;
const REDDIT_PHRASES_PER_QUERY = 4;
const REDDIT_SITEWIDE_CAP = 15;
const THREAD_CONTEXT_CAP = 40;
const THREAD_REPLIES = 3;
const THREAD_REPLY_MAX = 300;

const HN_PHRASE_CAP = 20;
const HN_GAP_MS = 500;
const HN_BACKOFF_MS = [2000, 6000];

const FETCH_TIMEOUT_MS = 20_000;

export function contentHash(title: string, body: string): string {
  const norm = `${title}\n${body}`.toLowerCase().replace(/\s+/g, " ").trim();
  return new Bun.CryptoHasher("sha1").update(norm).digest("hex");
}

function roundRobin(lists: string[][], cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < cap; i++) {
    for (const list of lists) {
      const v = list[i];
      if (!v || seen.has(v.toLowerCase()) || out.length >= cap) continue;
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

function uniqueSubreddits(products: Product[]): string[] {
  const seen = new Map<string, string>();
  for (const p of products) for (const s of p.subreddits) if (!seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
  return [...seen.values()];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------- Reddit ----------

type RedditData = {
  name?: string;
  id?: string;
  title?: string;
  selftext?: string;
  body?: string;
  author?: string;
  subreddit?: string;
  permalink?: string;
  created_utc?: number;
  num_comments?: number;
  ups?: number;
  locked?: boolean;
  link_title?: string;
  link_id?: string;
  link_permalink?: string;
  crosspost_parent_list?: RedditData[];
};
type RedditListing = { data?: { children?: { kind: string; data: RedditData }[]; after?: string | null } };

type RedditCtx = { errors: string[]; consecutiveFailures: number; aborted: boolean };

const newRedditCtx = (): RedditCtx => ({ errors: [], consecutiveFailures: 0, aborted: false });

let redditQueue: Promise<unknown> = Promise.resolve();
let redditNextSlot = 0;

type RedditToken = { value: string; expiresAt: number };
let redditToken: RedditToken | null = null;
/** Set once Reddit is unusable for this run (no credentials, or the token request failed). */
let redditDisabled: string | null = null;

const redditConfigured = () => Boolean(REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET);
const redditUserAgent = () => `macos:socialselling-validation:v0.1 (by /u/${REDDIT_USERNAME || "anonymous"})`;

function redditHeaders(token: string): Record<string, string> {
  return {
    Authorization: `bearer ${token}`,
    "User-Agent": redditUserAgent(),
    Accept: "application/json",
  };
}

/** App-only OAuth token (script app, client_credentials grant). Throws on any failure. */
async function requestRedditToken(): Promise<RedditToken> {
  const basic = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(REDDIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "User-Agent": redditUserAgent(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!json.access_token) throw new Error(json.error ? `error "${json.error}"` : "response had no access_token");
  const ttlMs = (typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600) * 1000;
  return { value: json.access_token, expiresAt: Date.now() + Math.max(ttlMs - REDDIT_TOKEN_MARGIN_MS, ttlMs / 2) };
}

/** Cached token, fetched lazily and refreshed when expired or when `force` is set. Null aborts the pass. */
async function getRedditToken(ctx: RedditCtx, force = false): Promise<string | null> {
  if (redditDisabled) {
    ctx.aborted = true;
    return null;
  }
  if (!force && redditToken && Date.now() < redditToken.expiresAt) return redditToken.value;
  try {
    redditToken = await requestRedditToken();
    return redditToken.value;
  } catch (e) {
    redditDisabled = errMsg(e);
    redditToken = null;
    ctx.aborted = true;
    ctx.errors.push(`reddit skipped: access token request failed: ${redditDisabled}`);
    return null;
  }
}

/** ms to wait before the next request if Reddit says the rate-limit window is nearly used up. */
function rateLimitPauseMs(res: Response): number {
  const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? Number.NaN);
  const reset = Number(res.headers.get("x-ratelimit-reset") ?? Number.NaN);
  if (!Number.isFinite(remaining) || remaining >= REDDIT_RATELIMIT_FLOOR || !Number.isFinite(reset) || reset < 0) return 0;
  return Math.min(reset, REDDIT_RATELIMIT_MAX_WAIT_S) * 1000;
}

/**
 * Every Reddit request goes through this single sequential queue with a 1s+jitter gap,
 * stretched to the rate-limit reset when fewer than 5 requests remain in the window.
 */
function redditFetch(url: string, token: string): Promise<Response | Error> {
  const run = redditQueue.then(async () => {
    const wait = redditNextSlot - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    let pause = 0;
    try {
      const res = await fetch(url, { headers: redditHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      pause = rateLimitPauseMs(res);
      return res;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    } finally {
      redditNextSlot = Date.now() + Math.max(pause, REDDIT_MIN_GAP_MS + Math.random() * REDDIT_JITTER_MS);
    }
  });
  redditQueue = run.catch(() => undefined);
  return run;
}

function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const secs = /^\d+$/.test(raw.trim()) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs, REDDIT_RETRY_AFTER_CAP_S) : null;
}

function redditFail(ctx: RedditCtx, msg: string): null {
  ctx.errors.push(`reddit ${msg}`);
  ctx.consecutiveFailures++;
  if (ctx.consecutiveFailures >= REDDIT_MAX_CONSECUTIVE_FAILURES && !ctx.aborted) {
    ctx.aborted = true;
    ctx.errors.push(`reddit: aborted pass after ${REDDIT_MAX_CONSECUTIVE_FAILURES} consecutive failures`);
  }
  return null;
}

async function redditGet(path: string, ctx: RedditCtx): Promise<unknown> {
  if (ctx.aborted) return null;
  const url = `${REDDIT_API}${path}${path.includes("?") ? "&" : "?"}raw_json=1`;
  let retries = 0;
  let refreshed = false;
  for (;;) {
    const token = await getRedditToken(ctx);
    if (!token) return null;
    const res = await redditFetch(url, token);
    if (!(res instanceof Error) && res.ok) {
      try {
        const json: unknown = await res.json();
        ctx.consecutiveFailures = 0;
        return json;
      } catch {
        return redditFail(ctx, `${path}: response was not JSON`);
      }
    }
    const status = res instanceof Error ? 0 : res.status;
    if (!(res instanceof Error)) await res.body?.cancel().catch(() => undefined);
    if (status === 401 && !refreshed) {
      refreshed = true;
      if (!(await getRedditToken(ctx, true))) return null;
      continue;
    }
    if ((status === 0 || status === 429 || status >= 500) && retries < REDDIT_BACKOFF_S.length) {
      const wait = (res instanceof Error ? null : retryAfterSeconds(res)) ?? REDDIT_BACKOFF_S[retries]!;
      retries++;
      await Bun.sleep(wait * 1000);
      continue;
    }
    return redditFail(ctx, `${path}: ${res instanceof Error ? res.message : `HTTP ${status}`}`);
  }
}

function normalizeReddit(kind: string, d: RedditData, foundVia: string, now: number): Item | null {
  if (kind !== "t3" && kind !== "t1") return null;
  if (!d.name || d.created_utc == null) return null;
  const isPost = kind === "t3";
  const title = (isPost ? d.title : d.link_title) ?? "";
  const body = (isPost ? d.selftext : d.body) ?? "";
  const author = d.author ?? "";
  if (REMOVED.has(title.trim()) || REMOVED.has(body.trim()) || REMOVED.has(author)) return null;
  const url = d.permalink ? `https://www.reddit.com${d.permalink}` : (d.link_permalink ?? "");
  if (!url) return null;
  return {
    id: `reddit:${d.name}`,
    source: "reddit",
    kind: isPost ? "post" : "comment",
    url,
    title,
    body: body.slice(0, BODY_MAX),
    author,
    subreddit: d.subreddit ?? "",
    parent_id: isPost ? null : (d.link_id ?? null),
    created_at: Math.floor(d.created_utc),
    fetched_at: now,
    found_via: foundVia,
    num_comments: d.num_comments ?? 0,
    score_ups: d.ups ?? 0,
    locked: d.locked === true,
    content_hash: contentHash(title, body),
    lang: null,
  };
}

/** Adds listing children to `found` (first sighting wins). Returns oldest created_utc and the `after` cursor. */
function addListing(
  json: unknown,
  foundVia: string,
  found: Map<string, Item>,
  now: number,
): { oldest: number; after: string | null } {
  const data = (json as RedditListing | null)?.data;
  let oldest = Number.POSITIVE_INFINITY;
  for (const child of data?.children ?? []) {
    const { kind, data } = child;
    if (typeof data.created_utc === "number") oldest = Math.min(oldest, data.created_utc);
    const canonical = (kind === "t3" ? data.crosspost_parent_list?.[0] : undefined) ?? data;
    const item = normalizeReddit(kind, canonical, foundVia, now);
    if (item && !found.has(item.id)) found.set(item.id, item);
  }
  return { oldest, after: data?.after ?? null };
}

export async function collectReddit(products: Product[], now: number, log: Log): Promise<CollectResult> {
  if (!redditConfigured()) {
    redditDisabled = "no credentials";
    log("reddit: skipped (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not set)");
    return { items: [], errors: [], notes: [REDDIT_SKIPPED_NOTE] };
  }
  const ctx = newRedditCtx();
  const found = new Map<string, Item>();
  const cutoff = now - WINDOW_S;
  const subs = uniqueSubreddits(products);
  const nonEnglishSubs = new Set(products.flatMap((p) => p.non_english_subreddits.map((s) => s.toLowerCase())));
  const enc = encodeURIComponent;

  for (const sub of subs) {
    let after: string | null = null;
    for (let page = 0; page < REDDIT_NEW_MAX_PAGES && !ctx.aborted; page++) {
      const json = await redditGet(`/r/${sub}/new?limit=100${after ? `&after=${enc(after)}` : ""}`, ctx);
      if (!json) break;
      const res = addListing(json, `new:r/${sub}`, found, now);
      if (!res.after || res.oldest < cutoff) break;
      after = res.after;
    }
    if (ctx.aborted) break;
  }
  log(`reddit: new posts done (${found.size} items)`);

  outer: for (const p of products) {
    for (const sub of p.subreddits) {
      // English phrases are pointless in non-English subs; their new posts and comments are still collected.
      if (nonEnglishSubs.has(sub.toLowerCase())) continue;
      for (const phrases of chunk(p.search_phrases, REDDIT_PHRASES_PER_QUERY)) {
        if (ctx.aborted) break outer;
        const q = `(${phrases.map((s) => `"${s}"`).join(" OR ")})`;
        const json = await redditGet(`/r/${sub}/search?q=${enc(q)}&restrict_sr=1&sort=new&t=week&limit=50`, ctx);
        if (json) addListing(json, `search:r/${sub}`, found, now);
      }
    }
  }
  log(`reddit: subreddit search done (${found.size} items)`);

  for (const phrase of roundRobin(products.map((p) => p.search_phrases), REDDIT_SITEWIDE_CAP)) {
    if (ctx.aborted) break;
    const json = await redditGet(`/search?q=${enc(`"${phrase}"`)}&sort=new&t=day&limit=50`, ctx);
    if (json) addListing(json, `site:${phrase}`, found, now);
  }
  log(`reddit: site-wide search done (${found.size} items)`);

  for (const sub of subs) {
    if (ctx.aborted) break;
    const json = await redditGet(`/r/${sub}/comments?limit=100`, ctx);
    if (json) addListing(json, `comments:r/${sub}`, found, now);
  }
  log(`reddit: comments done (${found.size} items, ${ctx.errors.length} errors)`);

  return { items: [...found.values()], errors: ctx.errors, notes: [] };
}

/** Top replies for Reddit posts with comments (max 40 fetches). Keyed by item id. */
export async function fetchThreadContext(
  items: Item[],
  log: Log,
): Promise<{ replies: Map<string, string[]>; errors: string[] }> {
  const ctx = newRedditCtx();
  const replies = new Map<string, string[]>();
  if (!redditConfigured() || redditDisabled) {
    log("reddit: thread context skipped (Reddit unavailable this run)");
    return { replies, errors: [] };
  }
  const targets = items
    .filter((it) => it.source === "reddit" && it.kind === "post" && it.num_comments > 0)
    .slice(0, THREAD_CONTEXT_CAP);
  for (const it of targets) {
    if (ctx.aborted) break;
    const postId = it.id.replace(/^reddit:t3_/, "");
    const json = await redditGet(`/comments/${postId}?limit=5&depth=1&sort=top`, ctx);
    if (!Array.isArray(json)) continue;
    const comments = (json[1] as RedditListing | undefined)?.data?.children ?? [];
    const bodies = comments
      .filter((c) => c.kind === "t1")
      .map((c) => c.data)
      .filter((d) => d.body && !REMOVED.has(d.body.trim()) && d.author !== "AutoModerator")
      .slice(0, THREAD_REPLIES)
      .map((d) => d.body!.replace(/\s+/g, " ").trim().slice(0, THREAD_REPLY_MAX));
    if (bodies.length) replies.set(it.id, bodies);
  }
  log(`reddit: thread context for ${replies.size}/${targets.length} posts`);
  return { replies, errors: ctx.errors };
}

// ---------- Hacker News ----------

type HnHit = {
  objectID: string;
  title?: string | null;
  story_title?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
  author?: string | null;
  created_at_i?: number;
  story_id?: number | null;
  num_comments?: number | null;
  points?: number | null;
  _tags?: string[];
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith("#")) {
      const code = e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripHtml(html: string): string {
  const text = html
    .replace(/<p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeHn(hit: HnHit, foundVia: string, now: number): Item | null {
  if (!hit.objectID || !hit.created_at_i) return null;
  const isComment = hit._tags?.includes("comment") ?? false;
  const body = stripHtml((isComment ? hit.comment_text : hit.story_text) ?? "");
  const title = hit.title || hit.story_title || "";
  if (!title && !body) return null;
  return {
    id: `hn:${hit.objectID}`,
    source: "hn",
    kind: isComment ? "comment" : "post",
    url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    title,
    body: body.slice(0, BODY_MAX),
    author: hit.author ?? "",
    subreddit: "hn",
    parent_id: isComment && hit.story_id ? `hn:${hit.story_id}` : null,
    created_at: hit.created_at_i,
    fetched_at: now,
    found_via: foundVia,
    num_comments: hit.num_comments ?? 0,
    score_ups: hit.points ?? 0,
    locked: false,
    content_hash: contentHash(title, body),
    lang: null,
  };
}

async function hnSearch(params: Record<string, string>, label: string, errors: string[]): Promise<HnHit[] | null> {
  const url = `https://hn.algolia.com/api/v1/search_by_date?${new URLSearchParams(params)}`;
  let last = "";
  for (let attempt = 0; attempt <= HN_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) await Bun.sleep(HN_BACKOFF_MS[attempt - 1]!);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return ((await res.json()) as { hits?: HnHit[] }).hits ?? [];
      last = `HTTP ${res.status}`;
      await res.body?.cancel().catch(() => undefined);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      last = errMsg(e);
    }
  }
  errors.push(`hn ${label}: ${last}`);
  return null;
}

export async function collectHn(products: Product[], now: number, log: Log): Promise<CollectResult> {
  const errors: string[] = [];
  const found = new Map<string, Item>();
  const filter = `created_at_i>${now - WINDOW_S}`;
  const add = (hits: HnHit[] | null, via: string) => {
    for (const hit of hits ?? []) {
      const item = normalizeHn(hit, via, now);
      if (item && !found.has(item.id)) found.set(item.id, item);
    }
  };

  const phrases = roundRobin(products.map((p) => p.search_phrases), HN_PHRASE_CAP);
  for (const [i, phrase] of phrases.entries()) {
    if (i > 0) await Bun.sleep(HN_GAP_MS);
    const hits = await hnSearch(
      { query: phrase, tags: "(story,comment,ask_hn)", numericFilters: filter, hitsPerPage: "100" },
      `"${phrase}"`,
      errors,
    );
    add(hits, `hn:${phrase}`);
  }
  await Bun.sleep(HN_GAP_MS);
  add(await hnSearch({ tags: "ask_hn", numericFilters: filter, hitsPerPage: "100" }, "ask_hn", errors), "hn:ask_hn");

  log(`hn: done (${found.size} items, ${errors.length} errors)`);
  return { items: [...found.values()], errors, notes: [] };
}
