import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
  DATA_DIR,
  FETCH_THREAD_CONTEXT,
  LOCK_PATH,
  MAX_SCORED_PER_DAY,
  MODEL,
  loadConfig,
  localTime,
  requireApiKey,
  runDate,
} from "./config.ts";
import type { Config } from "./config.ts";
import {
  countPassed,
  countScored,
  getDailyStats,
  insertItems,
  itemsPendingPrefilter,
  openDb,
  savePrefilter,
  saveScores,
  scoredForDate,
  unscoredCandidates,
  upsertDailyStats,
} from "./db.ts";
import type { DailyStats, Item, PrefilterRow } from "./db.ts";
import { compileMatchers, prefilterItem, selectCandidates } from "./prefilter.ts";
import { leadCount, renderReport, tallyLeads, writeStatsFile } from "./report.ts";
import { SCORING_BODY_MAX, scoreItems } from "./score.ts";
import type { ScoreInput } from "./score.ts";
import { STRATEGIES, fetchThreadContext } from "./strategies/index.ts";
import type { CollectResult } from "./strategies/index.ts";
import { errMsg } from "./strategies/shared.ts";

const LOCK_MAX_AGE_MS = 2 * 3600 * 1000;

function log(msg: string): void {
  console.log(`${localTime(new Date(), true)} ${msg}`);
}

function parseArgs(argv: string[]): { reportOnly: boolean; date?: string } {
  const reportOnly = argv.includes("--report-only");
  const i = argv.indexOf("--date");
  const date = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error("--date must be YYYY-MM-DD");
  if (date && !reportOnly) throw new Error("--date is only valid with --report-only");
  return { reportOnly, date };
}

let haveLock = false;

function acquireLock(): boolean {
  mkdirSync(DATA_DIR, { recursive: true });
  try {
    writeFileSync(LOCK_PATH, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" });
    haveLock = true;
    return true;
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e;
    if (Date.now() - statSync(LOCK_PATH).mtimeMs < LOCK_MAX_AGE_MS) return false;
    log("removing stale lock (older than 2h)");
    rmSync(LOCK_PATH, { force: true });
    return acquireLock();
  }
}

function releaseLock(): void {
  if (!haveLock) return;
  rmSync(LOCK_PATH, { force: true });
  haveLock = false;
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    releaseLock();
    process.exit(code);
  });
}

async function safeCollect(name: string, fn: () => Promise<CollectResult>): Promise<CollectResult> {
  try {
    return await fn();
  } catch (e) {
    return { items: [], errors: [`${name} pass failed: ${errMsg(e)}`], notes: [] };
  }
}

function dedupeById(items: Item[]): Item[] {
  const seen = new Map<string, Item>();
  for (const it of items) if (!seen.has(it.id)) seen.set(it.id, it);
  return [...seen.values()];
}

async function runDaily(cfg: Config): Promise<void> {
  const products = cfg.products;
  const started = Date.now();
  const now = Math.floor(started / 1000);
  const errors: string[] = [];
  const notes: string[] = [];
  openDb();
  log(`run ${runDate} · model ${MODEL} · products ${products.map((p) => p.id).join(", ")}`);

  const active = STRATEGIES.filter((s) => {
    const on = s.enabled(cfg);
    if (on === true) return true;
    notes.push(on);
    log(`${s.id}: skipped (${on})`);
    return false;
  });
  const results = await Promise.all(active.map((s) => safeCollect(s.id, () => s.collect(cfg, now, log))));
  for (const r of results) {
    errors.push(...r.errors);
    notes.push(...r.notes);
  }
  const fetched = dedupeById(results.flatMap((r) => r.items));
  const breakdown = active.map((s, i) => `${s.id} ${results[i]!.items.length}`).join(", ");
  log(`fetched ${fetched.length} (${breakdown})`);
  notes.push(`fetched: ${breakdown}`);

  const { inserted, dups } = insertItems(fetched);
  log(`new ${inserted} (${dups} content duplicates)`);

  const matchers = compileMatchers(cfg);
  const pending = itemsPendingPrefilter();
  const rows: PrefilterRow[] = pending.map((item) => {
    if (item.found_via.startsWith("dup:")) {
      return {
        item_id: item.id,
        passed: false,
        local_score: 0,
        product_hints: [],
        reason: `duplicate of ${item.found_via.slice(4)}`,
        run_date: runDate,
        lang: null,
      };
    }
    const r = prefilterItem(item, matchers, now);
    return {
      item_id: item.id,
      passed: r.pass,
      local_score: r.localScore,
      product_hints: r.productHints,
      reason: r.reason,
      run_date: runDate,
      lang: r.lang,
    };
  });
  savePrefilter(rows);
  log(`prefilter: ${rows.filter((r) => r.passed).length}/${rows.length} passed`);

  const remainingCap = Math.max(0, MAX_SCORED_PER_DAY - countScored(runDate));
  const { selected, cut } = selectCandidates(unscoredCandidates(now), remainingCap);
  if (cut > 0) notes.push(`${cut} prefilter candidates not scored (MAX_SCORED_PER_DAY=${MAX_SCORED_PER_DAY})`);

  let replies = new Map<string, string[]>();
  if (FETCH_THREAD_CONTEXT && selected.length > 0) {
    try {
      const ctx = await fetchThreadContext(
        selected.map((c) => c.item),
        log,
      );
      replies = ctx.replies;
      errors.push(...ctx.errors);
    } catch (e) {
      errors.push(`thread context failed: ${errMsg(e)}`);
    }
  }

  const inputs: ScoreInput[] = selected.map(({ item, hints }) => ({
    id: item.id,
    source: item.source,
    channel: item.subreddit,
    kind: item.kind,
    ageH: (now - item.created_at) / 3600,
    title: item.title,
    body: item.body.slice(0, SCORING_BODY_MAX),
    topReplies: replies.get(item.id),
    numComments: item.num_comments,
    locked: item.locked,
    rating: item.rating,
    hints,
  }));
  log(`score: ${inputs.length} candidates${cut > 0 ? ` (${cut} cut)` : ""}`);
  const scoring = await scoreItems(inputs, products, MODEL, log);
  saveScores(scoring.results, runDate, MODEL, Math.floor(Date.now() / 1000));
  errors.push(...scoring.errors);
  log(`scored ${scoring.results.length}/${inputs.length} in ${scoring.calls} calls · $${scoring.costUsd.toFixed(4)}`);

  const prev = getDailyStats(runDate);
  const tally = tallyLeads(scoredForDate(runDate));
  const finished = Date.now();
  // fetched reflects the latest run only; new_items and api_cost_usd accumulate across same-day reruns.
  const stats: DailyStats = {
    run_date: runDate,
    fetched: fetched.length,
    new_items: (prev?.new_items ?? 0) + inserted,
    prefiltered: countPassed(runDate),
    scored: countScored(runDate),
    leads_json: JSON.stringify(tally),
    api_cost_usd: (prev?.api_cost_usd ?? 0) + scoring.costUsd,
    errors: errors.length,
    duration_s: Math.round((finished - started) / 1000),
    finished_at: Math.floor(finished / 1000),
    cut,
    notes: JSON.stringify([...notes, ...errors]),
  };
  upsertDailyStats(stats);
  const path = renderReport(runDate, cfg);
  writeStatsFile();
  log(`done: ${leadCount(tally)} leads · ${errors.length} errors · report ${path}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  if (args.reportOnly) {
    const path = renderReport(args.date ?? runDate, cfg);
    writeStatsFile();
    log(`report written: ${path}`);
    return 0;
  }

  requireApiKey();
  if (!acquireLock()) {
    log(`another run holds ${LOCK_PATH} (younger than 2h); exiting`);
    return 0;
  }
  try {
    await runDaily(cfg);
    return 0;
  } finally {
    releaseLock();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    releaseLock();
    console.error(`fatal: ${errMsg(e)}`);
    process.exit(1);
  },
);
