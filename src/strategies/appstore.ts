import { SLOW_WINDOW_S } from "../config.ts";
import type { Item } from "../db.ts";
import { BODY_MAX, contentHash, errMsg, fetchPolite } from "./shared.ts";
import type { CollectResult, Strategy } from "./shared.ts";

const PAGES_PER_STOREFRONT = 2; // 50 reviews/page
const REVIEWS_PER_PAGE = 50;
const REVIEW_WINDOW_S = SLOW_WINDOW_S; // 30d; first run backfills, later runs rely on INSERT OR IGNORE by id

type AppleLabel = { label?: string };
type AppleLink = { attributes?: { href?: string } };
type AppleEntry = {
  id?: AppleLabel;
  updated?: AppleLabel;
  "im:rating"?: AppleLabel;
  "im:version"?: AppleLabel;
  title?: AppleLabel;
  content?: AppleLabel;
  author?: { name?: AppleLabel };
  link?: AppleLink | AppleLink[];
};
type AppleFeed = { feed?: { entry?: AppleEntry | AppleEntry[] } };

const reviewsUrl = (cc: string, appId: string, page: number) =>
  `https://itunes.apple.com/${cc}/rss/customerreviews/page=${page}/id=${appId}/sortBy=mostRecent/json`;

/** null for entries that are not reviews (the app metadata entry has no im:rating) or lack an id/date. */
function normalizeReview(e: AppleEntry, competitor: string, cc: string, appId: string, now: number): Item | null {
  const ratingLabel = e["im:rating"]?.label;
  const reviewId = e.id?.label;
  if (ratingLabel == null || !reviewId) return null;
  const createdMs = Date.parse(e.updated?.label ?? "");
  if (!Number.isFinite(createdMs)) return null;
  const links = Array.isArray(e.link) ? e.link : e.link ? [e.link] : [];
  const href = links.find((l) => l.attributes?.href)?.attributes?.href;
  const title = e.title?.label ?? "";
  const body = (e.content?.label ?? "").slice(0, BODY_MAX);
  const author = e.author?.name?.label ?? "";
  const rating = Number.parseInt(ratingLabel, 10);
  return {
    id: `appstore:${cc}:${reviewId}`,
    source: "appstore",
    kind: "review",
    url: href ?? `https://apps.apple.com/${cc}/app/id${appId}?see-all=reviews`,
    title,
    body,
    author,
    subreddit: competitor,
    parent_id: null,
    created_at: Math.floor(createdMs / 1000),
    fetched_at: now,
    found_via: `appstore:${competitor}:${cc}`,
    num_comments: 0,
    score_ups: 0,
    locked: false,
    content_hash: contentHash(`${author} ${title}`, body),
    lang: null,
    rating: Number.isFinite(rating) ? rating : null,
  };
}

/** Parsed page, or a short error message. */
async function fetchPage(url: string): Promise<AppleFeed | null | string> {
  let res: Response;
  try {
    res = await fetchPolite(url, "application/json");
  } catch (e) {
    return errMsg(e);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return `HTTP ${res.status}`;
  }
  try {
    return (await res.json()) as AppleFeed | null;
  } catch {
    return "response was not JSON";
  }
}

export const appstore: Strategy = {
  id: "appstore",
  enabled: (cfg) =>
    cfg.products.some((p) => p.competitors.some((c) => c.app_store))
      ? true
      : "appstore skipped: no competitors[].app_store in products.yaml",
  async collect(cfg, now, log): Promise<CollectResult> {
    const errors: string[] = [];
    const notes: string[] = [];
    const found = new Map<string, Item>();
    const cutoff = now - REVIEW_WINDOW_S;
    const fetched = new Set<string>();

    if (cfg.products.some((p) => p.competitors.some((c) => c.google_play))) {
      notes.push("appstore: google_play ids are accepted but not collected yet (no official feed)");
    }

    for (const p of cfg.products) {
      for (const c of p.competitors) {
        if (!c.app_store) continue;
        const appId = c.app_store.id;
        for (const cc of c.app_store.countries) {
          // Two products may list the same competitor; fetch each storefront once.
          if (fetched.has(`${appId}:${cc}`)) continue;
          fetched.add(`${appId}:${cc}`);
          for (let page = 1; page <= PAGES_PER_STOREFRONT; page++) {
            const json = await fetchPage(reviewsUrl(cc, appId, page));
            if (typeof json === "string") {
              errors.push(`appstore ${c.name}/${cc} p${page}: ${json}`);
              break;
            }
            const raw = json?.feed?.entry;
            const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
            let reviews = 0;
            let oldest = Number.POSITIVE_INFINITY;
            for (const e of entries) {
              const item = normalizeReview(e, c.name, cc, appId, now);
              if (!item) continue;
              reviews++;
              oldest = Math.min(oldest, item.created_at);
              if (item.created_at < cutoff) continue;
              if (!found.has(item.id)) found.set(item.id, item);
            }
            if (reviews < REVIEWS_PER_PAGE || oldest < cutoff) break;
          }
        }
      }
    }

    log(`appstore: done (${found.size} reviews, ${errors.length} errors)`);
    return { items: [...found.values()], errors, notes };
  },
};
