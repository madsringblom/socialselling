import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDays, isoWeek } from "../src/config.ts";
import { configFrom, minimalConfig } from "./helpers.ts";

const base = (extra = "") => `
products:
  - id: p
    name: P
    url: ""
    one_liner: "x"
    target_user: "y"
    problems_solved: ["z"]
    search_phrases: ["w"]
${extra}`;

describe("plays and voice", () => {
  test("defaults without plays, voice or competitors", () => {
    const p = configFrom(base()).products[0]!;
    expect(p.plays).toEqual({ reply_drafts: true, lead_research: false, competitor_intel: false });
    expect(p.voice).toEqual({ examples: [], never_claim: [], link: null });
  });

  test("competitor_intel defaults to true when competitors exist", () => {
    const p = configFrom(base(`    competitors:\n      - name: C\n        app_store: { id: 1 }`)).products[0]!;
    expect(p.plays.competitor_intel).toBe(true);
  });

  test("explicit competitor_intel wins; partial plays keep other defaults", () => {
    const p = configFrom(
      base(`    competitors:\n      - name: C\n    plays: { competitor_intel: false, lead_research: true }`),
    ).products[0]!;
    expect(p.plays).toEqual({ reply_drafts: true, lead_research: true, competitor_intel: false });
  });

  test("minimal test config", () => {
    const cfg = minimalConfig();
    const [alpha, beta] = cfg.products;
    expect(alpha!.plays).toEqual({ reply_drafts: true, lead_research: false, competitor_intel: false });
    expect(alpha!.voice.link).toBe("https://alpha.example");
    expect(beta!.plays).toEqual({ reply_drafts: false, lead_research: true, competitor_intel: true });
  });
});

describe("dates", () => {
  test("isoWeek", () => {
    expect(isoWeek("2026-11-02")).toEqual({ key: "2026-W45", monday: "2026-11-02", sunday: "2026-11-08" });
    expect(isoWeek("2026-11-08").key).toBe("2026-W45");
    expect(isoWeek("2027-01-01").key).toBe("2026-W53");
    expect(isoWeek("2026-01-01").key).toBe("2026-W01");
  });

  test("addDays", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

test("DB_PATH honours env", () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-env-"));
  try {
    const script = join(dir, "print.ts");
    const configPath = join(import.meta.dir, "..", "src", "config.ts");
    writeFileSync(script, `import { DB_PATH } from ${JSON.stringify(configPath)};\nconsole.log(DB_PATH);\n`);
    const want = join(dir, "custom.db");
    const res = Bun.spawnSync([process.execPath, script], { env: { ...process.env, DB_PATH: want } });
    expect(res.stdout.toString().trim()).toBe(want);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
