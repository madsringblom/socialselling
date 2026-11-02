import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { actionsFor, getLead } from "../src/db.ts";
import type { LeadRow, Signal } from "../src/db.ts";
import { CSV_HEADER, buildCsv, csvField, csvRow, exportSalgsro } from "../src/plays/salgsro.ts";
import { seedLead, tempDb } from "./helpers.ts";

const HEADER_LINE = "Navn;Firma;E-mail;Telefon;Hjemmeside;Rolle;Fase;Noter";

const fact = (url: string): Signal => ({
  family: "volunteer_coordination",
  type: "unfilled kiosk shifts",
  classification: "FACT",
  evidence_summary: "x",
  source_url: url,
  source_published_date: "2026-05-04",
  discovered_date: null,
  confidence: "high",
});

let t: Awaited<ReturnType<typeof tempDb>>;
let dir: string;
beforeEach(async () => {
  t = await tempDb();
  dir = mkdtempSync(join(tmpdir(), "ss-salgsro-"));
});
afterEach(() => {
  t.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function lead(partial: Partial<LeadRow> & { id: string }): LeadRow {
  return seedLead({ product_id: "beta", total: 71, classification: "STRONG", ...partial });
}

describe("csv", () => {
  test("header, BOM, separator", () => {
    const csv = buildCsv([]);
    expect(CSV_HEADER.join(";")).toBe(HEADER_LINE);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe(HEADER_LINE);
  });

  test("quoting", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a;b")).toBe('"a;b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
  });

  test("row with contact, brief and source; blanks without contact", () => {
    const l = lead({
      id: "lead_a",
      org_name: "Testby IF; Fodbold",
      website: "https://testby-if.dk",
      contacts: [{ name: "Jens", role: "Formand", email: "formand@testby-if.dk", phone: "+45 12 34 56 78", source_url: "https://testby-if.dk/kontakt", retrieved_date: null }],
      call_brief: ["Ring til formanden", 'Referatet siger "mangler hjælpere"', "Tredje linje"],
      signals: [fact("https://testby-if.dk/referat.pdf")],
    });
    expect(csvRow(l)).toEqual([
      "Jens",
      "Testby IF; Fodbold",
      "formand@testby-if.dk",
      "+45 12 34 56 78",
      "https://testby-if.dk",
      "Formand",
      "Lead",
      'STRONG 71/100 · Ring til formanden · Referatet siger "mangler hjælpere" · Kilde: https://testby-if.dk/referat.pdf',
    ]);
    const line = buildCsv([l]).split("\r\n")[1];
    expect(line).toBe(
      'Jens;"Testby IF; Fodbold";formand@testby-if.dk;+45 12 34 56 78;https://testby-if.dk;Formand;Lead;"STRONG 71/100 · Ring til formanden · Referatet siger ""mangler hjælpere"" · Kilde: https://testby-if.dk/referat.pdf"',
    );

    const bare = lead({ id: "lead_b", org_name: "Bare Klub", total: 37, classification: "WATCH" });
    expect(csvRow(bare)).toEqual(["", "Bare Klub", "", "", "", "", "Lead", "WATCH 37/100"]);
  });

  test("at most 200 rows", () => {
    const one = lead({ id: "lead_c" });
    const csv = buildCsv(Array.from({ length: 201 }, () => one));
    expect(csv.split("\r\n").length).toBe(201); // header + 200
  });
});

describe("exportSalgsro", () => {
  test("writes the CSV, marks leads exported and records actions", () => {
    lead({ id: "lead_a", org_name: "Alpha Klub", contacts: [{ name: null, role: "Formand", email: "a@a.dk", phone: null, source_url: "https://a.dk", retrieved_date: null }] });
    lead({ id: "lead_b", org_name: "Beta Klub" });
    const now = Math.floor(Date.now() / 1000);

    const r = exportSalgsro(["lead_a", "lead_b", "lead_unknown", "lead_a"], now, dir);
    expect(r.count).toBe(2);
    expect(dirname(r.path)).toBe(dir);
    expect(r.path).toMatch(/leads-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/);

    const text = readFileSync(r.path, "utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe(HEADER_LINE);
    expect(lines.length).toBe(3);
    expect(lines[1]).toBe(";Alpha Klub;a@a.dk;;;Formand;Lead;STRONG 71/100");
    expect(lines[2]).toBe(";Beta Klub;;;;;Lead;STRONG 71/100");

    expect(getLead("lead_a")?.salgsro_exported_at).toBe(now);
    expect(getLead("lead_b")?.salgsro_exported_at).toBe(now);
    const actions = actionsFor("lead_a");
    expect(actions.map((a) => [a.kind, a.payload])).toEqual([["salgsro_export", { path: r.path }]]);

    // Same minute: a second export does not overwrite the first file.
    const again = exportSalgsro(["lead_b"], now, dir);
    expect(again.path).not.toBe(r.path);
    expect(again.path).toMatch(/-2\.csv$/);
  });

  test("throws when no id is a known lead", () => {
    expect(() => exportSalgsro(["nope"], undefined, dir)).toThrow("no leads");
    expect(() => exportSalgsro([], undefined, dir)).toThrow("no leads");
  });
});
