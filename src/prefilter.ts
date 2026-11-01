import { SLOW_WINDOW_S, SOCIAL_WINDOW_S } from "./config.ts";
import type { Config } from "./config.ts";
import type { Item } from "./db.ts";

export type PrefilterResult = {
  pass: boolean;
  localScore: number;
  productHints: string[];
  reason: string;
  lang: "en" | "other";
};

type Cluster = { text: string; words: RegExp[] };
type ProductMatcher = {
  id: string;
  /** channelKey()s this product owns: its subreddits, competitor apps, news queries and feeds. */
  channels: Set<string>;
  phrases: { text: string; re: RegExp }[];
  problems: Cluster[];
  notFor: Cluster[];
};
export type Matchers = { products: ProductMatcher[]; nonEnglishChannels: Set<string> };

const MIN_LEN_POST = 80;
const MIN_LEN_COMMENT = 120;
const MIN_LEN_REVIEW = 20;
const MIN_LEN_ARTICLE = 40;
const PHRASE_HIT_CAP = 2;

export const INTENT_RE =
  /\b(is there (a|an|any)|looking for (a|an|any)|recommend(ation)?s?|any (tool|app|service|alternative)|how do (you|i)|what do you use|anyone know|alternatives? to|does anyone|tired of|struggling with|wish there was)\b/i;
const THREAD_RE = /(megathread|weekly thread|daily discussion)/i;
const HIRING_RE = /who is hiring/i;
const ASK_HN_RE = /^ask hn\b/i;
const PROMO_RES = [/\blaunched\b/i, /\bcheck out my\b/i, /\bwe built\b/i, /\buse code\b/i, /\bdiscount\b/i, /\baffiliate\b/i];
const URL_RE = /https?:\/\/\S+/i;
const REMOVED = new Set(["[removed]", "[deleted]"]);

// Deliberately excludes words that are also common in Danish ("i", "for", "to", "at", "en", "de").
const EN_STOPWORDS = new Set(
  "the and is of that it with you my this have are was but not what how they there would can just about from your will been any does has our we which when if or an be do so on".split(
    " ",
  ),
);

const TOKEN_STOPWORDS = new Set(
  (
    "the and a an of to in on at for with by from or but if so as is are was were be been being am do does did done " +
    "i me my mine we us our you your he she it its they them their this that these those who whom whose what which when where why how " +
    "not no nor never always only just very really too also still even ever all any some each every both few more most other same such " +
    "can can't cannot could would should will won't don't doesn't didn't isn't aren't i'm i've we're they're who's it's " +
    "have has had having get got make made keep keeps meaning need needs want wants know one two five lot lots thing things " +
    "same different someone something nobody anyone everyone simple happen happening keep"
  ).split(" "),
);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokens(text: string): string[] {
  return (text.toLowerCase().replace(/’/g, "'").match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).filter(
    (w) => w.length >= 3 && !TOKEN_STOPWORDS.has(w),
  );
}

function stem(w: string): string {
  if (w.length < 5) return w;
  const s = w.replace(/(ing|ed|es|s)$/, "");
  return s.length >= 4 ? s : w;
}

function wordPrefixRe(w: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(stem(w))}`, "iu");
}

function phraseRe(phrase: string): RegExp {
  const body = escapeRe(phrase.trim()).replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
}

/** 2-3 most distinctive words: rarest across all clusters first, then longest. */
function distinctiveWords(text: string, docFreq: Map<string, number>): string[] {
  const words = [...new Set(tokens(text))];
  const k = Math.min(words.length, Math.max(2, Math.min(3, Math.ceil(words.length / 2))));
  return words
    .sort((a, b) => (docFreq.get(a) ?? 0) - (docFreq.get(b) ?? 0) || b.length - a.length)
    .slice(0, k);
}

export const channelKey = (source: string, channel: string) => `${source}:${channel.toLowerCase()}`;

export function compileMatchers(cfg: Config): Matchers {
  const { products, feeds } = cfg;
  const docFreq = new Map<string, number>();
  for (const p of products) {
    for (const text of [...p.problems_solved, ...p.not_for]) {
      for (const w of new Set(tokens(text))) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
    }
  }
  const cluster = (text: string): Cluster => ({ text, words: distinctiveWords(text, docFreq).map(wordPrefixRe) });
  // Reviews and Bing queries are Danish by design; feeds opt in with lang other than "en".
  const nonEnglishChannels = new Set([
    ...products.flatMap((p) => p.non_english_subreddits.map((s) => channelKey("reddit", s))),
    ...products.flatMap((p) => p.competitors.map((c) => channelKey("appstore", c.name))),
    ...products.flatMap((p) => p.news_queries.map((q) => channelKey("rss", q))),
    ...feeds.filter((f) => f.lang !== "en").map((f) => channelKey("rss", f.name)),
  ]);
  return {
    nonEnglishChannels,
    products: products.map((p) => ({
      id: p.id,
      channels: new Set([
        ...p.subreddits.map((s) => channelKey("reddit", s)),
        ...p.competitors.map((c) => channelKey("appstore", c.name)),
        ...p.news_queries.map((q) => channelKey("rss", q)),
        ...feeds.filter((f) => !f.products || f.products.includes(p.id)).map((f) => channelKey("rss", f.name)),
      ]),
      phrases: p.search_phrases.map((text) => ({ text, re: phraseRe(text) })),
      problems: p.problems_solved.map(cluster).filter((c) => c.words.length > 0),
      notFor: p.not_for.map(cluster).filter((c) => c.words.length > 0),
    })),
  };
}

export function detectLang(text: string): "en" | "other" {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return "other";
  const ascii = letters.filter((c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z")).length;
  if (ascii / letters.length < 0.85) return "other";
  const words = (text.toLowerCase().match(/[\p{L}']+/gu) ?? []).slice(0, 300);
  let hits = 0;
  for (const w of words) if (EN_STOPWORDS.has(w) && ++hits >= 2) return "en";
  return "other";
}

function isPromotional(body: string): boolean {
  return URL_RE.test(body) && PROMO_RES.filter((re) => re.test(body)).length >= 2;
}

const quote = (s: string) => `"${s.length > 40 ? `${s.slice(0, 40)}…` : s}"`;

/**
 * Pure keyword prefilter. For comments, matching uses the comment body only;
 * the parent title (stored as title) is context, not the author's own words.
 */
export function prefilterItem(item: Item, m: Matchers, now: number): PrefilterResult {
  const isPost = item.kind === "post";
  const isComment = item.kind === "comment";
  const isSocial = isPost || isComment;
  const own = isComment ? item.body : `${item.title}\n${item.body}`;
  const minLen = isPost ? MIN_LEN_POST : isComment ? MIN_LEN_COMMENT : item.kind === "review" ? MIN_LEN_REVIEW : MIN_LEN_ARTICLE;
  const reject = (reason: string, lang: "en" | "other" = "en"): PrefilterResult => ({
    pass: false,
    localScore: 0,
    productHints: [],
    reason,
    lang,
  });

  if (REMOVED.has(item.title.trim()) || REMOVED.has(item.body.trim()) || REMOVED.has(item.author)) {
    return reject("removed/deleted");
  }
  if (item.author === "AutoModerator") return reject("AutoModerator");
  if (own.trim().length < minLen) return reject("too short");
  if (now - item.created_at > (isSocial ? SOCIAL_WINDOW_S : SLOW_WINDOW_S)) {
    return reject(isSocial ? "older than 36h" : "older than 30d");
  }
  const isAskHn = ASK_HN_RE.test(item.title);
  if (HIRING_RE.test(item.title) || (THREAD_RE.test(item.title) && !isAskHn)) return reject("megathread");

  const lang = detectLang(own);
  const key = channelKey(item.source, item.subreddit);
  if (lang === "other" && !m.nonEnglishChannels.has(key)) return reject("non-English", "other");
  if (isPost && isPromotional(item.body)) return reject("promotional", lang);

  if (item.kind === "review") {
    const owners = m.products.filter((p) => p.channels.has(key)).map((p) => p.id);
    if (owners.length === 0) return reject("review: unmapped competitor", lang);
    const low = item.rating != null && item.rating <= 3;
    return {
      pass: true,
      localScore: low ? 3 : 2,
      productHints: owners,
      reason: `review of ${item.subreddit}${item.rating != null ? ` (${item.rating}/5)` : ""}`,
      lang,
    };
  }

  const intent = INTENT_RE.test(own);
  let base = 0;
  const why: string[] = [];
  if (intent) {
    base += 2;
    why.push("intent");
  }
  if (isPost && item.title.includes("?")) {
    base += 1;
    why.push("? in title");
  }
  if (isPost && isAskHn) {
    base += 1;
    why.push("Ask HN");
  }

  const perProduct = m.products.map((p) => {
    let score = 0;
    const hits: string[] = [];
    for (const ph of p.phrases.filter((ph) => ph.re.test(own)).slice(0, PHRASE_HIT_CAP)) {
      score += 3;
      hits.push(`phrase ${quote(ph.text)}`);
    }
    for (const c of p.problems) {
      if (c.words.every((re) => re.test(own))) {
        score += 2;
        hits.push(`problem ${quote(c.text)}`);
      }
    }
    for (const c of p.notFor) {
      if (c.words.every((re) => re.test(own))) {
        score -= 2;
        hits.push(`not_for ${quote(c.text)}`);
      }
    }
    return { id: p.id, score, hits, inChannel: p.channels.has(key) };
  });

  const best = Math.max(0, ...perProduct.map((p) => p.score));
  const localScore = base + best;
  const ranked = [...perProduct].sort((a, b) => b.score - a.score);
  const productHints = [
    ...ranked.filter((p) => p.score > 0).map((p) => p.id),
    ...ranked.filter((p) => p.score <= 0 && p.inChannel).map((p) => p.id),
  ];
  const inProductChannel = perProduct.some((p) => p.inChannel);
  // Without a phrase/problem hit, only intent in one of a product's own channels passes;
  // "?" and "Ask HN" add to the score but never pass an item on their own.
  const pass = best > 0 ? localScore >= 2 : inProductChannel && intent;
  const details = [...why, ...ranked.flatMap((p) => p.hits.map((h) => `${p.id}: ${h}`))];
  return {
    pass,
    localScore,
    productHints,
    reason: `score ${localScore}${details.length ? ` (${details.join("; ")})` : ""}`,
    lang,
  };
}

/** Caps LLM candidates by local score (desc). */
export function selectCandidates<T extends { localScore: number }>(rows: T[], cap: number): { selected: T[]; cut: number } {
  const sorted = [...rows].sort((a, b) => b.localScore - a.localScore);
  return { selected: sorted.slice(0, cap), cut: Math.max(0, sorted.length - cap) };
}
