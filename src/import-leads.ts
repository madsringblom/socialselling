/**
 * Imports leads from a mio-lead-research leads.jsonl into the leads table (and a matching organisation entity).
 * Usage: bun src/import-leads.ts <path> [--product <id>]
 * Re-importing keeps each lead's status, note, Salgsro export time and first_seen.
 */
import { readFileSync } from "node:fs";
import { loadConfig, localDate } from "./config.ts";
import type { Config } from "./config.ts";
import { getLead, insertEntity, upsertLead } from "./db.ts";
import type { Contact, LeadRow, MemberCount, ScoreComponent, ScoreJson, Signal, StackEntry } from "./db.ts";
import { canonicalDomain, normalizeName } from "./plays/entities.ts";
import { httpOrNull, scoreLead } from "./plays/leadscore.ts";
import { errMsg } from "./strategies/shared.ts";

/** The subset of the mio-lead-research lead record (mio-leads/README.md) that is imported. */
type RawLead = {
  id?: unknown;
  org_name?: unknown;
  website?: string | null;
  domain?: string | null;
  municipality?: string | null;
  sports?: string[] | null;
  member_count?: MemberCount | null;
  opportunity_score?: {
    total?: number;
    components?: Partial<ScoreJson["components"]>;
    negative_adjustments?: ScoreJson["negative_adjustments"];
    classification?: string;
  } | null;
  first_seen?: string | null;
  last_researched?: string | null;
  signals?:
    | {
        signal_family: string;
        signal_type: string;
        classification: Signal["classification"];
        evidence_summary: string;
        source_url?: string | null;
        source_published_date?: string | null;
        discovered_date?: string | null;
        confidence: Signal["confidence"];
      }[]
    | null;
  digital_stack?: (Omit<StackEntry, "source_url" | "observed_date"> & { source_url?: string | null; observed_date?: string | null })[] | null;
  public_contact?: (Omit<Contact, "source_url" | "retrieved_date"> & { source_url?: string | null; retrieved_date?: string | null })[] | null;
  pain_hypothesis?: string | null;
  mio_opportunity_hypothesis?: string | null;
};

const EMPTY_COMPONENT: ScoreComponent = { points: 0, basis: "not recorded", evidence_url: null };

function component(c: ScoreComponent | undefined): ScoreComponent {
  return c ? { points: c.points, basis: c.basis, evidence_url: c.evidence_url ?? null } : { ...EMPTY_COMPONENT };
}

/** Maps one leads.jsonl record to a LeadRow (status 'new', empty note; upsertLead keeps both on re-import). */
export function mapLead(raw: RawLead, productId: string, today = localDate()): LeadRow {
  if (typeof raw.id !== "string" || !raw.id) throw new Error("missing id");
  if (typeof raw.org_name !== "string" || !raw.org_name.trim()) throw new Error("missing org_name");
  const website = httpOrNull(raw.website);
  const mc = raw.member_count ?? null;
  const domain = raw.domain?.trim() || (website ? canonicalDomain(website) : null);
  const os: NonNullable<RawLead["opportunity_score"]> = raw.opportunity_score ?? {};
  const comps: Partial<ScoreJson["components"]> = os.components ?? {};
  const score: ScoreJson = {
    components: {
      intent: component(comps.intent),
      operational_pain: component(comps.operational_pain),
      mio_fit: component(comps.mio_fit),
      timing: component(comps.timing),
      reachability: component(comps.reachability),
    },
    negative_adjustments: os.negative_adjustments ?? [],
  };
  const firstSeen = raw.first_seen || today;

  return {
    id: raw.id,
    product_id: productId,
    org_name: raw.org_name.trim(),
    website,
    domain,
    municipality: raw.municipality ?? null,
    sports: raw.sports ?? [],
    member_count: mc ? { ...mc, source_url: httpOrNull(mc.source_url) } : null,
    signals: (raw.signals ?? []).map(
      (s): Signal => ({
        family: s.signal_family,
        type: s.signal_type,
        classification: s.classification,
        evidence_summary: s.evidence_summary,
        source_url: httpOrNull(s.source_url),
        source_published_date: s.source_published_date ?? null,
        discovered_date: s.discovered_date ?? null,
        confidence: s.confidence,
      }),
    ),
    digital_stack: (raw.digital_stack ?? []).flatMap((d): StackEntry[] => {
      const url = httpOrNull(d.source_url);
      return url
        ? [
            {
              system: d.system,
              category: d.category,
              source_url: url,
              classification: d.classification,
              observed_date: d.observed_date ?? null,
            },
          ]
        : [];
    }),
    contacts: (raw.public_contact ?? []).flatMap((c): Contact[] => {
      const url = httpOrNull(c.source_url);
      return url
        ? [
            {
              name: c.name ?? null,
              role: c.role ?? null,
              email: c.email ?? null,
              phone: c.phone ?? null,
              source_url: url,
              retrieved_date: c.retrieved_date ?? null,
            },
          ]
        : [];
    }),
    // Recomputed with the rubric's rules (clamps, evidence URLs); the record's own total is not trusted.
    ...scoreLead(score),
    pain_hypothesis: raw.pain_hypothesis ?? null,
    opportunity_hypothesis: raw.mio_opportunity_hypothesis ?? null,
    call_brief: null,
    status: "new",
    note: "",
    salgsro_exported_at: null,
    first_seen: firstSeen,
    last_researched: raw.last_researched ?? null,
    research_cost_usd: 0,
  };
}

/** Default product: the first with plays.lead_research. */
export function resolveProduct(cfg: Config, requested?: string): string {
  if (requested) {
    if (!cfg.products.some((p) => p.id === requested)) throw new Error(`unknown product "${requested}"`);
    return requested;
  }
  const p = cfg.products.find((x) => x.plays.lead_research);
  if (!p) throw new Error("no product has plays.lead_research; pass --product <id>");
  return p.id;
}

export function importLeadsFile(path: string, productId: string): { imported: number; updated: number } {
  const lines = readFileSync(path, "utf8").split("\n");
  const leads: LeadRow[] = [];
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      leads.push(mapLead(JSON.parse(line) as RawLead, productId));
    } catch (e) {
      throw new Error(`${path} line ${i + 1}: ${errMsg(e)}`);
    }
  }
  let updated = 0;
  for (const lead of leads) {
    if (getLead(lead.id)) updated++;
    upsertLead(lead);
    insertEntity({
      id: lead.id,
      kind: "organisation",
      name: lead.org_name,
      normalized_name: normalizeName(lead.org_name),
      domain: lead.domain,
      website: lead.website,
      municipality: lead.municipality,
      sports: lead.sports,
      product_id: productId,
      first_seen: lead.first_seen,
      last_seen: lead.last_researched ?? lead.first_seen,
      signal_count: 0,
    });
  }
  return { imported: leads.length, updated };
}

function main(argv: string[]): void {
  const path = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--product");
  const pi = argv.indexOf("--product");
  const requested = pi >= 0 ? argv[pi + 1] : undefined;
  if (!path) throw new Error("usage: bun src/import-leads.ts <path> [--product <id>]");
  if (pi >= 0 && !requested) throw new Error("--product needs an id");
  const productId = resolveProduct(loadConfig(), requested);
  const { imported, updated } = importLeadsFile(path, productId);
  console.log(`imported ${imported} leads (${updated} updated)`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`import-leads: ${errMsg(e)}`);
    process.exit(1);
  }
}
