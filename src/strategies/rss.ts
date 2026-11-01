import type { Item } from "../db.ts";
import { isFeedXml, parseFeed } from "./feedparse.ts";
import type { FeedEntry } from "./feedparse.ts";
import { BODY_MAX, contentHash, errMsg, fetchPolite, roundRobin } from "./shared.ts";
import type { CollectResult, Strategy } from "./shared.ts";

const QUERY_CAP = 20;
const FEED_CAP = 20;
const ARTICLE_WINDOW_S = 7 * 86400;
const FEED_ACCEPT = "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1";

const bingUrl = (q: string) =>
  `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=da&cc=dk`;

/** Bing wraps links in news/apiclick.aspx?...&url=<real>; return the real URL. */
function unwrapBing(link: string): string {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return link;
  }
  if (!/(^|\.)bing\.com$/i.test(u.hostname) || !/\/news\/apiclick\.aspx$/i.test(u.pathname)) return link;
  const real = u.searchParams.get("url");
  return real && /^https?:\/\//i.test(real) ? real : link;
}

const sha1 = (s: string) => new Bun.CryptoHasher("sha1").update(s).digest("hex");

function normalizeArticle(e: FeedEntry, channel: string, foundVia: string, now: number): Item | null {
  const link = unwrapBing(e.link).replace(/#.*$/, "");
  if (!link) return null;
  const createdAt = e.published ?? now;
  if (createdAt < now - ARTICLE_WINDOW_S) return null;
  const body = e.summary.slice(0, BODY_MAX);
  return {
    id: `rss:${sha1(link)}`,
    source: "rss",
    kind: "article",
    url: link,
    title: e.title,
    body,
    author: e.author,
    subreddit: channel,
    parent_id: null,
    created_at: createdAt,
    fetched_at: now,
    found_via: foundVia,
    num_comments: 0,
    score_ups: 0,
    locked: false,
    content_hash: contentHash(e.title, body),
    lang: null,
    rating: null,
  };
}

/** Feed entries, or a short error message. No retries. */
async function fetchFeed(url: string): Promise<FeedEntry[] | string> {
  let res: Response;
  try {
    res = await fetchPolite(url, FEED_ACCEPT);
  } catch (e) {
    return errMsg(e);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return `HTTP ${res.status}`;
  }
  let xml: string;
  try {
    xml = await res.text();
  } catch (e) {
    return errMsg(e);
  }
  if (!isFeedXml(xml)) return "not a feed";
  return parseFeed(xml);
}

export const rss: Strategy = {
  id: "rss",
  enabled: (cfg) =>
    cfg.products.some((p) => p.news_queries.length > 0) || cfg.feeds.length > 0
      ? true
      : "rss skipped: no news_queries or feeds in products.yaml",
  async collect(cfg, now, log): Promise<CollectResult> {
    const errors: string[] = [];
    const notes: string[] = [];
    const found = new Map<string, Item>();
    const add = (entries: FeedEntry[], channel: string, via: string) => {
      for (const e of entries) {
        const item = normalizeArticle(e, channel, via, now);
        if (item && !found.has(item.id)) found.set(item.id, item);
      }
    };

    const lists = cfg.products.map((p) => p.news_queries);
    const allQueries = roundRobin(lists, Number.POSITIVE_INFINITY);
    const queries = allQueries.slice(0, QUERY_CAP);
    if (allQueries.length > QUERY_CAP) {
      notes.push(`rss: ${allQueries.length - QUERY_CAP} news queries over the cap of ${QUERY_CAP} were skipped`);
    }
    for (const q of queries) {
      const res = await fetchFeed(bingUrl(q));
      if (typeof res === "string") errors.push(`rss bing "${q}": ${res}`);
      else add(res, q, `bing:${q}`);
    }

    if (cfg.feeds.length > FEED_CAP) {
      notes.push(`rss: ${cfg.feeds.length - FEED_CAP} feeds over the cap of ${FEED_CAP} were skipped`);
    }
    for (const f of cfg.feeds.slice(0, FEED_CAP)) {
      const res = await fetchFeed(f.url);
      if (typeof res === "string") errors.push(`rss feed "${f.name}": ${res}`);
      else add(res, f.name, `feed:${f.name}`);
    }

    log(`rss: done (${found.size} articles, ${errors.length} errors)`);
    return { items: [...found.values()], errors, notes };
  },
};
