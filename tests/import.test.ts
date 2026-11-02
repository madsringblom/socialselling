import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEntity, getLead, setLeadNote, setLeadStatus } from "../src/db.ts";
import { importLeadsFile, resolveProduct } from "../src/import-leads.ts";
import { minimalConfig, tempDb } from "./helpers.ts";

// Synthetic record in the mio-lead-research leads.jsonl shape (no real organisation or contact data).
const component = (points: number, url: string | null) => ({ points, basis: "test basis", evidence_url: url });
const RECORD = {
  id: "lead_0123456789",
  org_name: "Testby Idrætsforening",
  website: "https://www.testby-if.dk/",
  domain: null,
  municipality: "Testby Kommune",
  sports: ["fodbold", "håndbold"],
  member_count: { value: 420, as_of: "2026-03-01", source_url: "https://testby-if.dk/om", classification: "FACT", confidence: "high" },
  opportunity_score: {
    total: 71,
    components: {
      intent: component(25, "https://testby-if.dk/referat.pdf"),
      operational_pain: component(20, "https://testby-if.dk/frivillige"),
      mio_fit: component(10, "https://testby-if.dk/om"),
      timing: component(6, null),
      reachability: component(10, "https://testby-if.dk/kontakt"),
    },
    negative_adjustments: [],
    classification: "STRONG",
  },
  lead_status: "new",
  first_seen: "2026-08-13",
  last_researched: "2026-08-14",
  signals: [
    {
      signal_family: "volunteer_coordination",
      signal_type: "unfilled kiosk shifts",
      classification: "FACT",
      evidence_summary: "Minutes say kiosk shifts are hard to fill.",
      source_url: "https://testby-if.dk/referat.pdf",
      source_published_date: "2026-05-04",
      discovered_date: "2026-08-13",
      confidence: "high",
    },
  ],
  digital_stack: [
    { system: "Conventus", category: "membership_admin", source_url: "https://testby-if.dk/medlem", classification: "FACT", observed_date: "2026-08-13" },
    { system: "Unknown", category: "other", source_url: null, classification: "INFERENCE", observed_date: null },
  ],
  public_contact: [
    { name: null, role: "Formand", email: "formand@testby-if.dk", phone: null, source_url: "https://testby-if.dk/kontakt", retrieved_date: "2026-08-13" },
  ],
  pain_hypothesis: "Volunteer coordination is manual.",
  mio_opportunity_hypothesis: "Shift rosters could help.",
  sales_feedback: [],
};

let t: Awaited<ReturnType<typeof tempDb>>;
let dir: string;
beforeEach(async () => {
  t = await tempDb();
  dir = mkdtempSync(join(tmpdir(), "ss-import-"));
});
afterEach(() => {
  t.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

test("resolveProduct defaults to the first product with lead_research", () => {
  const cfg = minimalConfig();
  expect(resolveProduct(cfg)).toBe("beta");
  expect(resolveProduct(cfg, "alpha")).toBe("alpha");
  expect(() => resolveProduct(cfg, "nope")).toThrow();
});

test("import maps fields, creates the entity, and keeps status/note on re-import", () => {
  const path = join(dir, "leads.jsonl");
  writeFileSync(path, `${JSON.stringify(RECORD)}\n\n`);

  expect(importLeadsFile(path, "beta")).toEqual({ imported: 1, updated: 0 });
  const lead = getLead(RECORD.id)!;
  expect(lead).not.toBeNull();
  expect(lead.product_id).toBe("beta");
  expect(lead.domain).toBe("testby-if.dk");
  expect(lead.sports).toEqual(["fodbold", "håndbold"]);
  expect(lead.member_count?.value).toBe(420);
  expect(lead.total).toBe(71);
  expect(lead.classification).toBe("STRONG");
  expect(lead.score.components.intent.points).toBe(25);
  expect(lead.signals).toEqual([
    {
      family: "volunteer_coordination",
      type: "unfilled kiosk shifts",
      classification: "FACT",
      evidence_summary: "Minutes say kiosk shifts are hard to fill.",
      source_url: "https://testby-if.dk/referat.pdf",
      source_published_date: "2026-05-04",
      discovered_date: "2026-08-13",
      confidence: "high",
    },
  ]);
  expect(lead.digital_stack.map((d) => d.system)).toEqual(["Conventus"]);
  expect(lead.contacts).toEqual([
    { name: null, role: "Formand", email: "formand@testby-if.dk", phone: null, source_url: "https://testby-if.dk/kontakt", retrieved_date: "2026-08-13" },
  ]);
  expect(lead.pain_hypothesis).toBe("Volunteer coordination is manual.");
  expect(lead.opportunity_hypothesis).toBe("Shift rosters could help.");
  expect(lead).toMatchObject({ status: "new", note: "", call_brief: null, first_seen: "2026-08-13", last_researched: "2026-08-14" });

  const entity = getEntity(RECORD.id)!;
  expect(entity).toMatchObject({
    kind: "organisation",
    normalized_name: "testby idrætsforening",
    domain: "testby-if.dk",
    product_id: "beta",
    first_seen: "2026-08-13",
    last_seen: "2026-08-14",
  });

  setLeadStatus(RECORD.id, "contacted");
  setLeadNote(RECORD.id, "called the chair");
  expect(importLeadsFile(path, "beta")).toEqual({ imported: 1, updated: 1 });
  expect(getLead(RECORD.id)).toMatchObject({ status: "contacted", note: "called the chair", total: 71 });
});

test("a bad line fails with its line number", () => {
  const path = join(dir, "bad.jsonl");
  writeFileSync(path, `${JSON.stringify(RECORD)}\n{not json\n`);
  expect(() => importLeadsFile(path, "beta")).toThrow(/line 2/);
});
