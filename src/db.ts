import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { DATA_DIR, DB_PATH, SLOW_WINDOW_S, SOCIAL_WINDOW_S } from "./config.ts";

export type Item = {
  id: string;
  source: "reddit" | "hn" | "appstore" | "rss" | "bluesky";
  kind: "post" | "comment" | "review" | "article";
  url: string;
  title: string;
  body: string;
  author: string;
  /**
   * Channel label: subreddit, 'hn', search phrase for Bluesky posts, competitor app name for reviews,
   * query or feed name for articles.
   */
  subreddit: string;
  parent_id: string | null;
  created_at: number;
  fetched_at: number;
  found_via: string;
  num_comments: number;
  score_ups: number;
  locked: boolean;
  content_hash: string;
  lang: string | null;
  rating: number | null;
};

export type Flags = {
  already_answered: boolean;
  old_or_locked: boolean;
  mentions_competitor: boolean;
  non_english: boolean;
};

export type PrefilterRow = {
  item_id: string;
  passed: boolean;
  local_score: number;
  product_hints: string[];
  reason: string;
  run_date: string;
  lang: string | null;
};

export type ScoreRow = {
  item_id: string;
  matched_product: string | null;
  tier: string;
  confidence: number;
  reason: string;
  flags: Flags;
  insight: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
};

export type Candidate = { item: Item; localScore: number; hints: string[] };

export type ScoredItem = Item & {
  matched_product: string | null;
  tier: string;
  confidence: number;
  reason: string;
  flags: Flags;
  insight: string | null;
};

export type DailyStats = {
  run_date: string;
  fetched: number;
  new_items: number;
  prefiltered: number;
  scored: number;
  leads_json: string;
  api_cost_usd: number;
  errors: number;
  duration_s: number;
  finished_at: number;
  cut: number;
  notes: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  subreddit TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  created_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  found_via TEXT NOT NULL DEFAULT '',
  num_comments INTEGER NOT NULL DEFAULT 0,
  score_ups INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  lang TEXT,
  rating INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at);
CREATE INDEX IF NOT EXISTS idx_items_content_hash ON items(content_hash);
CREATE TABLE IF NOT EXISTS prefilter (
  item_id TEXT PRIMARY KEY,
  passed INTEGER NOT NULL,
  local_score REAL NOT NULL,
  product_hints TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL DEFAULT '',
  run_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prefilter_run_date ON prefilter(run_date);
CREATE TABLE IF NOT EXISTS scores (
  item_id TEXT PRIMARY KEY,
  matched_product TEXT,
  tier TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  flags TEXT NOT NULL DEFAULT '{}',
  model TEXT NOT NULL,
  scored_at INTEGER NOT NULL,
  run_date TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  insight TEXT
);
CREATE INDEX IF NOT EXISTS idx_scores_run_date ON scores(run_date);
CREATE TABLE IF NOT EXISTS daily_stats (
  run_date TEXT PRIMARY KEY,
  fetched INTEGER NOT NULL DEFAULT 0,
  new_items INTEGER NOT NULL DEFAULT 0,
  prefiltered INTEGER NOT NULL DEFAULT 0,
  scored INTEGER NOT NULL DEFAULT 0,
  leads_json TEXT NOT NULL DEFAULT '{}',
  api_cost_usd REAL NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  duration_s REAL NOT NULL DEFAULT 0,
  finished_at INTEGER NOT NULL DEFAULT 0,
  cut INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '[]'
);
`;

let conn: Database | null = null;

export function openDb(): Database {
  if (conn) return conn;
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run(SCHEMA);
  ensureColumn(db, "items", "rating", "INTEGER");
  ensureColumn(db, "scores", "insight", "TEXT");
  conn = db;
  return db;
}

function ensureColumn(db: Database, table: string, col: string, decl: string): void {
  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!cols.includes(col)) db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

type ItemRow = Omit<Item, "source" | "kind" | "locked"> & { source: string; kind: string; locked: number };

function toItem(r: ItemRow): Item {
  return { ...r, source: r.source as Item["source"], kind: r.kind as Item["kind"], locked: r.locked === 1 };
}

const ITEM_COLS =
  "i.id, i.source, i.kind, i.url, i.title, i.body, i.author, i.subreddit, i.parent_id, i.created_at, i.fetched_at, i.found_via, i.num_comments, i.score_ups, i.locked, i.content_hash, i.lang, i.rating";

const DUP_WINDOW_S = 7 * 86400;

/** INSERT OR IGNORE; new items whose content_hash matches a non-dup item within 7 days get found_via 'dup:<id>'. */
export function insertItems(items: Item[]): { inserted: number; dups: number } {
  const db = openDb();
  const exists = db.query<{ x: number }, { id: string }>("SELECT 1 AS x FROM items WHERE id = $id");
  const original = db.query<{ id: string }, { hash: string; lo: number; hi: number; id: string }>(
    `SELECT id FROM items
     WHERE content_hash = $hash AND created_at BETWEEN $lo AND $hi AND id != $id AND found_via NOT LIKE 'dup:%'
     ORDER BY created_at ASC LIMIT 1`,
  );
  const insert = db.query(
    `INSERT OR IGNORE INTO items
     (id, source, kind, url, title, body, author, subreddit, parent_id, created_at, fetched_at, found_via, num_comments, score_ups, locked, content_hash, lang, rating)
     VALUES ($id, $source, $kind, $url, $title, $body, $author, $subreddit, $parent_id, $created_at, $fetched_at, $found_via, $num_comments, $score_ups, $locked, $content_hash, $lang, $rating)`,
  );
  let inserted = 0;
  let dups = 0;
  db.transaction(() => {
    for (const it of items) {
      if (exists.get({ id: it.id })) continue;
      const orig = it.content_hash
        ? original.get({ hash: it.content_hash, lo: it.created_at - DUP_WINDOW_S, hi: it.created_at + DUP_WINDOW_S, id: it.id })
        : null;
      const foundVia = orig ? `dup:${orig.id}` : it.found_via;
      if (orig) dups++;
      inserted += insert.run({ ...it, found_via: foundVia, locked: it.locked ? 1 : 0 }).changes;
    }
  })();
  return { inserted, dups };
}

export function itemsPendingPrefilter(): Item[] {
  return openDb()
    .query<ItemRow, []>(
      `SELECT ${ITEM_COLS} FROM items i LEFT JOIN prefilter p ON p.item_id = i.id WHERE p.item_id IS NULL`,
    )
    .all()
    .map(toItem);
}

export function savePrefilter(rows: PrefilterRow[]): void {
  const db = openDb();
  const insert = db.query(
    `INSERT OR IGNORE INTO prefilter (item_id, passed, local_score, product_hints, reason, run_date)
     VALUES ($item_id, $passed, $local_score, $product_hints, $reason, $run_date)`,
  );
  const setLang = db.query("UPDATE items SET lang = $lang WHERE id = $id");
  db.transaction(() => {
    for (const r of rows) {
      insert.run({
        item_id: r.item_id,
        passed: r.passed ? 1 : 0,
        local_score: r.local_score,
        product_hints: JSON.stringify(r.product_hints),
        reason: r.reason,
        run_date: r.run_date,
      });
      if (r.lang) setLang.run({ lang: r.lang, id: r.item_id });
    }
  })();
}

export function countPassed(runDate: string): number {
  return (
    openDb()
      .query<{ n: number }, { d: string }>("SELECT COUNT(*) AS n FROM prefilter WHERE run_date = $d AND passed = 1")
      .get({ d: runDate })?.n ?? 0
  );
}

export function countScored(runDate: string): number {
  return (
    openDb().query<{ n: number }, { d: string }>("SELECT COUNT(*) AS n FROM scores WHERE run_date = $d").get({ d: runDate })
      ?.n ?? 0
  );
}

/**
 * Prefilter-passing items with no score yet, by local_score desc: posts and comments created
 * within the last 36h, reviews and articles within the last 30 days.
 * Not scoped to a run_date, so items cut or failed in an earlier run get another chance.
 */
export function unscoredCandidates(now: number): Candidate[] {
  return openDb()
    .query<ItemRow & { local_score: number; product_hints: string }, { since: number; sinceSlow: number }>(
      `SELECT ${ITEM_COLS}, p.local_score, p.product_hints
       FROM prefilter p
       JOIN items i ON i.id = p.item_id
       LEFT JOIN scores s ON s.item_id = p.item_id
       WHERE p.passed = 1 AND s.item_id IS NULL
         AND i.created_at >= (CASE WHEN i.kind IN ('review','article') THEN $sinceSlow ELSE $since END)
       ORDER BY p.local_score DESC, i.created_at DESC`,
    )
    .all({ since: now - SOCIAL_WINDOW_S, sinceSlow: now - SLOW_WINDOW_S })
    .map(({ local_score, product_hints, ...row }) => ({
      item: toItem(row),
      localScore: local_score,
      hints: JSON.parse(product_hints) as string[],
    }));
}

export function saveScores(rows: ScoreRow[], runDate: string, model: string, scoredAt: number): void {
  const db = openDb();
  const insert = db.query(
    `INSERT OR IGNORE INTO scores
     (item_id, matched_product, tier, confidence, reason, flags, insight, model, scored_at, run_date, input_tokens, output_tokens, cache_read_tokens)
     VALUES ($item_id, $matched_product, $tier, $confidence, $reason, $flags, $insight, $model, $scored_at, $run_date, $input_tokens, $output_tokens, $cache_read_tokens)`,
  );
  db.transaction(() => {
    for (const r of rows) {
      insert.run({ ...r, flags: JSON.stringify(r.flags), model, scored_at: scoredAt, run_date: runDate });
    }
  })();
}

export function scoredForDate(runDate: string): ScoredItem[] {
  type Row = ItemRow & {
    matched_product: string | null;
    tier: string;
    confidence: number;
    reason: string;
    flags: string;
    insight: string | null;
  };
  return openDb()
    .query<Row, { d: string }>(
      `SELECT ${ITEM_COLS}, s.matched_product, s.tier, s.confidence, s.reason, s.flags, s.insight
       FROM scores s JOIN items i ON i.id = s.item_id
       WHERE s.run_date = $d
       ORDER BY s.confidence DESC, i.created_at DESC`,
    )
    .all({ d: runDate })
    .map(({ matched_product, tier, confidence, reason, flags, insight, ...row }) => ({
      ...toItem(row),
      matched_product,
      tier,
      confidence,
      reason,
      flags: JSON.parse(flags) as Flags,
      insight,
    }));
}

export function getDailyStats(runDate: string): DailyStats | null {
  return openDb().query<DailyStats, { d: string }>("SELECT * FROM daily_stats WHERE run_date = $d").get({ d: runDate });
}

/** Every daily_stats row, oldest first. */
export function allDailyStats(): DailyStats[] {
  return openDb().query<DailyStats, []>("SELECT * FROM daily_stats ORDER BY run_date ASC").all();
}

/** Up to `n` daily_stats rows with run_date <= runDate, oldest first. */
export function recentDailyStats(runDate: string, n = 7): DailyStats[] {
  return openDb()
    .query<DailyStats, { d: string; n: number }>(
      "SELECT * FROM daily_stats WHERE run_date <= $d ORDER BY run_date DESC LIMIT $n",
    )
    .all({ d: runDate, n })
    .reverse();
}

export function upsertDailyStats(s: DailyStats): void {
  openDb()
    .query(
      `INSERT INTO daily_stats (run_date, fetched, new_items, prefiltered, scored, leads_json, api_cost_usd, errors, duration_s, finished_at, cut, notes)
       VALUES ($run_date, $fetched, $new_items, $prefiltered, $scored, $leads_json, $api_cost_usd, $errors, $duration_s, $finished_at, $cut, $notes)
       ON CONFLICT(run_date) DO UPDATE SET
         fetched = excluded.fetched, new_items = excluded.new_items, prefiltered = excluded.prefiltered,
         scored = excluded.scored, leads_json = excluded.leads_json, api_cost_usd = excluded.api_cost_usd,
         errors = excluded.errors, duration_s = excluded.duration_s, finished_at = excluded.finished_at,
         cut = excluded.cut, notes = excluded.notes`,
    )
    .run({ ...s });
}
