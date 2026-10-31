import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, REPORTS_DIR, STATS_PATH, localTime } from "./config.ts";
import type { Product } from "./config.ts";
import { allDailyStats, getDailyStats, recentDailyStats, scoredForDate } from "./db.ts";
import type { DailyStats, Flags, ScoredItem } from "./db.ts";
import { TIERS } from "./score.ts";
import type { Tier } from "./score.ts";

/** tier -> product id (or "none") -> count, over every scored item of the day. */
export type LeadTally = Record<Tier, Record<string, number>>;

const NONE = "none";
const LEAD_TIERS: Tier[] = ["asking_for_tool", "describing_problem"];
const MAX_NOTES = 40;

export function tallyLeads(rows: ScoredItem[]): LeadTally {
  const tally = Object.fromEntries(TIERS.map((t) => [t, {}])) as LeadTally;
  for (const r of rows) {
    const bucket = tally[r.tier as Tier];
    if (!bucket) continue;
    const key = r.matched_product ?? NONE;
    bucket[key] = (bucket[key] ?? 0) + 1;
  }
  return tally;
}

const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);

export function leadCount(t: LeadTally): number {
  return LEAD_TIERS.reduce((n, tier) => n + sum(t[tier]), 0);
}

function parseTally(json: string): LeadTally {
  const raw = JSON.parse(json || "{}") as Partial<LeadTally>;
  return Object.fromEntries(TIERS.map((t) => [t, raw[t] ?? {}])) as LeadTally;
}

/** Non-irrelevant items for one product key across tiers. */
function productHits(t: LeadTally, key: string): number {
  return TIERS.filter((tier) => tier !== "irrelevant").reduce((n, tier) => n + (t[tier][key] ?? 0), 0);
}

function fmtDuration(s: number): string {
  const total = Math.round(s);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

function ago(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const md = (s: string) => s.replace(/([\\`*_[\]<>|])/g, "\\$1");
const where = (r: ScoredItem) => (r.source === "hn" ? "HN" : `r/${r.subreddit}`);

const FLAG_LABELS: [keyof Flags, string][] = [
  ["already_answered", "answered"],
  ["old_or_locked", "old/locked"],
  ["mentions_competitor", "competitor"],
  ["non_english", "non-English"],
];

function leadEntry(r: ScoredItem, refTime: number): string {
  const flags = FLAG_LABELS.filter(([k]) => r.flags[k]).map(([, label]) => label);
  const meta = [where(r), r.kind, ago(refTime - r.created_at), `conf ${r.confidence.toFixed(2)}`];
  if (flags.length) meta.push(`flags: ${flags.join(", ")}`);
  const lines = [`- **[${md(oneLine(r.title) || "(untitled)")}](${r.url})** — ${meta.join(" · ")}`];
  const body = oneLine(r.body);
  if (body) lines.push(`  > ${md(body.slice(0, 200))}${body.length > 200 ? "…" : ""}`);
  lines.push(`  _Reason: ${md(r.reason)}_`);
  return lines.join("\n");
}

function productGroups(rows: ScoredItem[], products: Product[]): { label: string; rows: ScoredItem[] }[] {
  const groups = products.map((p) => ({ label: p.name, rows: rows.filter((r) => r.matched_product === p.id) }));
  groups.push({ label: "No product", rows: rows.filter((r) => !r.matched_product || !products.some((p) => p.id === r.matched_product)) });
  return groups.filter((g) => g.rows.length > 0);
}

function weekTable(stats: DailyStats[], products: Product[]): string[] {
  const head = ["Date", "Fetched", "Prefilter", "Scored", "Ask", "Problem", "Mention", ...products.map((p) => p.name), "$"];
  const lines = [`| ${head.join(" | ")} |`, `|${head.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`];
  const totals = new Array<number>(head.length - 1).fill(0);
  for (const s of stats) {
    const t = parseTally(s.leads_json);
    const cells = [
      s.fetched,
      s.prefiltered,
      s.scored,
      sum(t.asking_for_tool),
      sum(t.describing_problem),
      sum(t.passing_mention),
      ...products.map((p) => productHits(t, p.id)),
      s.api_cost_usd,
    ];
    for (const [i, v] of cells.entries()) totals[i] = (totals[i] ?? 0) + v;
    lines.push(`| ${s.run_date} | ${cells.map((v, i) => (i === cells.length - 1 ? v.toFixed(2) : String(v))).join(" | ")} |`);
  }
  lines.push(
    `| **Total** | ${totals.map((v, i) => `**${i === totals.length - 1 ? v.toFixed(2) : String(v)}**`).join(" | ")} |`,
  );
  return lines;
}

/** Renders reports/<date>.md from the DB and returns its path. */
export function renderReport(date: string, products: Product[]): string {
  const stats = getDailyStats(date);
  const rows = scoredForDate(date);
  const tally = tallyLeads(rows);
  const refTime = stats?.finished_at || Math.floor(Date.now() / 1000);
  const out: string[] = [];

  if (stats) {
    const started = new Date((stats.finished_at - stats.duration_s) * 1000);
    out.push(`# Leads — ${date} (run ${localTime(started)}, ${fmtDuration(stats.duration_s)})`, "");
    out.push(
      `Funnel: fetched ${stats.fetched} → new ${stats.new_items} → prefilter ${stats.prefiltered} → scored ${rows.length} → leads ${leadCount(tally)} (cut: ${stats.cut})`,
    );
  } else {
    out.push(`# Leads — ${date} (no run recorded)`, "");
    out.push(`Funnel: scored ${rows.length} → leads ${leadCount(tally)}`);
  }
  out.push(
    `Tiers: ${TIERS.map((t) => `${t} ${sum(tally[t])}`).join(" · ")}`,
    `By product: ${[...products.map((p) => `${p.name} ${productHits(tally, p.id)}`), `none ${productHits(tally, NONE)}`].join(" · ")}   |   API cost $${(stats?.api_cost_usd ?? 0).toFixed(2)} · errors ${stats?.errors ?? 0}`,
    "",
  );

  out.push("## Week to date", "", ...weekTable(recentDailyStats(date, 7), products), "");

  for (const tier of LEAD_TIERS) {
    out.push(`## ${tier}`, "");
    const groups = productGroups(rows.filter((r) => r.tier === tier), products);
    if (groups.length === 0) out.push("_None._", "");
    for (const g of groups) {
      out.push(`### ${g.label} (${g.rows.length})`, "", ...g.rows.map((r) => leadEntry(r, refTime)), "");
    }
  }

  out.push("## passing_mention", "");
  const mentions = rows.filter((r) => r.tier === "passing_mention");
  if (mentions.length === 0) out.push("_None._");
  for (const r of mentions) {
    const product = products.find((p) => p.id === r.matched_product)?.name ?? "no product";
    out.push(`- [${md(oneLine(r.title) || "(untitled)")}](${r.url}) — ${product} · ${where(r)} — ${md(r.reason)}`);
  }
  out.push("");

  out.push("## Top subreddits for leads today", "");
  const bySub = new Map<string, number>();
  for (const r of rows) if (r.tier !== "irrelevant") bySub.set(where(r), (bySub.get(where(r)) ?? 0) + 1);
  const subs = [...bySub.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (subs.length === 0) out.push("_None._");
  for (const [sub, n] of subs) out.push(`- ${sub}: ${n}`);
  out.push("");

  out.push("## Errors / notes", "");
  const notes = stats ? (JSON.parse(stats.notes || "[]") as string[]) : ["No run recorded for this date."];
  if (notes.length === 0) out.push("_None._");
  for (const n of notes.slice(0, MAX_NOTES)) out.push(`- ${md(n)}`);
  if (notes.length > MAX_NOTES) out.push(`- …and ${notes.length - MAX_NOTES} more`);
  out.push("");

  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${date}.md`);
  writeFileSync(path, out.join("\n"));
  return path;
}

/** Rewrites data/stats.jsonl from daily_stats: one line per run_date, oldest first. */
export function writeStatsFile(): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const lines = allDailyStats().map((s) =>
    JSON.stringify({
      run_date: s.run_date,
      fetched: s.fetched,
      new_items: s.new_items,
      prefiltered: s.prefiltered,
      scored: s.scored,
      leads: parseTally(s.leads_json),
      cost_usd: Number(s.api_cost_usd.toFixed(6)),
      errors: s.errors,
      duration_s: s.duration_s,
    }),
  );
  writeFileSync(STATS_PATH, lines.map((l) => `${l}\n`).join(""));
  return STATS_PATH;
}
