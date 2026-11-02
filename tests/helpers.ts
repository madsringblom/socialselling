import type Anthropic from "@anthropic-ai/sdk";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, localDate } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { insertEntity, insertItems, saveScores, upsertLead } from "../src/db.ts";
import type { EntityRow, Item, LeadRow, ScoreRow, ScoredItem } from "../src/db.ts";
import type { PlayCtx } from "../src/plays/index.ts";

export const nowS = () => Math.floor(Date.now() / 1000);

/**
 * A fresh SQLite file in a temp dir. DB_PATH is set before db.ts is (dynamically) imported; because the module
 * may already be loaded by another test file, the connection is also closed and reopened on the new path.
 */
export async function tempDb(): Promise<{ db: Database; path: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "ss-"));
  const path = join(dir, "social.db");
  process.env.DB_PATH = path;
  const mod = await import("../src/db.ts");
  mod.closeDb();
  const db = mod.openDb(path);
  return {
    db,
    path,
    cleanup: () => {
      mod.closeDb();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function seedItem(partial: Partial<Item> & { id: string }): Item {
  const now = nowS();
  const item: Item = {
    source: "reddit",
    kind: "post",
    url: `https://example.com/${encodeURIComponent(partial.id)}`,
    title: `Title ${partial.id}`,
    body: `Body ${partial.id}`,
    author: "someone",
    subreddit: "freelance",
    parent_id: null,
    created_at: now - 3600,
    fetched_at: now,
    found_via: "test",
    num_comments: 0,
    score_ups: 0,
    locked: false,
    content_hash: "",
    lang: "en",
    rating: null,
    ...partial,
  };
  insertItems([item]);
  return item;
}

export function seedScore(itemId: string, partial: Partial<ScoreRow> & { run_date?: string } = {}): void {
  const { run_date, ...rest } = partial;
  const row: ScoreRow = {
    item_id: itemId,
    matched_product: "alpha",
    tier: "asking_for_tool",
    confidence: 0.9,
    reason: "needs a tool",
    flags: { already_answered: false, old_or_locked: false, mentions_competitor: false, non_english: false },
    insight: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    ...rest,
  };
  saveScores([row], run_date ?? localDate(), "test-model", nowS());
}

export function seedLead(partial: Partial<LeadRow> & { id: string }): LeadRow {
  const component = { points: 0, basis: "none", evidence_url: null };
  const lead: LeadRow = {
    product_id: "beta",
    org_name: `Org ${partial.id}`,
    website: null,
    domain: null,
    municipality: null,
    sports: [],
    member_count: null,
    signals: [],
    digital_stack: [],
    contacts: [],
    score: {
      components: {
        intent: component,
        operational_pain: component,
        mio_fit: component,
        timing: component,
        reachability: component,
      },
      negative_adjustments: [],
    },
    total: 0,
    classification: "ARCHIVE",
    pain_hypothesis: null,
    opportunity_hypothesis: null,
    call_brief: null,
    status: "new",
    note: "",
    salgsro_exported_at: null,
    first_seen: localDate(),
    last_researched: null,
    research_cost_usd: 0,
    ...partial,
  };
  upsertLead(lead);
  return lead;
}

export function seedEntity(partial: Partial<EntityRow> & { id: string }): EntityRow {
  const today = localDate();
  const e: EntityRow = {
    kind: "organisation",
    name: `Entity ${partial.id}`,
    normalized_name: `entity ${partial.id}`.toLowerCase(),
    domain: null,
    website: null,
    municipality: null,
    sports: [],
    product_id: "beta",
    first_seen: today,
    last_seen: today,
    signal_count: 0,
    ...partial,
  };
  insertEntity(e);
  return e;
}

/** A ScoredItem object for pure-function tests (not stored). */
export function scored(partial: Partial<ScoredItem> & { id: string }): ScoredItem {
  const now = nowS();
  return {
    source: "reddit",
    kind: "post",
    url: `https://example.com/${encodeURIComponent(partial.id)}`,
    title: `Title ${partial.id}`,
    body: `Body ${partial.id}`,
    author: "someone",
    subreddit: "freelance",
    parent_id: null,
    created_at: now - 3600,
    fetched_at: now,
    found_via: "test",
    num_comments: 0,
    score_ups: 0,
    locked: false,
    content_hash: "",
    lang: "en",
    rating: null,
    matched_product: "alpha",
    tier: "asking_for_tool",
    confidence: 0.9,
    reason: "needs a tool",
    flags: { already_answered: false, old_or_locked: false, mentions_competitor: false, non_english: false },
    insight: null,
    ...partial,
  };
}

export function configFrom(yaml: string): Config {
  const dir = mkdtempSync(join(tmpdir(), "ss-cfg-"));
  const path = join(dir, "products.yaml");
  try {
    writeFileSync(path, yaml);
    return loadConfig(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const MINIMAL_YAML = `
products:
  - id: alpha
    name: Alpha
    url: https://alpha.example
    one_liner: "A daily follow-up list for freelancers."
    target_user: "Freelancers who sell their own services."
    problems_solved: ["I forget to follow up"]
    key_features: ["Today list of follow-ups", "Lightweight CRM with pipeline"]
    search_phrases: ["follow up with clients"]
    voice:
      examples: ["A daily list fixed this for me."]
      never_claim: ["pricing or a free plan", "automated outreach"]
      link: https://alpha.example
  - id: beta
    name: Beta
    url: https://beta.example
    one_liner: "A club app for shifts and chat."
    target_user: "Danish sports clubs."
    problems_solved: ["Volunteer shifts are a spreadsheet mess"]
    key_features: ["Shift rosters with auto-assign", "Events with RSVP"]
    search_phrases: ["vagtplan"]
    plays: { reply_drafts: false, lead_research: true }
    competitors:
      - name: Rival
        app_store: { id: 123456, countries: [dk, no] }
`;

/** alpha: default plays (reply_drafts), voice with link. beta: lead_research, reply_drafts off, competitor Rival. */
export function minimalConfig(): Config {
  return configFrom(MINIMAL_YAML);
}

export function testCtx(cfg: Config, now = nowS(), runDate = localDate(new Date(now * 1000))): PlayCtx {
  return { cfg, now, runDate, log: () => {} };
}

export function fakeUsage(input: number, output: number): Anthropic.Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: input,
    output_tokens: output,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
  };
}

export function scoreEntitiesAt(db: Database, itemId: string): number | null {
  return db.query<{ entities_at: number | null }, [string]>("SELECT entities_at FROM scores WHERE item_id = ?").get(itemId)?.entities_at ?? null;
}
