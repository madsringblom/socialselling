import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const ROOT = resolve(import.meta.dir, "..");
export const DATA_DIR = join(ROOT, "data");
export const REPORTS_DIR = join(ROOT, "reports");
export const DB_PATH = join(DATA_DIR, "social.db");
export const LOCK_PATH = join(DATA_DIR, "run.lock");
export const STATS_PATH = join(DATA_DIR, "stats.jsonl");
export const PRODUCTS_PATH = join(ROOT, "products.yaml");

const Subreddit = z.string().regex(/^[A-Za-z0-9_]+$/, "subreddit without r/ prefix");
const Country = z.string().regex(/^[a-z]{2}$/, "two-letter lowercase storefront code, e.g. dk");
/** A Bluesky handle such as mads.bsky.social (a leading @ is dropped) or a did. */
const BlueskyHandle = z
  .string()
  .transform((s) => s.replace(/^@/, "").toLowerCase())
  .pipe(z.string().min(1));

const CompetitorSchema = z.object({
  name: z.string().min(1),
  app_store: z
    .object({
      id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(String),
      countries: z.array(Country).min(1).default(["dk"]),
    })
    .optional(),
  /** Reserved for a later Google Play strategy (package name, e.g. com.spond.spond). Accepted, not collected. */
  google_play: z.string().optional(),
});

const FeedSchema = z.object({
  name: z.string().min(1),
  url: z.url(),
  /** Product ids this feed is relevant to; default: all products. */
  products: z.array(z.string()).optional(),
  /** Anything other than "en" lets non-English items through the prefilter. */
  lang: z.string().default("en"),
});

const ProductSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be lowercase letters, digits and dashes"),
  name: z.string().min(1),
  url: z.string(),
  one_liner: z.string().min(1),
  target_user: z.string().min(1),
  problems_solved: z.array(z.string()).min(1),
  key_features: z.array(z.string()).default([]),
  not_for: z.array(z.string()).default([]),
  search_phrases: z.array(z.string()).min(1),
  subreddits: z.array(Subreddit).default([]),
  /** Subs where non-English items are kept (flagged) and the English phrase search is skipped. */
  non_english_subreddits: z.array(Subreddit).default([]),
  competitors: z.array(CompetitorSchema).default([]),
  news_queries: z.array(z.string().min(1)).default([]),
  /**
   * Bluesky search for this product's search_phrases. Danish phrases are searched with lang=da and allow
   * non-English items through the prefilter; they also count as phrase hits in the prefilter.
   */
  bluesky: z
    .object({
      enabled: z.boolean().default(true),
      danish_phrases: z.array(z.string().min(1)).default([]),
    })
    .default({ enabled: true, danish_phrases: [] }),
});

const ConfigSchema = z.object({
  products: z.array(ProductSchema).min(1),
  feeds: z.array(FeedSchema).nullish().transform((v) => v ?? []), // a "feeds:" key with only comments parses as null
  /** own_handles: the owner's Bluesky accounts (handles or dids) whose posts are skipped. */
  bluesky: z
    .object({
      enabled: z.boolean().default(true),
      own_handles: z.array(BlueskyHandle).default([]),
    })
    .default({ enabled: true, own_handles: [] }),
});

export type Product = z.infer<typeof ProductSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export const SOCIAL_WINDOW_S = 36 * 3600;
export const SLOW_WINDOW_S = 30 * 86400; // reviews and articles: low volume, kept 30 days

export function loadConfig(path = PRODUCTS_PATH): Config {
  const parsed = ConfigSchema.safeParse(parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`${path} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  const ids = parsed.data.products.map((p) => p.id);
  const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dupe) throw new Error(`${path}: duplicate product id "${dupe}"`);
  for (const f of parsed.data.feeds) {
    for (const id of f.products ?? []) {
      if (!ids.includes(id)) throw new Error(`${path}: feed "${f.name}" references unknown product "${id}"`);
    }
  }
  return parsed.data;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export const TZ = process.env.TZ?.trim() || "Europe/Copenhagen";
export const MODEL = process.env.CLAUDE_MODEL?.trim() || "claude-haiku-5-5";
export const REDDIT_USERNAME = process.env.REDDIT_USERNAME?.trim() || "";
export const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID?.trim() || "";
export const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET?.trim() || "";
export const FETCH_THREAD_CONTEXT = (process.env.FETCH_THREAD_CONTEXT ?? "true").trim().toLowerCase() !== "false";
export const MAX_SCORED_PER_DAY = intEnv("MAX_SCORED_PER_DAY", 400);

export function requireApiKey(): void {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  }
}

function parts(d: Date, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23", ...opts }).formatToParts(d)) {
    out[p.type] = p.value;
  }
  return out;
}

export function localDate(d = new Date()): string {
  const p = parts(d, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

export function localTime(d = new Date(), withSeconds = false): string {
  const p = parts(d, { hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}) });
  return withSeconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
}

export const runDate = localDate();
