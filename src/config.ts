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
});

const ProductsFileSchema = z.object({ products: z.array(ProductSchema).min(1) });

export type Product = z.infer<typeof ProductSchema>;

export function loadProducts(path = PRODUCTS_PATH): Product[] {
  const parsed = ProductsFileSchema.safeParse(parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`${path} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  const ids = parsed.data.products.map((p) => p.id);
  const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dupe) throw new Error(`${path}: duplicate product id "${dupe}"`);
  return parsed.data.products;
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
