import { SOCIAL_WINDOW_S } from "../config.ts";
import type { Product } from "../config.ts";
import type { Item } from "../db.ts";
import { BODY_MAX, FETCH_TIMEOUT_MS, contentHash, errMsg, roundRobin, stripHtml } from "./shared.ts";
import type { CollectResult, Log, Strategy } from "./shared.ts";

const HN_PHRASE_CAP = 20;
const HN_GAP_MS = 500;
const HN_BACKOFF_MS = [2000, 6000];

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
    rating: null,
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

async function collectHn(products: Product[], now: number, log: Log): Promise<CollectResult> {
  const errors: string[] = [];
  const found = new Map<string, Item>();
  const filter = `created_at_i>${now - SOCIAL_WINDOW_S}`;
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

export const hn: Strategy = {
  id: "hn",
  enabled: () => true,
  collect: (cfg, now, log) => collectHn(cfg.products, now, log),
};
