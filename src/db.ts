import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH, SLOW_WINDOW_S, SOCIAL_WINDOW_S } from "./config.ts";

export type Item = {
  id: string;
  source: "reddit" | "hn" | "appstore" | "rss" | "bluesky" | "mail";
  kind: "post" | "comment" | "review" | "article";
  url: string;
  title: string;
  body: string;
  author: string;
  /**
   * Channel label: subreddit, 'hn', search phrase for Bluesky posts, competitor app name for reviews,
   * query or feed name for articles, group name for mail (Facebook/LinkedIn group notifications and pasted posts).
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

export type DraftVariant = "default" | "no_link" | "redraft";
export type DraftRow = {
  id: string;
  item_id: string;
  variant: DraftVariant;
  direction: string | null;
  text: string;
  model: string;
  created_at: number;
};

export type EntityRow = {
  id: string;
  kind: "organisation" | "person";
  name: string;
  normalized_name: string;
  domain: string | null;
  website: string | null;
  municipality: string | null;
  sports: string[];
  product_id: string;
  first_seen: string;
  last_seen: string;
  signal_count: number;
};

export type Signal = {
  family: string;
  type: string;
  classification: "FACT" | "INFERENCE" | "HYPOTHESIS";
  evidence_summary: string;
  source_url: string | null;
  source_published_date: string | null;
  discovered_date: string | null;
  confidence: "high" | "medium" | "low";
};
export type StackEntry = {
  system: string;
  category: string;
  source_url: string;
  classification: "FACT" | "INFERENCE";
  observed_date: string | null;
};
export type Contact = {
  name: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  source_url: string;
  retrieved_date: string | null;
};
export type MemberCount = {
  value: number | null;
  as_of: string | null;
  source_url: string | null;
  classification: "FACT" | "INFERENCE";
  confidence: "high" | "medium" | "low";
};
export type ScoreComponent = { points: number; basis: string; evidence_url: string | null };
export type ScoreJson = {
  components: {
    intent: ScoreComponent;
    operational_pain: ScoreComponent;
    mio_fit: ScoreComponent;
    timing: ScoreComponent;
    reachability: ScoreComponent;
  };
  negative_adjustments: { points: number; reason: string; evidence_url: string }[];
};
export type LeadStatus = "new" | "contacted" | "replied" | "meeting" | "no_interest";
export type Classification = "HOT" | "STRONG" | "WATCH" | "ARCHIVE";
export type LeadRow = {
  id: string;
  product_id: string;
  org_name: string;
  website: string | null;
  domain: string | null;
  municipality: string | null;
  sports: string[];
  member_count: MemberCount | null;
  signals: Signal[];
  digital_stack: StackEntry[];
  contacts: Contact[];
  score: ScoreJson;
  total: number;
  classification: Classification;
  pain_hypothesis: string | null;
  opportunity_hypothesis: string | null;
  call_brief: string[] | null;
  status: LeadStatus;
  note: string;
  salgsro_exported_at: number | null;
  first_seen: string;
  last_researched: string | null;
  research_cost_usd: number;
};
export type ActionRow = { id: number; kind: string; target_id: string; payload: unknown; created_at: number };
export type IdeaRow = {
  id: string;
  product_id: string;
  week: string;
  title: string;
  why: string;
  kind: "comparison_page" | "help_article" | "feature" | "post";
  gap_refs: string[];
  created_at: number;
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
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  direction TEXT,
  text TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_item ON drafts(item_id, created_at);
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  domain TEXT,
  website TEXT,
  municipality TEXT,
  sports_json TEXT NOT NULL DEFAULT '[]',
  product_id TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  signal_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_entities_domain ON entities(domain);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(normalized_name);
CREATE TABLE IF NOT EXISTS entity_items (
  entity_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (entity_id, item_id)
);
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  org_name TEXT NOT NULL,
  website TEXT,
  domain TEXT,
  municipality TEXT,
  sports_json TEXT NOT NULL DEFAULT '[]',
  member_count_json TEXT,
  signals_json TEXT NOT NULL DEFAULT '[]',
  digital_stack_json TEXT NOT NULL DEFAULT '[]',
  contacts_json TEXT NOT NULL DEFAULT '[]',
  score_json TEXT NOT NULL DEFAULT '{}',
  total INTEGER NOT NULL DEFAULT 0,
  classification TEXT NOT NULL DEFAULT 'ARCHIVE',
  pain_hypothesis TEXT,
  opportunity_hypothesis TEXT,
  call_brief_json TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  note TEXT NOT NULL DEFAULT '',
  salgsro_exported_at INTEGER,
  first_seen TEXT NOT NULL,
  last_researched TEXT,
  research_cost_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT 'null',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_target ON actions(target_id, id);
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  week TEXT NOT NULL,
  title TEXT NOT NULL,
  why TEXT NOT NULL,
  kind TEXT NOT NULL,
  gap_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ideas_week ON ideas(product_id, week);
`;

let conn: Database | null = null;

/** Opens (once) and migrates the database. `path` is only used on the first open after start or closeDb(). */
export function openDb(path = DB_PATH): Database {
  if (conn) return conn;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run(SCHEMA);
  ensureColumn(db, "items", "rating", "INTEGER");
  ensureColumn(db, "scores", "insight", "TEXT");
  ensureColumn(db, "scores", "entities_at", "INTEGER");
  conn = db;
  return db;
}

export function closeDb(): void {
  conn?.close();
  conn = null;
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

type ScoredRow = ItemRow & {
  matched_product: string | null;
  tier: string;
  confidence: number;
  reason: string;
  flags: string;
  insight: string | null;
};

const SCORED_COLS = `${ITEM_COLS}, s.matched_product, s.tier, s.confidence, s.reason, s.flags, s.insight`;

function toScored({ matched_product, tier, confidence, reason, flags, insight, ...row }: ScoredRow): ScoredItem {
  return {
    ...toItem(row),
    matched_product,
    tier,
    confidence,
    reason,
    flags: JSON.parse(flags) as Flags,
    insight,
  };
}

export function scoredForDate(runDate: string): ScoredItem[] {
  return openDb()
    .query<ScoredRow, { d: string }>(
      `SELECT ${SCORED_COLS}
       FROM scores s JOIN items i ON i.id = s.item_id
       WHERE s.run_date = $d
       ORDER BY s.confidence DESC, i.created_at DESC`,
    )
    .all({ d: runDate })
    .map(toScored);
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

const nowS = () => Math.floor(Date.now() / 1000);
const TIER_RANK_SQL = (col: string) =>
  `CASE ${col} WHEN 'asking_for_tool' THEN 0 WHEN 'describing_problem' THEN 1 WHEN 'passing_mention' THEN 2 ELSE 3 END`;

// ---------------------------------------------------------------- scored items

export function scoredItem(itemId: string): ScoredItem | null {
  const row = openDb()
    .query<ScoredRow, { id: string }>(`SELECT ${SCORED_COLS} FROM scores s JOIN items i ON i.id = s.item_id WHERE s.item_id = $id`)
    .get({ id: itemId });
  return row ? toScored(row) : null;
}

// ---------------------------------------------------------------- drafts

type DraftDbRow = Omit<DraftRow, "variant"> & { variant: string };
const toDraft = (r: DraftDbRow): DraftRow => ({ ...r, variant: r.variant as DraftVariant });

export function insertDraft(d: DraftRow): void {
  openDb()
    .query(
      `INSERT INTO drafts (id, item_id, variant, direction, text, model, created_at)
       VALUES ($id, $item_id, $variant, $direction, $text, $model, $created_at)`,
    )
    .run({ ...d });
}

/** Newest first. */
export function draftsForItem(itemId: string): DraftRow[] {
  return openDb()
    .query<DraftDbRow, { id: string }>(
      "SELECT id, item_id, variant, direction, text, model, created_at FROM drafts WHERE item_id = $id ORDER BY created_at DESC, rowid DESC",
    )
    .all({ id: itemId })
    .map(toDraft);
}

/** Number of 'default' drafts (one per drafted item) created at or after `sinceEpoch`. */
export function countDraftsSince(sinceEpoch: number): number {
  return (
    openDb()
      .query<{ n: number }, { since: number }>(
        "SELECT COUNT(*) AS n FROM drafts WHERE variant = 'default' AND created_at >= $since",
      )
      .get({ since: sinceEpoch })?.n ?? 0
  );
}

/**
 * Scored post/comment items worth a reply draft: tier asking_for_tool or describing_problem, confidence >= min,
 * created at or after `since`, no draft yet, not flagged old_or_locked or already_answered, and no 'skip' or
 * 'posted' action ever recorded for the item (a later 'undo_posted' does not bring it back). Ordered asking_for_tool first, then confidence desc.
 * Product filtering (plays.reply_drafts) is done by the caller.
 */
export function draftCandidates(a: { since: number; minConfidence: number }): ScoredItem[] {
  return openDb()
    .query<ScoredRow, { since: number; minConfidence: number }>(
      `SELECT ${SCORED_COLS}
       FROM scores s JOIN items i ON i.id = s.item_id
       WHERE i.kind IN ('post','comment') AND s.tier IN ('asking_for_tool','describing_problem')
         AND s.confidence >= $minConfidence AND i.created_at >= $since
         AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.item_id = s.item_id)
         AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.target_id = s.item_id AND a.kind IN ('skip','posted'))
         AND COALESCE(json_extract(s.flags, '$.old_or_locked'), 0) = 0
         AND COALESCE(json_extract(s.flags, '$.already_answered'), 0) = 0
       ORDER BY CASE s.tier WHEN 'asking_for_tool' THEN 0 ELSE 1 END, s.confidence DESC, i.created_at DESC`,
    )
    .all({ since: a.since, minConfidence: a.minConfidence })
    .map(toScored);
}

/**
 * Scored items with at least one 'default' draft, created after `createdAfter` (epoch seconds; i.e. not yet expired).
 * Ordered asking_for_tool first, then by tier rank, confidence desc, newest first. Used by the UI's Today list.
 */
export function draftedItems(createdAfter: number): ScoredItem[] {
  return openDb()
    .query<ScoredRow, { after: number }>(
      `SELECT ${SCORED_COLS}
       FROM scores s JOIN items i ON i.id = s.item_id
       WHERE i.created_at > $after
         AND EXISTS (SELECT 1 FROM drafts d WHERE d.item_id = s.item_id AND d.variant = 'default')
       ORDER BY ${TIER_RANK_SQL("s.tier")}, s.confidence DESC, i.created_at DESC`,
    )
    .all({ after: createdAfter })
    .map(toScored);
}

// ---------------------------------------------------------------- actions

type ActionDbRow = { id: number; kind: string; target_id: string; payload_json: string; created_at: number };
const toAction = ({ payload_json, ...r }: ActionDbRow): ActionRow => ({ ...r, payload: JSON.parse(payload_json) as unknown });

export function insertAction(kind: string, targetId: string, payload: unknown = null, at = nowS()): number {
  const res = openDb()
    .query(
      "INSERT INTO actions (kind, target_id, payload_json, created_at) VALUES ($kind, $target_id, $payload_json, $created_at)",
    )
    .run({ kind, target_id: targetId, payload_json: JSON.stringify(payload ?? null), created_at: at });
  return Number(res.lastInsertRowid);
}

/** Oldest first. */
export function actionsFor(targetId: string): ActionRow[] {
  return openDb()
    .query<ActionDbRow, { t: string }>("SELECT * FROM actions WHERE target_id = $t ORDER BY id ASC")
    .all({ t: targetId })
    .map(toAction);
}

/** The latest action (highest id) per target_id among the given kinds. */
export function latestActionByTarget(kinds: string[]): Map<string, ActionRow> {
  const out = new Map<string, ActionRow>();
  if (kinds.length === 0) return out;
  const rows = openDb()
    .query<ActionDbRow, { kinds: string }>(
      `SELECT a.* FROM actions a
       JOIN (SELECT MAX(id) AS id FROM actions WHERE kind IN (SELECT value FROM json_each($kinds)) GROUP BY target_id) m
         ON m.id = a.id`,
    )
    .all({ kinds: JSON.stringify(kinds) });
  for (const r of rows) out.set(r.target_id, toAction(r));
  return out;
}

// ---------------------------------------------------------------- entities

type EntityDbRow = Omit<EntityRow, "kind" | "sports"> & { kind: string; sports_json: string };
const ENTITY_COLS =
  "e.id, e.kind, e.name, e.normalized_name, e.domain, e.website, e.municipality, e.sports_json, e.product_id, e.first_seen, e.last_seen, e.signal_count";
const toEntity = ({ sports_json, kind, ...r }: EntityDbRow): EntityRow => ({
  ...r,
  kind: kind === "person" ? "person" : "organisation",
  sports: JSON.parse(sports_json) as string[],
});

/**
 * Dedup lookup: canonical domain first (when given); otherwise exact normalized name. When a domain is given
 * the name fallback only matches rows without a domain (two different domains are two organisations).
 */
export function findEntity(domain: string | null, normalizedName: string): EntityRow | null {
  const db = openDb();
  if (domain) {
    const byDomain = db
      .query<EntityDbRow, { d: string }>(`SELECT ${ENTITY_COLS} FROM entities e WHERE e.domain = $d ORDER BY e.first_seen ASC, e.rowid ASC LIMIT 1`)
      .get({ d: domain });
    if (byDomain) return toEntity(byDomain);
  }
  const byName = db
    .query<EntityDbRow, { n: string; anyDomain: number }>(
      `SELECT ${ENTITY_COLS} FROM entities e
       WHERE e.normalized_name = $n AND ($anyDomain = 1 OR e.domain IS NULL)
       ORDER BY e.first_seen ASC, e.rowid ASC LIMIT 1`,
    )
    .get({ n: normalizedName, anyDomain: domain ? 0 : 1 });
  return byName ? toEntity(byName) : null;
}

/** INSERT OR IGNORE: an existing id is left untouched. */
export function insertEntity(e: EntityRow): void {
  const { sports, ...rest } = e;
  openDb()
    .query(
      `INSERT OR IGNORE INTO entities
       (id, kind, name, normalized_name, domain, website, municipality, sports_json, product_id, first_seen, last_seen, signal_count)
       VALUES ($id, $kind, $name, $normalized_name, $domain, $website, $municipality, $sports_json, $product_id, $first_seen, $last_seen, $signal_count)`,
    )
    .run({ ...rest, sports_json: JSON.stringify(sports) });
}

/** Moves last_seen forward and fills only fields that are still empty (null, or [] for sports). */
export function touchEntity(
  id: string,
  patch: { last_seen: string; website?: string | null; domain?: string | null; municipality?: string | null; sports?: string[] },
): void {
  openDb()
    .query(
      `UPDATE entities SET
         last_seen = MAX(last_seen, $last_seen),
         website = COALESCE(website, $website),
         domain = COALESCE(domain, $domain),
         municipality = COALESCE(municipality, $municipality),
         sports_json = CASE WHEN sports_json = '[]' AND $sports IS NOT NULL THEN $sports ELSE sports_json END
       WHERE id = $id`,
    )
    .run({
      id,
      last_seen: patch.last_seen,
      website: patch.website ?? null,
      domain: patch.domain ?? null,
      municipality: patch.municipality ?? null,
      sports: patch.sports && patch.sports.length > 0 ? JSON.stringify(patch.sports) : null,
    });
}

/** Links an item to an entity (idempotent) and recounts the entity's signal_count. */
export function linkEntityItem(entityId: string, itemId: string): void {
  const db = openDb();
  db.transaction(() => {
    db.query("INSERT OR IGNORE INTO entity_items (entity_id, item_id) VALUES ($e, $i)").run({ e: entityId, i: itemId });
    db.query("UPDATE entities SET signal_count = (SELECT COUNT(*) FROM entity_items WHERE entity_id = $e) WHERE id = $e").run({
      e: entityId,
    });
  })();
}

/** Scored items linked to an entity, newest first. */
export function entityItems(entityId: string): ScoredItem[] {
  return openDb()
    .query<ScoredRow, { e: string }>(
      `SELECT ${SCORED_COLS}
       FROM entity_items ei JOIN scores s ON s.item_id = ei.item_id JOIN items i ON i.id = s.item_id
       WHERE ei.entity_id = $e
       ORDER BY i.created_at DESC`,
    )
    .all({ e: entityId })
    .map(toScored);
}

export function getEntity(id: string): EntityRow | null {
  const row = openDb().query<EntityDbRow, { id: string }>(`SELECT ${ENTITY_COLS} FROM entities e WHERE e.id = $id`).get({ id });
  return row ? toEntity(row) : null;
}

/** Non-irrelevant scored items from runs on or after `sinceRunDate` that have not been through entity extraction. */
export function itemsPendingEntities(sinceRunDate: string): ScoredItem[] {
  return openDb()
    .query<ScoredRow, { since: string }>(
      `SELECT ${SCORED_COLS}
       FROM scores s JOIN items i ON i.id = s.item_id
       WHERE s.entities_at IS NULL AND s.tier != 'irrelevant' AND s.run_date >= $since
       ORDER BY s.run_date ASC, i.created_at ASC`,
    )
    .all({ since: sinceRunDate })
    .map(toScored);
}

export function markEntitiesExtracted(itemIds: string[], at: number): void {
  if (itemIds.length === 0) return;
  openDb()
    .query("UPDATE scores SET entities_at = $at WHERE item_id IN (SELECT value FROM json_each($ids))")
    .run({ at, ids: JSON.stringify(itemIds) });
}

/**
 * Organisation entities of the given products with no lead row, or whose lead was last researched before
 * `staleBefore` (YYYY-MM-DD). Order: signal_count desc, best linked tier first, last_seen desc.
 */
export function researchQueue(productIds: string[], staleBefore: string, limit: number): EntityRow[] {
  if (productIds.length === 0 || limit <= 0) return [];
  return openDb()
    .query<EntityDbRow, { pids: string; stale: string; limit: number }>(
      `SELECT ${ENTITY_COLS}
       FROM entities e LEFT JOIN leads l ON l.id = e.id
       WHERE e.kind = 'organisation'
         AND e.product_id IN (SELECT value FROM json_each($pids))
         AND (l.id IS NULL OR l.last_researched IS NULL OR l.last_researched < $stale)
       ORDER BY e.signal_count DESC,
         COALESCE((SELECT MIN(${TIER_RANK_SQL("s.tier")}) FROM entity_items ei JOIN scores s ON s.item_id = ei.item_id
                   WHERE ei.entity_id = e.id), 9) ASC,
         e.last_seen DESC
       LIMIT $limit`,
    )
    .all({ pids: JSON.stringify(productIds), stale: staleBefore, limit })
    .map(toEntity);
}

// ---------------------------------------------------------------- leads

type LeadDbRow = Omit<
  LeadRow,
  "sports" | "member_count" | "signals" | "digital_stack" | "contacts" | "score" | "call_brief" | "status" | "classification"
> & {
  sports_json: string;
  member_count_json: string | null;
  signals_json: string;
  digital_stack_json: string;
  contacts_json: string;
  score_json: string;
  call_brief_json: string | null;
  status: string;
  classification: string;
};

function toLead(r: LeadDbRow): LeadRow {
  const {
    sports_json,
    member_count_json,
    signals_json,
    digital_stack_json,
    contacts_json,
    score_json,
    call_brief_json,
    status,
    classification,
    ...rest
  } = r;
  return {
    ...rest,
    sports: JSON.parse(sports_json) as string[],
    member_count: member_count_json ? (JSON.parse(member_count_json) as MemberCount | null) : null,
    signals: JSON.parse(signals_json) as Signal[],
    digital_stack: JSON.parse(digital_stack_json) as StackEntry[],
    contacts: JSON.parse(contacts_json) as Contact[],
    score: JSON.parse(score_json) as ScoreJson,
    call_brief: call_brief_json ? (JSON.parse(call_brief_json) as string[] | null) : null,
    status: status as LeadStatus,
    classification: classification as Classification,
  };
}

const LEAD_SELECT = "SELECT * FROM leads";

export function getLead(id: string): LeadRow | null {
  const row = openDb().query<LeadDbRow, { id: string }>(`${LEAD_SELECT} WHERE id = $id`).get({ id });
  return row ? toLead(row) : null;
}

/** Highest total first, then newest first_seen. */
export function allLeads(): LeadRow[] {
  return openDb().query<LeadDbRow, []>(`${LEAD_SELECT} ORDER BY total DESC, first_seen DESC`).all().map(toLead);
}

/** Inserts or replaces a lead; on conflict status, note, salgsro_exported_at and first_seen are kept. */
export function upsertLead(l: LeadRow): void {
  openDb()
    .query(
      `INSERT INTO leads
       (id, product_id, org_name, website, domain, municipality, sports_json, member_count_json, signals_json,
        digital_stack_json, contacts_json, score_json, total, classification, pain_hypothesis, opportunity_hypothesis,
        call_brief_json, status, note, salgsro_exported_at, first_seen, last_researched, research_cost_usd)
       VALUES ($id, $product_id, $org_name, $website, $domain, $municipality, $sports_json, $member_count_json, $signals_json,
        $digital_stack_json, $contacts_json, $score_json, $total, $classification, $pain_hypothesis, $opportunity_hypothesis,
        $call_brief_json, $status, $note, $salgsro_exported_at, $first_seen, $last_researched, $research_cost_usd)
       ON CONFLICT(id) DO UPDATE SET
         product_id = excluded.product_id, org_name = excluded.org_name, website = excluded.website,
         domain = excluded.domain, municipality = excluded.municipality, sports_json = excluded.sports_json,
         member_count_json = excluded.member_count_json, signals_json = excluded.signals_json,
         digital_stack_json = excluded.digital_stack_json, contacts_json = excluded.contacts_json,
         score_json = excluded.score_json, total = excluded.total, classification = excluded.classification,
         pain_hypothesis = excluded.pain_hypothesis, opportunity_hypothesis = excluded.opportunity_hypothesis,
         call_brief_json = excluded.call_brief_json, last_researched = excluded.last_researched,
         research_cost_usd = excluded.research_cost_usd`,
    )
    .run({
      id: l.id,
      product_id: l.product_id,
      org_name: l.org_name,
      website: l.website,
      domain: l.domain,
      municipality: l.municipality,
      sports_json: JSON.stringify(l.sports),
      member_count_json: l.member_count ? JSON.stringify(l.member_count) : null,
      signals_json: JSON.stringify(l.signals),
      digital_stack_json: JSON.stringify(l.digital_stack),
      contacts_json: JSON.stringify(l.contacts),
      score_json: JSON.stringify(l.score),
      total: l.total,
      classification: l.classification,
      pain_hypothesis: l.pain_hypothesis,
      opportunity_hypothesis: l.opportunity_hypothesis,
      call_brief_json: l.call_brief ? JSON.stringify(l.call_brief) : null,
      status: l.status,
      note: l.note,
      salgsro_exported_at: l.salgsro_exported_at,
      first_seen: l.first_seen,
      last_researched: l.last_researched,
      research_cost_usd: l.research_cost_usd,
    });
}

/** Leads whose last_researched is exactly `date` (YYYY-MM-DD): used for the daily research cap. */
export function countLeadsResearchedOn(date: string): number {
  return (
    openDb().query<{ n: number }, { d: string }>("SELECT COUNT(*) AS n FROM leads WHERE last_researched = $d").get({ d: date })
      ?.n ?? 0
  );
}

export function setLeadStatus(id: string, status: LeadStatus): void {
  openDb().query("UPDATE leads SET status = $status WHERE id = $id").run({ id, status });
}

export function setLeadNote(id: string, note: string): void {
  openDb().query("UPDATE leads SET note = $note WHERE id = $id").run({ id, note });
}

export function markLeadsExported(ids: string[], at: number): void {
  if (ids.length === 0) return;
  openDb()
    .query("UPDATE leads SET salgsro_exported_at = $at WHERE id IN (SELECT value FROM json_each($ids))")
    .run({ at, ids: JSON.stringify(ids) });
}

// ---------------------------------------------------------------- ideas + intel

type IdeaDbRow = Omit<IdeaRow, "kind" | "gap_refs"> & { kind: string; gap_refs_json: string };

/** INSERT OR REPLACE by id. */
export function insertIdeas(rows: IdeaRow[]): void {
  if (rows.length === 0) return;
  const db = openDb();
  const insert = db.query(
    `INSERT OR REPLACE INTO ideas (id, product_id, week, title, why, kind, gap_refs_json, created_at)
     VALUES ($id, $product_id, $week, $title, $why, $kind, $gap_refs_json, $created_at)`,
  );
  db.transaction(() => {
    for (const { gap_refs, ...r } of rows) insert.run({ ...r, gap_refs_json: JSON.stringify(gap_refs) });
  })();
}

export function ideasForWeek(week: string): IdeaRow[] {
  return openDb()
    .query<IdeaDbRow, { w: string }>(
      "SELECT id, product_id, week, title, why, kind, gap_refs_json, created_at FROM ideas WHERE week = $w ORDER BY product_id, id",
    )
    .all({ w: week })
    .map(({ gap_refs_json, kind, ...r }) => ({
      ...r,
      kind: kind as IdeaRow["kind"],
      gap_refs: JSON.parse(gap_refs_json) as string[],
    }));
}

/** Scored App Store reviews whose scoring run_date is between fromDate and toDate (inclusive), newest first. */
export function reviewsScoredBetween(fromDate: string, toDate: string): ScoredItem[] {
  return openDb()
    .query<ScoredRow, { from: string; to: string }>(
      `SELECT ${SCORED_COLS}
       FROM scores s JOIN items i ON i.id = s.item_id
       WHERE i.kind = 'review' AND s.run_date BETWEEN $from AND $to
       ORDER BY i.created_at DESC`,
    )
    .all({ from: fromDate, to: toDate })
    .map(toScored);
}
