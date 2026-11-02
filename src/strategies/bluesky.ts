import { SOCIAL_WINDOW_S } from "../config.ts";
import type { Item } from "../db.ts";
import { phraseRe } from "../prefilter.ts";
import { BODY_MAX, contentHash, errMsg, fetchPolite, roundRobin } from "./shared.ts";
import type { CollectResult, Strategy } from "./shared.ts";

const BLUESKY_PHRASE_CAP = 20;
const BLUESKY_DANISH_CAP = 20;
const LIMIT = 50;
const TITLE_MAX = 80;
const FUTURE_SLACK_S = 5 * 60;
// public.api.bsky.app answers searchPosts with 403; api.bsky.app allows it without auth (first page only).
const HOST = "https://api.bsky.app";

type StrongRef = { uri?: string; cid?: string };
type PostView = {
  uri?: string;
  cid?: string;
  author?: { did?: string; handle?: string; displayName?: string };
  record?: {
    $type?: string;
    text?: string;
    createdAt?: string;
    langs?: string[];
    reply?: { parent?: StrongRef; root?: StrongRef };
  };
  replyCount?: number;
  likeCount?: number;
  repostCount?: number;
  indexedAt?: string;
};
type SearchResponse = { posts?: PostView[]; hitsTotal?: number; cursor?: string };
type Query = { phrase: string; lang: string | undefined };

const POST_URI_RE = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/;

/** did and rkey of an at://<did>/app.bsky.feed.post/<rkey> uri, or null. */
function parsePostUri(uri: string | undefined): { did: string; rkey: string } | null {
  const m = POST_URI_RE.exec(uri ?? "");
  const did = m?.[1];
  const rkey = m?.[2];
  return did && rkey ? { did, rkey } : null;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function titleFrom(text: string): string {
  const first = oneLine(text.split("\n")[0] ?? "");
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX)}…` : first;
}

/** Unix seconds of the post; createdAt unless missing or in the future, then indexedAt. */
function createdAt(post: PostView, now: number): number | null {
  let ms = Date.parse(post.record?.createdAt ?? "");
  if (!Number.isFinite(ms) || ms > (now + FUTURE_SLACK_S) * 1000) ms = Date.parse(post.indexedAt ?? "");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function normalizePost(post: PostView, phrase: string, re: RegExp, own: Set<string>, now: number): Item | null {
  const ref = parsePostUri(post.uri);
  if (!ref) return null;
  const handle = post.author?.handle ?? "";
  const did = post.author?.did || ref.did;
  if (own.has(handle.toLowerCase()) || own.has(did.toLowerCase())) return null;
  const text = (post.record?.text ?? "").trim();
  if (!text) return null;

  let parentId: string | null = null;
  const reply = post.record?.reply;
  if (reply) {
    // Search matches replies on loose terms; keep only replies that contain the phrase itself.
    if (!re.test(text)) return null;
    const parent = parsePostUri(reply.parent?.uri);
    parentId = parent ? `bluesky:${parent.did}:${parent.rkey}` : null;
  }

  const created = createdAt(post, now);
  if (created == null || created < now - SOCIAL_WINDOW_S) return null;

  const profile = handle && handle !== "handle.invalid" ? handle : did;
  return {
    // rkeys are only unique per account, so the id carries the did too.
    id: `bluesky:${ref.did}:${ref.rkey}`,
    source: "bluesky",
    kind: "post",
    url: `https://bsky.app/profile/${profile}/post/${ref.rkey}`,
    title: titleFrom(text),
    body: text.slice(0, BODY_MAX),
    author: handle,
    subreddit: phrase,
    parent_id: parentId,
    created_at: created,
    fetched_at: now,
    found_via: `bluesky:${phrase}`,
    num_comments: post.replyCount ?? 0,
    score_ups: post.likeCount ?? 0,
    locked: false,
    // The title is derived from the body, so hash the body only.
    content_hash: contentHash("", text),
    lang: post.record?.langs?.[0] ?? null,
    rating: null,
  };
}

/** Posts of the first result page, or a short error message. No retries, no pagination. */
async function searchPosts(q: Query, since: string): Promise<PostView[] | string> {
  const params = new URLSearchParams({ q: q.phrase, sort: "latest", limit: String(LIMIT), since });
  if (q.lang) params.set("lang", q.lang);
  let res: Response;
  try {
    res = await fetchPolite(`${HOST}/xrpc/app.bsky.feed.searchPosts?${params}`, "application/json");
  } catch (e) {
    return errMsg(e);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return `HTTP ${res.status}`;
  }
  try {
    const posts = ((await res.json()) as SearchResponse | null)?.posts;
    return Array.isArray(posts) ? posts : [];
  } catch {
    return "response was not JSON";
  }
}

export const bluesky: Strategy = {
  id: "bluesky",
  enabled: (cfg) =>
    !cfg.bluesky.enabled
      ? "bluesky skipped: bluesky.enabled is false in products.yaml"
      : cfg.products.some((p) => p.bluesky.enabled)
        ? true
        : "bluesky skipped: no product has bluesky enabled",
  async collect(cfg, now, log): Promise<CollectResult> {
    const errors: string[] = [];
    const notes: string[] = [];
    const found = new Map<string, Item>();
    const own = new Set(cfg.bluesky.own_handles);
    const since = new Date((now - SOCIAL_WINDOW_S) * 1000).toISOString();
    const products = cfg.products.filter((p) => p.bluesky.enabled);

    const allPhrases = roundRobin(products.map((p) => p.search_phrases), Number.POSITIVE_INFINITY);
    const allDanish = roundRobin(products.map((p) => p.bluesky.danish_phrases), Number.POSITIVE_INFINITY);
    if (allPhrases.length > BLUESKY_PHRASE_CAP) {
      notes.push(
        `bluesky: ${allPhrases.length - BLUESKY_PHRASE_CAP} search phrases over the cap of ${BLUESKY_PHRASE_CAP} were skipped`,
      );
    }
    if (allDanish.length > BLUESKY_DANISH_CAP) {
      notes.push(
        `bluesky: ${allDanish.length - BLUESKY_DANISH_CAP} Danish phrases over the cap of ${BLUESKY_DANISH_CAP} were skipped`,
      );
    }
    // Danish first: a post found by both kinds of query keeps the Danish phrase as its channel,
    // which is what lets it through the prefilter's non-English check.
    const queries: Query[] = [
      ...allDanish.slice(0, BLUESKY_DANISH_CAP).map((phrase) => ({ phrase, lang: "da" })),
      ...allPhrases.slice(0, BLUESKY_PHRASE_CAP).map((phrase) => ({ phrase, lang: undefined })),
    ];

    for (const q of queries) {
      const res = await searchPosts(q, since);
      if (typeof res === "string") {
        errors.push(`bluesky "${q.phrase}": ${res}`);
        continue;
      }
      const re = phraseRe(q.phrase);
      for (const post of res) {
        const item = normalizePost(post, q.phrase, re, own, now);
        if (item && !found.has(item.id)) found.set(item.id, item);
      }
    }

    log(`bluesky: done (${found.size} items, ${errors.length} errors)`);
    return { items: [...found.values()], errors, notes };
  },
};
