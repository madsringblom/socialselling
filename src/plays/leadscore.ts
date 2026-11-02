import type { Classification, Contact, LeadRow, MemberCount, ScoreComponent, ScoreJson, Signal, StackEntry } from "../db.ts";
import { isHttpUrl } from "../llm.ts";
import { canonicalDomain } from "./entities.ts";
import type { LeadOutput } from "./research.ts";

export const COMPONENT_MAX = { intent: 35, operational_pain: 25, mio_fit: 20, timing: 10, reachability: 10 } as const;
export const COMPONENT_LABEL = {
  intent: "Intent",
  operational_pain: "Pain",
  mio_fit: "Fit",
  timing: "Timing",
  reachability: "Reachability",
} as const;

type ComponentKey = keyof typeof COMPONENT_MAX;
const COMPONENT_KEYS: ComponentKey[] = ["intent", "operational_pain", "mio_fit", "timing", "reachability"];
/** Components that may score without their own evidence URL (they rest on the other components' evidence). */
const URL_EXEMPT = new Set<ComponentKey>(["timing", "reachability"]);
const NO_URL_NOTE = " (no evidence URL: 0 points)";
const MAX_CALL_BRIEF = 5;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const roundPoints = (n: number) => (Number.isFinite(n) ? Math.round(n) : 0);
const trimOrNull = (s: string | null | undefined): string | null => s?.trim() || null;
const httpOrNull = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return isHttpUrl(t) ? t : null;
};

/** HOT ≥75, STRONG 55–74, WATCH 35–54, ARCHIVE <35. */
export function classify(total: number): Classification {
  if (total >= 75) return "HOT";
  if (total >= 55) return "STRONG";
  if (total >= 35) return "WATCH";
  return "ARCHIVE";
}

function scoreComponent(key: ComponentKey, c: ScoreComponent): ScoreComponent {
  const points = clamp(roundPoints(c.points), 0, COMPONENT_MAX[key]);
  const url = httpOrNull(c.evidence_url);
  const basis = String(c.basis ?? "").trim(); // imported records may lack a basis
  if (!URL_EXEMPT.has(key) && !url) {
    // Only annotate when points were actually removed, so re-scoring is idempotent.
    return { points: 0, basis: points > 0 && !basis.endsWith(NO_URL_NOTE) ? `${basis}${NO_URL_NOTE}` : basis, evidence_url: null };
  }
  return { points, basis, evidence_url: url };
}

/**
 * Applies the rubric's hard rules: points rounded and clamped per component; intent, pain and fit need an http
 * evidence URL or score 0; negative adjustments need negative points and an http URL; total clamped to 0–100.
 */
export function scoreLead(s: ScoreJson): { score: ScoreJson; total: number; classification: Classification } {
  const c = s.components;
  const components: ScoreJson["components"] = {
    intent: scoreComponent("intent", c.intent),
    operational_pain: scoreComponent("operational_pain", c.operational_pain),
    mio_fit: scoreComponent("mio_fit", c.mio_fit),
    timing: scoreComponent("timing", c.timing),
    reachability: scoreComponent("reachability", c.reachability),
  };
  const negative_adjustments = s.negative_adjustments.flatMap((a) => {
    const points = roundPoints(a.points);
    const url = httpOrNull(a.evidence_url);
    return points < 0 && url ? [{ points, reason: String(a.reason ?? "").trim(), evidence_url: url }] : [];
  });
  const sum =
    COMPONENT_KEYS.reduce((acc, k) => acc + components[k].points, 0) + negative_adjustments.reduce((acc, a) => acc + a.points, 0);
  const total = clamp(sum, 0, 100);
  return { score: { components, negative_adjustments }, total, classification: classify(total) };
}

export type SanitizedLead = Omit<
  LeadRow,
  "id" | "product_id" | "status" | "note" | "salgsro_exported_at" | "first_seen" | "last_researched" | "research_cost_usd"
>;

/**
 * Turns the parsed research output into lead fields, enforcing the evidence rules in code:
 * non-http URLs become null; a FACT signal without a URL becomes HYPOTHESIS (counted in `downgraded`);
 * a FACT member count without a URL becomes INFERENCE; stack entries and contacts without an http URL are dropped.
 */
export function sanitize(out: LeadOutput, runDate: string): { lead: SanitizedLead; downgraded: number } {
  let downgraded = 0;

  const signals: Signal[] = out.signals.flatMap((s) => {
    const evidence = s.evidence_summary.trim();
    const type = s.type.trim();
    if (!evidence && !type) return [];
    const url = httpOrNull(s.source_url);
    let classification = s.classification;
    if (classification === "FACT" && !url) {
      classification = "HYPOTHESIS";
      downgraded++;
    }
    return [
      {
        family: s.family,
        type,
        classification,
        evidence_summary: evidence,
        source_url: url,
        source_published_date: trimOrNull(s.source_published_date),
        discovered_date: runDate,
        confidence: s.confidence,
      },
    ];
  });

  const mc = out.organisation.member_count;
  let member_count: MemberCount | null = null;
  if (mc && mc.value !== null && Number.isFinite(mc.value)) {
    const url = httpOrNull(mc.source_url);
    member_count = {
      value: Math.round(mc.value),
      as_of: trimOrNull(mc.as_of),
      source_url: url,
      classification: mc.classification === "FACT" && !url ? "INFERENCE" : mc.classification,
      confidence: mc.confidence,
    };
  }

  const digital_stack: StackEntry[] = out.digital_stack.flatMap((d) => {
    const url = httpOrNull(d.source_url);
    const system = d.system.trim();
    return url && system
      ? [{ system, category: d.category, source_url: url, classification: d.classification, observed_date: trimOrNull(d.observed_date) }]
      : [];
  });

  const contacts: Contact[] = out.contacts.flatMap((c) => {
    const url = httpOrNull(c.source_url);
    const contact = {
      name: trimOrNull(c.name),
      role: trimOrNull(c.role),
      email: trimOrNull(c.email),
      phone: trimOrNull(c.phone),
    };
    const empty = !contact.name && !contact.role && !contact.email && !contact.phone;
    return url && !empty ? [{ ...contact, source_url: url, retrieved_date: runDate }] : [];
  });

  const brief = out.call_brief.map((l) => l.trim()).filter(Boolean).slice(0, MAX_CALL_BRIEF);
  const website = httpOrNull(out.organisation.website);
  const scored = scoreLead({
    components: out.score_components,
    negative_adjustments: out.negative_adjustments.flatMap((a) => {
      const url = httpOrNull(a.evidence_url);
      return url ? [{ points: a.points, reason: a.reason, evidence_url: url }] : [];
    }),
  });

  return {
    lead: {
      org_name: out.organisation.name.trim(),
      website,
      domain: website ? canonicalDomain(website) : null,
      municipality: trimOrNull(out.organisation.municipality),
      sports: [...new Set(out.organisation.sports.map((s) => s.trim().toLowerCase()).filter(Boolean))],
      member_count,
      signals,
      digital_stack,
      contacts,
      score: scored.score,
      total: scored.total,
      classification: scored.classification,
      pain_hypothesis: trimOrNull(out.pain_hypothesis),
      opportunity_hypothesis: trimOrNull(out.opportunity_hypothesis),
      call_brief: brief.length > 0 ? brief : null,
    },
    downgraded,
  };
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const signalKey = (s: Signal) => (s.source_url ? `u|${norm(s.type)}|${s.source_url}` : `f|${norm(s.family)}|${norm(s.type)}`);
const stackKey = (s: StackEntry) => `${norm(s.system)}|${s.source_url}`;
const contactKey = (c: Contact) => norm(c.email) || norm(c.phone) || `${norm(c.name)}|${norm(c.role)}`;

/** Appends items of `fresh` whose key is not already in `existing` (or earlier in `fresh`). */
function appendNew<T>(existing: T[], fresh: T[], key: (x: T) => string): T[] {
  const seen = new Set(existing.map(key));
  const out = [...existing];
  for (const x of fresh) {
    const k = key(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/**
 * Re-research merge. Additive: new signals (by type + source_url, or family + type when unsourced), stack
 * entries (system + source_url) and contacts (email, else phone, else name + role) are appended. The member
 * count is replaced only by a sourced FACT (or when there was none); empty website/municipality are filled and
 * sports unioned. Score, total, classification, hypotheses and call brief come from the fresh research.
 * id, product_id, org_name, status, note, salgsro_exported_at and first_seen are kept.
 */
export function mergeLead(existing: LeadRow, fresh: SanitizedLead, runDate: string, costUsd: number): LeadRow {
  const fm = fresh.member_count;
  const member_count =
    existing.member_count === null || (fm !== null && fm.classification === "FACT" && isHttpUrl(fm.source_url))
      ? (fm ?? existing.member_count)
      : existing.member_count;
  const website = existing.website ?? fresh.website;
  return {
    ...existing,
    website,
    domain: existing.domain ?? (website ? canonicalDomain(website) : null),
    municipality: existing.municipality ?? fresh.municipality,
    sports: [...new Set([...existing.sports, ...fresh.sports])],
    member_count,
    signals: appendNew(existing.signals, fresh.signals, signalKey),
    digital_stack: appendNew(existing.digital_stack, fresh.digital_stack, stackKey),
    contacts: appendNew(existing.contacts, fresh.contacts, contactKey),
    score: fresh.score,
    total: fresh.total,
    classification: fresh.classification,
    pain_hypothesis: fresh.pain_hypothesis,
    opportunity_hypothesis: fresh.opportunity_hypothesis,
    call_brief: fresh.call_brief,
    last_researched: runDate,
    research_cost_usd: existing.research_cost_usd + costUsd,
  };
}

const CLS_RANK: Record<Signal["classification"], number> = { FACT: 0, INFERENCE: 1, HYPOTHESIS: 2 };
const CONF_RANK: Record<Signal["confidence"], number> = { high: 0, medium: 1, low: 2 };

/** The strongest signal: FACT first, then confidence high > medium > low, then newest source_published_date. */
export function topSignal(l: LeadRow): Signal | null {
  const sorted = [...l.signals].sort((a, b) => {
    const fact = (a.classification === "FACT" ? 0 : 1) - (b.classification === "FACT" ? 0 : 1);
    if (fact !== 0) return fact;
    const conf = (CONF_RANK[a.confidence] ?? 3) - (CONF_RANK[b.confidence] ?? 3);
    if (conf !== 0) return conf;
    const da = a.source_published_date ?? "";
    const db = b.source_published_date ?? "";
    if (da !== db) return da < db ? 1 : -1;
    return (CLS_RANK[a.classification] ?? 3) - (CLS_RANK[b.classification] ?? 3);
  });
  return sorted[0] ?? null;
}
