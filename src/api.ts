/**
 * Read models for the local web UI (src/server.ts): DTO builders and the Today / Pipeline / Intel / Setup
 * assemblers. Reads only through db.ts helpers; never writes.
 */
import {
  DRAFT_EXPIRY_H,
  DRAFT_MIN_CONFIDENCE,
  MAX_DRAFTS_PER_DAY,
  MAX_RESEARCH_PER_DAY,
  TZ,
  addDays,
  isoWeek,
  localDate,
  localTime,
  startOfLocalDay,
} from "./config.ts";
import type { Config, Plays } from "./config.ts";
import {
  allLeads,
  draftedItems,
  draftsForItem,
  getDailyStats,
  getLead,
  ideasForWeek,
  latestActionByTarget,
  recentDailyStats,
} from "./db.ts";
import type {
  ActionRow,
  Classification,
  Contact,
  DraftVariant,
  IdeaRow,
  LeadRow,
  LeadStatus,
  MemberCount,
  ScoreJson,
  ScoredItem,
  Signal,
  StackEntry,
} from "./db.ts";
import { digest } from "./plays/intel.ts";
import type { Digest } from "./plays/intel.ts";
import { COMPONENT_LABEL, COMPONENT_MAX, topSignal } from "./plays/leadscore.ts";
import { STRATEGIES } from "./strategies/index.ts";

/** Today shows at most this many open items. */
export const TODAY_CAP = 5;
/** Action kinds that decide whether an item or lead is open, later, skipped or posted (latest wins). */
export const STATE_KINDS = ["skip", "later", "posted", "undo_posted"];

export type ItemState = "open" | "later" | "skipped" | "posted";

export type ReplyDTO = {
  kind: "reply";
  id: string;
  product: string;
  product_name: string;
  source: string;
  source_label: string;
  channel: string;
  kind_item: "post" | "comment";
  age_h: number;
  author: string;
  url: string;
  title: string;
  text: string;
  lang: string | null;
  tier: string;
  confidence: number;
  flags: string[];
  reason: string;
  created_at: number;
  expires_at: number;
  expires_h: number;
  state: ItemState;
  drafts: {
    default: string;
    no_link: string;
    redraft: string | null;
    current: { id: string; variant: DraftVariant; text: string };
  };
  rating: "good" | "needs_work" | null;
};

export type LeadDTO = {
  kind: "lead";
  id: string;
  product: string;
  product_name: string;
  org_name: string;
  domain: string | null;
  website: string | null;
  municipality: string | null;
  sports: string[];
  member_count: MemberCount | null;
  total: number;
  classification: Classification;
  status: LeadStatus;
  note: string;
  salgsro_exported_at: number | null;
  /** CSV file of the latest Salgsro export of this lead, if any. */
  salgsro_path: string | null;
  first_seen: string;
  last_researched: string | null;
  found_h: number;
  top_signal: string | null;
  breakdown: { key: string; label: string; value: number; max: number; why: string; evidence_url: string | null }[];
  adjustments: ScoreJson["negative_adjustments"];
  signals: Signal[];
  stack: StackEntry[];
  contacts: Contact[];
  call_brief: string[] | null;
  brief_note: string | null;
  pain_hypothesis: string | null;
  opportunity_hypothesis: string | null;
  research_cost_usd: number;
  state: "open" | "later" | "skipped";
};

export type RunInfo = {
  date: string;
  label: string;
  week: string;
  next: string;
  hours_to_noon: number;
  now: number;
  has_run: boolean;
};

export type ProductNames = Record<string, { name: string }>;

export type TodayDTO = {
  run: RunInfo;
  items: (ReplyDTO | LeadDTO)[];
  later: (ReplyDTO | LeadDTO)[];
  counts: { open: number; expiring_before_noon: number; intel_new_gaps: number };
  products: ProductNames;
};

export type PipelineDTO = { run: RunInfo; leads: LeadDTO[]; products: ProductNames };

export type IdeaState = "open" | "saved" | "dismissed";
export type IntelDTO = Digest & { run: RunInfo; ideas: (IdeaRow & { state: IdeaState })[]; products: ProductNames };

export type SourceDTO = { id: string; name: string; status: "on" | "off" | "unavailable"; last: string | null; note: string };

export type SetupDTO = {
  run: RunInfo;
  funnel: { fetched: number; by_source: string; signals: number; actions: number; cost: string };
  sources: SourceDTO[];
  plays: Record<string, Plays>;
  play_locks: Record<string, string>;
  products: { id: string; name: string; one_liner: string; phrases: number; competitors: number; queries: number }[];
  schedule: string;
  runs: { date: string; fetched: number; signals: number; cost: string }[];
  caps: { max_drafts_per_day: number; draft_min_confidence: number; max_research_per_day: number; draft_expiry_h: number };
};

// ---------------------------------------------------------------- dates

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const dateOf = (now: number) => localDate(new Date(now * 1000));

/** "Mon 2 Nov" for a YYYY-MM-DD date. */
function dayLabel(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DOW[dow] ?? ""} ${d} ${MONTHS[m - 1] ?? ""}`;
}

/** Epoch seconds of the next 12:00 in TZ after `now`. */
function nextNoon(now: number): number {
  const date = dateOf(now);
  const noon = startOfLocalDay(date) + 12 * 3600;
  return now < noon ? noon : startOfLocalDay(addDays(date, 1)) + 12 * 3600;
}

export function runInfo(now: number): RunInfo {
  const date = dateOf(now);
  const stats = getDailyStats(date);
  const hasRun = !!stats && stats.finished_at > 0;
  const label =
    stats && stats.finished_at > 0
      ? `${dayLabel(date)} · run ${localTime(new Date((stats.finished_at - stats.duration_s) * 1000))}`
      : `${dayLabel(date)} · no run yet`;
  const hour = Number(localTime(new Date(now * 1000)).slice(0, 2));
  return {
    date,
    label,
    week: isoWeek(date).key,
    next: !hasRun && hour < 7 ? "today 07:00" : "tomorrow 07:00",
    hours_to_noon: Math.round(((nextNoon(now) - now) / 3600) * 10) / 10,
    now,
    has_run: hasRun,
  };
}

// ---------------------------------------------------------------- replies

export function stateOf(id: string, actions: Map<string, ActionRow>): ItemState {
  switch (actions.get(id)?.kind) {
    case "skip":
      return "skipped";
    case "later":
      return "later";
    case "posted":
      return "posted";
    default:
      return "open"; // none, or undo_posted
  }
}

const STORE_LANG: Record<string, string> = { dk: "da", no: "nb" };

function langOf(item: ScoredItem): string | null {
  if (item.kind === "review") return STORE_LANG[item.id.split(":")[1] ?? ""] ?? "en";
  if (item.lang === "en") return "en";
  if (item.lang === "da" || item.flags.non_english) return "da";
  return null;
}

function flagLabels(item: ScoredItem, lang: string | null): string[] {
  const out: string[] = [];
  if (item.flags.non_english) out.push(lang === "da" ? "Danish" : "Non-English");
  if (item.flags.mentions_competitor) out.push("Mentions competitor");
  if (item.flags.already_answered) out.push("Already answered");
  if (item.flags.old_or_locked) out.push("Old or locked");
  return out;
}

function sourceLabel(item: ScoredItem): string {
  switch (item.source) {
    case "reddit":
      return `r/${item.subreddit}`;
    case "hn":
      return "Hacker News";
    case "bluesky":
      return "Bluesky";
    case "appstore":
      return "App Store";
    default:
      return "News";
  }
}

function ratingOf(a: ActionRow | undefined): "good" | "needs_work" | null {
  const r = (a?.payload as { rating?: unknown } | null | undefined)?.rating;
  return r === "good" || r === "needs_work" ? r : null;
}

const productName = (cfg: Config, id: string | null) => cfg.products.find((p) => p.id === id)?.name ?? id ?? "";

/** `ratings`: latest 'rating' action per item (pass it when building many DTOs). */
export function replyDTO(
  item: ScoredItem,
  cfg: Config,
  now: number,
  actions: Map<string, ActionRow>,
  ratings: Map<string, ActionRow> = latestActionByTarget(["rating"]),
): ReplyDTO {
  const drafts = draftsForItem(item.id); // newest first
  const newest = (v: DraftVariant) => drafts.find((d) => d.variant === v);
  const def = newest("default");
  const current = drafts.find((d) => d.variant !== "no_link");
  const lang = langOf(item);
  const expiresAt = item.created_at + DRAFT_EXPIRY_H * 3600;
  return {
    kind: "reply",
    id: item.id,
    product: item.matched_product ?? "",
    product_name: productName(cfg, item.matched_product),
    source: item.source,
    source_label: sourceLabel(item),
    channel: item.subreddit,
    kind_item: item.kind === "comment" ? "comment" : "post",
    age_h: Math.max(0, Math.floor((now - item.created_at) / 3600)),
    author: item.author,
    url: item.url,
    title: item.title,
    text: item.body,
    lang,
    tier: item.tier,
    confidence: item.confidence,
    flags: flagLabels(item, lang),
    reason: item.reason,
    created_at: item.created_at,
    expires_at: expiresAt,
    expires_h: Math.max(0, Math.ceil((expiresAt - now) / 3600)),
    state: stateOf(item.id, actions),
    drafts: {
      default: def?.text ?? "",
      no_link: newest("no_link")?.text ?? def?.text ?? "",
      redraft: newest("redraft")?.text ?? null,
      current: current ? { id: current.id, variant: current.variant, text: current.text } : { id: "", variant: "default", text: "" },
    },
    rating: ratingOf(ratings.get(item.id)),
  };
}

// ---------------------------------------------------------------- leads

const COMPONENT_KEYS = ["intent", "operational_pain", "mio_fit", "timing", "reachability"] as const;

function foundHours(firstSeen: string, now: number): number {
  if (!YMD.test(firstSeen)) return 0;
  return Math.max(0, Math.floor((now - startOfLocalDay(firstSeen)) / 3600));
}

/** `exportActs`: latest 'salgsro_export' action per lead (pass it when building many DTOs). */
export function leadDTO(
  l: LeadRow,
  cfg: Config,
  now: number,
  actions: Map<string, ActionRow>,
  exportActs: Map<string, ActionRow> = latestActionByTarget(["salgsro_export"]),
): LeadDTO {
  const comps: Partial<ScoreJson["components"]> = l.score?.components ?? {};
  const breakdown = COMPONENT_KEYS.map((key) => {
    const c = comps[key];
    return {
      key,
      label: COMPONENT_LABEL[key],
      value: c?.points ?? 0,
      max: COMPONENT_MAX[key],
      why: c?.basis ?? "",
      evidence_url: c?.evidence_url ?? null,
    };
  });
  const brief = l.call_brief && l.call_brief.length > 0 ? l.call_brief : null;
  const exportPath = (exportActs.get(l.id)?.payload as { path?: unknown } | null | undefined)?.path;
  const state = stateOf(l.id, actions);
  return {
    kind: "lead",
    id: l.id,
    product: l.product_id,
    product_name: productName(cfg, l.product_id),
    org_name: l.org_name,
    domain: l.domain,
    website: l.website,
    municipality: l.municipality,
    sports: l.sports,
    member_count: l.member_count,
    total: l.total,
    classification: l.classification,
    status: l.status,
    note: l.note,
    salgsro_exported_at: l.salgsro_exported_at,
    salgsro_path: typeof exportPath === "string" ? exportPath : null,
    first_seen: l.first_seen,
    last_researched: l.last_researched,
    found_h: foundHours(l.first_seen, now),
    top_signal: topSignal(l)?.evidence_summary ?? null,
    breakdown,
    adjustments: l.score?.negative_adjustments ?? [],
    signals: l.signals,
    stack: l.digital_stack,
    contacts: l.contacts,
    call_brief: brief,
    brief_note: brief
      ? null
      : l.classification === "WATCH" || l.classification === "ARCHIVE"
        ? "Not worth a call yet. Watch for new signals."
        : "No call brief yet. Run research to get one.",
    pain_hypothesis: l.pain_hypothesis,
    opportunity_hypothesis: l.opportunity_hypothesis,
    research_cost_usd: l.research_cost_usd,
    state: state === "posted" ? "open" : state,
  };
}

/** One lead as a DTO, or null when the id is unknown. */
export function leadView(id: string, cfg: Config, now: number): LeadDTO | null {
  const l = getLead(id);
  return l ? leadDTO(l, cfg, now, latestActionByTarget(STATE_KINDS)) : null;
}

function productNames(cfg: Config): ProductNames {
  return Object.fromEntries(cfg.products.map((p) => [p.id, { name: p.name }]));
}

// ---------------------------------------------------------------- views

/**
 * Today: reply drafts that have not expired (open or later, products with reply_drafts), then new leads from the
 * last 7 days (status new, not in Salgsro). `items` holds the open ones, capped at 5; `later` everything put off.
 */
export function today(cfg: Config, now: number): TodayDTO {
  const date = dateOf(now);
  const actions = latestActionByTarget(STATE_KINDS);
  const ratings = latestActionByTarget(["rating"]);
  const exportActs = latestActionByTarget(["salgsro_export"]);
  const drafting = new Set(cfg.products.filter((p) => p.plays.reply_drafts).map((p) => p.id));

  const replies = draftedItems(now - DRAFT_EXPIRY_H * 3600)
    .filter((i) => i.matched_product !== null && drafting.has(i.matched_product))
    .map((i) => replyDTO(i, cfg, now, actions, ratings))
    .filter((r) => r.state === "open" || r.state === "later");

  const since = addDays(date, -7);
  const leads = allLeads() // total desc
    .filter((l) => l.status === "new" && l.salgsro_exported_at === null && l.first_seen >= since)
    .map((l) => leadDTO(l, cfg, now, actions, exportActs))
    .filter((l) => l.state === "open" || l.state === "later");

  const items: (ReplyDTO | LeadDTO)[] = [
    ...replies.filter((r) => r.state === "open"),
    ...leads.filter((l) => l.state === "open"),
  ].slice(0, TODAY_CAP);
  const later: (ReplyDTO | LeadDTO)[] = [
    ...replies.filter((r) => r.state === "later"),
    ...leads.filter((l) => l.state === "later"),
  ];
  const noon = nextNoon(now);

  return {
    run: runInfo(now),
    items,
    later,
    counts: {
      open: items.length,
      expiring_before_noon: items.filter((i) => i.kind === "reply" && i.expires_at < noon).length,
      intel_new_gaps: digest(cfg, isoWeek(date).key, now).gaps.length,
    },
    products: productNames(cfg),
  };
}

/** Every lead, highest total first. */
export function pipeline(cfg: Config, now: number): PipelineDTO {
  const actions = latestActionByTarget(STATE_KINDS);
  const exportActs = latestActionByTarget(["salgsro_export"]);
  return {
    run: runInfo(now),
    leads: allLeads().map((l) => leadDTO(l, cfg, now, actions, exportActs)),
    products: productNames(cfg),
  };
}

function ideaState(a: ActionRow | undefined): IdeaState {
  if (a?.kind === "idea_saved") return "saved";
  if (a?.kind === "idea_dismissed") return "dismissed";
  return "open";
}

/** The competitor digest for an ISO week (default: the current one) plus that week's ideas and their state. */
export function intel(cfg: Config, now: number, week?: string): IntelDTO {
  const d = digest(cfg, week ?? isoWeek(dateOf(now)).key, now);
  const acts = latestActionByTarget(["idea_saved", "idea_unsaved", "idea_dismissed"]);
  return {
    ...d,
    run: runInfo(now),
    ideas: ideasForWeek(d.week).map((i) => ({ ...i, state: ideaState(acts.get(i.id)) })),
    products: productNames(cfg),
  };
}

const SOURCE_NAMES: Record<string, string> = {
  reddit: "Reddit",
  hn: "Hacker News",
  bluesky: "Bluesky",
  appstore: "App Store reviews",
  rss: "News & feeds",
};

function sourceNote(id: string, cfg: Config): string {
  if (id === "appstore") {
    return cfg.products
      .flatMap((p) => p.competitors.flatMap((c) => (c.app_store ? [`${c.name} ${c.app_store.countries.join(", ")}`] : [])))
      .join(" · ");
  }
  if (id === "rss") {
    const queries = cfg.products.reduce((n, p) => n + p.news_queries.length, 0);
    return `${queries} Bing ${queries === 1 ? "query" : "queries"} · ${cfg.feeds.length} ${cfg.feeds.length === 1 ? "feed" : "feeds"}`;
  }
  return "";
}

function parseNotes(json: string | undefined): string[] {
  try {
    const v: unknown = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Non-irrelevant scored items in a daily_stats leads_json tally (tier → product → count). */
function signalCount(leadsJson: string | undefined): number {
  try {
    const t = JSON.parse(leadsJson || "{}") as Record<string, Record<string, number> | undefined>;
    let n = 0;
    for (const [tier, byProduct] of Object.entries(t)) {
      if (tier === "irrelevant" || !byProduct) continue;
      for (const v of Object.values(byProduct)) n += typeof v === "number" ? v : 0;
    }
    return n;
  } catch {
    return 0;
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Today's run, sources, plays per product (read-only: edit products.yaml / .env), products, schedule and caps. */
export function setup(cfg: Config, now: number): SetupDTO {
  const date = dateOf(now);
  const stats = getDailyStats(date);
  const fetchedNote = parseNotes(stats?.notes).find((n) => n.startsWith("fetched:"));
  const perSource = new Map<string, number>();
  for (const part of (fetchedNote?.slice("fetched:".length) ?? "").split(",")) {
    const m = /^\s*(\S+)\s+(\d+)\s*$/.exec(part);
    if (m?.[1] && m[2]) perSource.set(m[1], Number(m[2]));
  }
  const runTime = stats && stats.finished_at > 0 ? localTime(new Date((stats.finished_at - stats.duration_s) * 1000)) : null;

  const sources: SourceDTO[] = STRATEGIES.map((s): SourceDTO => {
    const name = SOURCE_NAMES[s.id] ?? s.id;
    const on = s.enabled(cfg);
    if (on === true) {
      const n = perSource.get(s.id);
      return { id: s.id, name, status: "on", last: runTime && n !== undefined ? `${runTime} · ${n} items` : null, note: sourceNote(s.id, cfg) };
    }
    if (s.id === "reddit") {
      return { id: s.id, name, status: "unavailable", last: null, note: "Set REDDIT_CLIENT_ID/SECRET; API closes March 2027" };
    }
    return { id: s.id, name, status: "off", last: null, note: on };
  });
  sources.push({ id: "gplay", name: "Google Play", status: "unavailable", last: null, note: "No official feed" });

  const playLocks: Record<string, string> = {};
  for (const p of cfg.products) {
    if (!p.plays.lead_research) playLocks[`${p.id}:lead_research`] = "Off for people. We don't research individuals.";
  }

  return {
    run: runInfo(now),
    funnel: {
      fetched: stats?.fetched ?? 0,
      by_source: fetchedNote ? fetchedNote.slice("fetched:".length).trim().split(/,\s*/).join(" · ") : "no run yet",
      signals: signalCount(stats?.leads_json),
      actions: today(cfg, now).items.length,
      cost: usd(stats?.api_cost_usd ?? 0),
    },
    sources,
    plays: Object.fromEntries(cfg.products.map((p) => [p.id, { ...p.plays }])),
    play_locks: playLocks,
    products: cfg.products.map((p) => ({
      id: p.id,
      name: p.name,
      one_liner: p.one_liner,
      phrases: p.search_phrases.length + p.bluesky.danish_phrases.length,
      competitors: p.competitors.length,
      queries: p.news_queries.length,
    })),
    schedule: `Daily 07:00 ${TZ} via launchd`,
    runs: recentDailyStats(date, 3)
      .reverse()
      .map((s) => ({ date: s.run_date, fetched: s.fetched, signals: signalCount(s.leads_json), cost: usd(s.api_cost_usd) })),
    caps: {
      max_drafts_per_day: MAX_DRAFTS_PER_DAY,
      draft_min_confidence: DRAFT_MIN_CONFIDENCE,
      max_research_per_day: MAX_RESEARCH_PER_DAY,
      draft_expiry_h: DRAFT_EXPIRY_H,
    },
  };
}
