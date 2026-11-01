import type { Config } from "../config.ts";
import type { Item } from "../db.ts";

/** errors count toward the run's error total; notes are informational. */
export type CollectResult = { items: Item[]; errors: string[]; notes: string[] };
export type Log = (msg: string) => void;

export type Strategy = {
  id: string;
  /** true to run; otherwise a one-line skip note that goes into the report's notes. */
  enabled(cfg: Config): true | string;
  collect(cfg: Config, now: number, log: Log): Promise<CollectResult>;
};

export const BODY_MAX = 1500;
export const FETCH_TIMEOUT_MS = 20_000;
export const USER_AGENT = "socialselling-validation/0.1 (read-only lead finder; personal use)";

export function contentHash(title: string, body: string): string {
  const norm = `${title}\n${body}`.toLowerCase().replace(/\s+/g, " ").trim();
  return new Bun.CryptoHasher("sha1").update(norm).digest("hex");
}

export function roundRobin(lists: string[][], cap: number): string[] {
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

export function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
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

/** Next allowed request time (ms) per host, shared by every fetchPolite caller. */
const nextSlot = new Map<string, number>();

/** fetch with >=1s gap per host and a 20s timeout. Callers in one strategy must await sequentially. */
export async function fetchPolite(url: string, accept: string, minGapMs = 1000): Promise<Response> {
  const host = new URL(url).host;
  const wait = (nextSlot.get(host) ?? 0) - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  nextSlot.set(host, Date.now() + minGapMs);
  return fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: accept },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}
