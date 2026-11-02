import { describe, expect, test } from "bun:test";
import type { LeadRow, ScoreComponent, ScoreJson, Signal } from "../src/db.ts";
import { classify, mergeLead, sanitize, scoreLead, topSignal } from "../src/plays/leadscore.ts";
import type { LeadOutput } from "../src/plays/research.ts";

const U = "https://klub.dk/referat.pdf";
const comp = (points: number, evidence_url: string | null = U, basis = "basis"): ScoreComponent => ({ points, basis, evidence_url });
const score = (p: Partial<ScoreJson["components"]> = {}, negative_adjustments: ScoreJson["negative_adjustments"] = []): ScoreJson => ({
  components: {
    intent: comp(0),
    operational_pain: comp(0),
    mio_fit: comp(0),
    timing: comp(0),
    reachability: comp(0),
    ...p,
  },
  negative_adjustments,
});

describe("classify", () => {
  test("thresholds", () => {
    expect(classify(100)).toBe("HOT");
    expect(classify(75)).toBe("HOT");
    expect(classify(74)).toBe("STRONG");
    expect(classify(55)).toBe("STRONG");
    expect(classify(54)).toBe("WATCH");
    expect(classify(35)).toBe("WATCH");
    expect(classify(34)).toBe("ARCHIVE");
    expect(classify(0)).toBe("ARCHIVE");
  });
});

describe("scoreLead", () => {
  test("clamps and rounds components", () => {
    const r = scoreLead(score({ intent: comp(40), operational_pain: comp(-3), mio_fit: comp(4.6), timing: comp(12), reachability: comp(10) }));
    expect(r.score.components.intent.points).toBe(35);
    expect(r.score.components.operational_pain.points).toBe(0);
    expect(r.score.components.mio_fit.points).toBe(5);
    expect(r.score.components.timing.points).toBe(10);
    expect(r.total).toBe(60);
    expect(r.classification).toBe("STRONG");
  });

  test("intent, pain and fit need an http evidence URL; timing and reachability do not", () => {
    const r = scoreLead(
      score({
        intent: comp(25, null, "project"),
        operational_pain: comp(10, "klub.dk/side"),
        mio_fit: comp(5, "  "),
        timing: comp(6, null),
        reachability: comp(5, "not a url"),
      }),
    );
    const c = r.score.components;
    expect(c.intent).toEqual({ points: 0, basis: "project (no evidence URL: 0 points)", evidence_url: null });
    expect(c.operational_pain.points).toBe(0);
    expect(c.mio_fit.points).toBe(0);
    expect(c.timing).toEqual({ points: 6, basis: "basis", evidence_url: null });
    expect(c.reachability).toEqual({ points: 5, basis: "basis", evidence_url: null });
    expect(r.total).toBe(11);
    // Idempotent: scoring the result again changes nothing.
    expect(scoreLead(r.score)).toEqual(r);
  });

  test("negative adjustments need negative points and an http URL; total floors at 0", () => {
    const r = scoreLead(
      score({ intent: comp(15) }, [
        { points: -10, reason: "rolled out a rival app", evidence_url: U },
        { points: -5, reason: "no url", evidence_url: "" },
        { points: 3, reason: "positive", evidence_url: U },
      ]),
    );
    expect(r.score.negative_adjustments).toEqual([{ points: -10, reason: "rolled out a rival app", evidence_url: U }]);
    expect(r.total).toBe(5);
    expect(scoreLead(score({ intent: comp(5) }, [{ points: -20, reason: "x", evidence_url: U }])).total).toBe(0);
  });

  test("the two imported records recompute to 71/STRONG and 37/WATCH", () => {
    const a = scoreLead(
      score({ intent: comp(15), operational_pain: comp(25), mio_fit: comp(15), timing: comp(6), reachability: comp(10) }),
    );
    expect([a.total, a.classification]).toEqual([71, "STRONG"]);
    const b = scoreLead(
      score({ intent: comp(15), operational_pain: comp(5), mio_fit: comp(5), timing: comp(2), reachability: comp(10) }),
    );
    expect([b.total, b.classification]).toEqual([37, "WATCH"]);
  });
});

function leadOutput(partial: Partial<LeadOutput> = {}): LeadOutput {
  const c = { points: 0, basis: "not assessed", evidence_url: null };
  return {
    organisation: { name: " Testby IF ", website: "https://www.testby-if.dk/", municipality: "Testby Kommune", sports: ["Fodbold", "fodbold", " håndbold "], member_count: null },
    signals: [],
    digital_stack: [],
    contacts: [],
    score_components: { intent: c, operational_pain: c, mio_fit: c, timing: c, reachability: c },
    negative_adjustments: [],
    pain_hypothesis: "Shifts are manual.",
    opportunity_hypothesis: "Shift rosters.",
    call_brief: [],
    ...partial,
  };
}

type OutSignal = LeadOutput["signals"][number];
const outSignal = (p: Partial<OutSignal> = {}): OutSignal => ({
  family: "volunteer_coordination",
  type: "unfilled kiosk shifts",
  classification: "FACT",
  evidence_summary: "Kiosk shifts are hard to fill.",
  source_url: U,
  source_published_date: "2026-05-04",
  confidence: "high",
  ...p,
});

describe("sanitize", () => {
  test("enforces the evidence rules", () => {
    const { lead, downgraded } = sanitize(
      leadOutput({
        organisation: {
          ...leadOutput().organisation,
          member_count: { value: 420, as_of: "2026", source_url: null, classification: "FACT", confidence: "medium" },
        },
        signals: [outSignal(), outSignal({ type: "no url", source_url: null }), outSignal({ type: "bad url", source_url: "testby-if.dk/x", classification: "INFERENCE" })],
        digital_stack: [
          { system: "Conventus", category: "membership_admin", source_url: "https://testby-if.dk/medlem", classification: "FACT", observed_date: null },
          { system: "Facebook", category: "facebook", source_url: null, classification: "INFERENCE", observed_date: null },
        ],
        contacts: [
          { name: null, role: "Formand", email: "formand@testby-if.dk", phone: null, source_url: "https://testby-if.dk/kontakt" },
          { name: "No Source", role: null, email: "x@y.dk", phone: null, source_url: null },
        ],
        call_brief: [" Ring til formanden ", "", "b", "c", "d", "e", "f"],
      }),
      "2026-11-02",
    );
    expect(downgraded).toBe(1);
    expect(lead.org_name).toBe("Testby IF");
    expect(lead.domain).toBe("testby-if.dk");
    expect(lead.sports).toEqual(["fodbold", "håndbold"]);
    expect(lead.signals.map((s) => [s.type, s.classification, s.source_url, s.discovered_date])).toEqual([
      ["unfilled kiosk shifts", "FACT", U, "2026-11-02"],
      ["no url", "HYPOTHESIS", null, "2026-11-02"],
      ["bad url", "INFERENCE", null, "2026-11-02"],
    ]);
    expect(lead.member_count).toEqual({ value: 420, as_of: "2026", source_url: null, classification: "INFERENCE", confidence: "medium" });
    expect(lead.digital_stack.map((d) => d.system)).toEqual(["Conventus"]);
    expect(lead.contacts).toEqual([
      { name: null, role: "Formand", email: "formand@testby-if.dk", phone: null, source_url: "https://testby-if.dk/kontakt", retrieved_date: "2026-11-02" },
    ]);
    expect(lead.call_brief).toEqual(["Ring til formanden", "b", "c", "d", "e"]);
  });

  test("empty call brief becomes null; non-http website becomes null", () => {
    const { lead } = sanitize(leadOutput({ organisation: { ...leadOutput().organisation, website: "testby-if.dk" }, call_brief: ["  "] }), "2026-11-02");
    expect(lead.call_brief).toBeNull();
    expect(lead.website).toBeNull();
    expect(lead.domain).toBeNull();
  });
});

function baseLead(partial: Partial<LeadRow> = {}): LeadRow {
  const s = scoreLead(score());
  return {
    id: "lead_x",
    product_id: "beta",
    org_name: "Testby IF",
    website: null,
    domain: null,
    municipality: null,
    sports: ["fodbold"],
    member_count: null,
    signals: [],
    digital_stack: [],
    contacts: [],
    score: s.score,
    total: s.total,
    classification: s.classification,
    pain_hypothesis: "old pain",
    opportunity_hypothesis: "old opp",
    call_brief: null,
    status: "contacted",
    note: "called once",
    salgsro_exported_at: 1700000000,
    first_seen: "2026-08-13",
    last_researched: "2026-08-14",
    research_cost_usd: 0.5,
    ...partial,
  };
}

const sig = (p: Partial<Signal>): Signal => ({
  family: "volunteer_coordination",
  type: "unfilled kiosk shifts",
  classification: "FACT",
  evidence_summary: "x",
  source_url: U,
  source_published_date: null,
  discovered_date: null,
  confidence: "medium",
  ...p,
});

describe("mergeLead", () => {
  test("appends new evidence, dedupes, keeps workflow fields, replaces score, sums cost", () => {
    const existing = baseLead({ signals: [sig({}), sig({ type: "unsourced", source_url: null, classification: "HYPOTHESIS" })] });
    const { lead: fresh } = sanitize(
      leadOutput({
        signals: [
          outSignal({ type: "Unfilled kiosk shifts" }), // same type + url → dup
          outSignal({ type: "unsourced", source_url: null, classification: "INFERENCE" }), // same family + type, no url → dup
          outSignal({ type: "new chair", family: "organisational_change", source_url: "https://testby-if.dk/nyt" }),
          outSignal({ type: "new chair", family: "organisational_change", source_url: "https://testby-if.dk/nyt" }), // dup within fresh
        ],
        score_components: {
          intent: comp(25),
          operational_pain: comp(10),
          mio_fit: comp(5),
          timing: comp(10),
          reachability: comp(5),
        },
        call_brief: ["a", "b", "c", "d", "e"],
      }),
      "2026-11-02",
    );
    const m = mergeLead(existing, fresh, "2026-11-02", 0.75);
    expect(m.signals.map((s) => s.type)).toEqual(["unfilled kiosk shifts", "unsourced", "new chair"]);
    expect(m).toMatchObject({
      id: "lead_x",
      product_id: "beta",
      org_name: "Testby IF",
      status: "contacted",
      note: "called once",
      salgsro_exported_at: 1700000000,
      first_seen: "2026-08-13",
      last_researched: "2026-11-02",
      total: 55,
      classification: "STRONG",
      pain_hypothesis: "Shifts are manual.",
      call_brief: ["a", "b", "c", "d", "e"],
      website: "https://www.testby-if.dk/",
      domain: "testby-if.dk",
      municipality: "Testby Kommune",
    });
    expect(m.research_cost_usd).toBeCloseTo(1.25, 10);
    expect(m.sports).toEqual(["fodbold", "håndbold"]);
  });

  test("member count is replaced only by a sourced FACT", () => {
    const existing = baseLead({
      member_count: { value: 300, as_of: "2025", source_url: U, classification: "FACT", confidence: "high" },
    });
    const withMc = (mc: NonNullable<LeadOutput["organisation"]["member_count"]>) =>
      sanitize(leadOutput({ organisation: { ...leadOutput().organisation, member_count: mc } }), "2026-11-02").lead;
    const inferred = withMc({ value: 500, as_of: null, source_url: null, classification: "INFERENCE", confidence: "low" });
    expect(mergeLead(existing, inferred, "2026-11-02", 0).member_count?.value).toBe(300);
    const fact = withMc({ value: 450, as_of: "2026", source_url: U, classification: "FACT", confidence: "high" });
    expect(mergeLead(existing, fact, "2026-11-02", 0).member_count?.value).toBe(450);
    expect(mergeLead(baseLead(), inferred, "2026-11-02", 0).member_count?.value).toBe(500);
  });
});

describe("topSignal", () => {
  test("FACT first, then confidence, then newest date", () => {
    expect(topSignal(baseLead())).toBeNull();
    const l = baseLead({
      signals: [
        sig({ type: "hyp-high", classification: "HYPOTHESIS", confidence: "high" }),
        sig({ type: "fact-med-old", confidence: "medium", source_published_date: "2025-01-01" }),
        sig({ type: "fact-med-new", confidence: "medium", source_published_date: "2026-06-01" }),
        sig({ type: "fact-low", confidence: "low", source_published_date: "2026-10-01" }),
      ],
    });
    expect(topSignal(l)?.type).toBe("fact-med-new");
    l.signals.push(sig({ type: "fact-high", confidence: "high" }));
    expect(topSignal(l)?.type).toBe("fact-high");
  });
});
