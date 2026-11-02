import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_RESEARCH_PER_DAY, RESEARCH_MODEL, addDays } from "../src/config.ts";
import { getLead, linkEntityItem, setLeadStatus } from "../src/db.ts";
import { costUsd } from "../src/llm.ts";
import { PARSE_SYSTEM, apiFrom, collectBlocks, investigate, run, RESEARCH_EFFORT } from "../src/plays/research.ts";
import type { LeadOutput, ResearchApi, ResearchClient } from "../src/plays/research.ts";
import { fakeUsage, minimalConfig, seedEntity, seedItem, seedLead, seedScore, tempDb, testCtx } from "./helpers.ts";

const blocks = (xs: unknown[]) => xs as Anthropic.Messages.ContentBlock[];

const searchResult = (url: string) => ({ type: "web_search_result", url, title: url, encrypted_content: "enc", page_age: null });
const FIXTURE = blocks([
  { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "testby if vagtplan" }, caller: { type: "direct" } },
  { type: "web_search_tool_result", tool_use_id: "s1", caller: { type: "direct" }, content: [searchResult("https://testby-if.dk/"), searchResult("https://testby-if.dk/nyt")] },
  { type: "web_search_tool_result", tool_use_id: "s2", caller: { type: "direct" }, content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
  {
    type: "web_fetch_tool_result",
    tool_use_id: "f1",
    caller: { type: "direct" },
    content: { type: "web_fetch_result", url: "https://testby-if.dk/referat.pdf", retrieved_at: null, content: { type: "document" } },
  },
  { type: "web_fetch_tool_result", tool_use_id: "f2", caller: { type: "direct" }, content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } },
  { type: "text", text: "Notes about Testby IF.", citations: null },
]);

test("collectBlocks reads text, seen URLs and tool errors", () => {
  expect(collectBlocks(FIXTURE)).toEqual({
    texts: ["Notes about Testby IF."],
    urls: ["https://testby-if.dk/", "https://testby-if.dk/nyt", "https://testby-if.dk/referat.pdf"],
    toolErrors: ["web_search: max_uses_exceeded", "web_fetch: url_not_accessible"],
    searches: 2,
    fetches: 2,
  });
});

const U = "https://testby-if.dk/referat.pdf";
const zero = { points: 0, basis: "not assessed", evidence_url: null };
function output(signals: LeadOutput["signals"]): LeadOutput {
  return {
    organisation: { name: "Testby IF", website: "https://www.testby-if.dk/", municipality: "Testby Kommune", sports: ["fodbold"], member_count: null },
    signals,
    digital_stack: [],
    contacts: [{ name: null, role: "Formand", email: "formand@testby-if.dk", phone: null, source_url: "https://testby-if.dk/kontakt" }],
    score_components: {
      intent: { points: 15, basis: "discusses shifts", evidence_url: U },
      operational_pain: { points: 10, basis: "kiosk shifts unfilled", evidence_url: U },
      mio_fit: zero,
      timing: { points: 6, basis: "this year", evidence_url: null },
      reachability: { points: 10, basis: "chair email", evidence_url: "https://testby-if.dk/kontakt" },
    },
    negative_adjustments: [],
    pain_hypothesis: "Kiosk shifts are coordinated by hand.",
    opportunity_hypothesis: "Shift rosters.",
    call_brief: ["Ring til formanden", "Referatet nævner kioskvagter", "Ubesatte vagter", "Hej, jeg så jeres referat", "Sig ikke at de er dårligt organiseret"],
  };
}
const signal = (type: string, source_url: string | null): LeadOutput["signals"][number] => ({
  family: "volunteer_coordination",
  type,
  classification: "FACT",
  evidence_summary: `${type} evidence`,
  source_url,
  source_published_date: "2026-05-04",
  confidence: "high",
});

const message = (stop_reason: string, content: Anthropic.Messages.ContentBlock[], usage: Anthropic.Usage) =>
  ({ id: "msg", type: "message", role: "assistant", model: RESEARCH_MODEL, content, stop_reason, stop_sequence: null, usage }) as unknown as Anthropic.Messages.Message;

describe("with a database", () => {
  let t: Awaited<ReturnType<typeof tempDb>>;
  beforeEach(async () => {
    t = await tempDb();
  });
  afterEach(() => t.cleanup());

  /** A fake SDK: first response pauses (pause_turn), the second ends; parse returns `next`. */
  function fakeClient(opts: { stops?: string[]; next: () => LeadOutput }) {
    const calls: Anthropic.Messages.MessageCreateParamsNonStreaming[] = [];
    const parseCalls: { system: string; user: string }[] = [];
    const stops = opts.stops ?? ["pause_turn", "end_turn"];
    const searchUsage: Anthropic.Usage = {
      ...fakeUsage(3000, 400),
      server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
    };
    const createUsage = [searchUsage, fakeUsage(2000, 800)];
    const parseUsage = fakeUsage(1500, 600);
    const client: ResearchClient = {
      async create(params) {
        const i = calls.length;
        calls.push(params);
        const content = i === 0 ? FIXTURE.slice(0, 3) : FIXTURE.slice(3);
        return message(stops[i] ?? "end_turn", content, createUsage[i] ?? fakeUsage(0, 0));
      },
      async parse(system, user) {
        parseCalls.push({ system, user });
        return { stop_reason: "end_turn", parsed_output: opts.next(), usage: parseUsage };
      },
    };
    const expectedCost = [...createUsage, parseUsage].reduce((a, u) => a + costUsd(u, RESEARCH_MODEL), 0);
    return { client, calls, parseCalls, expectedCost };
  }

  function seedOrg() {
    const entity = seedEntity({ id: "lead_testby", name: "Testby IF", normalized_name: "testby if", product_id: "beta" });
    seedItem({ id: "art1", kind: "article", source: "rss", title: "Testby IF mangler frivillige" });
    seedScore("art1", { matched_product: "beta", tier: "describing_problem", insight: "Kiosk shifts unfilled" });
    linkEntityItem(entity.id, "art1");
    return entity;
  }

  test("investigate loops on pause_turn, parses, sanitizes and stores the lead", async () => {
    const ctx = testCtx(minimalConfig());
    const entity = seedOrg();
    const fake = fakeClient({ next: () => output([signal("unfilled kiosk shifts", U), signal("no source", null)]) });

    const r = await investigate(entity, ctx, apiFrom(fake.client));

    expect(fake.calls.length).toBe(2);
    const first = fake.calls[0]!;
    expect(first.max_tokens).toBe(16000);
    expect(first.model).toBe(RESEARCH_MODEL);
    expect(first.output_config).toEqual({ effort: RESEARCH_EFFORT });
    expect(first.tools?.map((x) => ("type" in x ? x.type : ""))).toEqual(["web_search_20260209", "web_fetch_20260209"]);
    expect("thinking" in first).toBe(false);
    expect(String(first.system)).toContain("research-only investigator");
    const user = first.messages[0]!.content as string;
    expect(user).toContain("Organisation: Testby IF");
    expect(user).toContain("Testby IF mangler frivillige — Kiosk shifts unfilled");
    // Second call continues the paused turn with the assistant content appended.
    expect(first.messages.length).toBe(1);
    const second = fake.calls[1]!;
    expect(second.messages.length).toBe(2);
    expect(second.messages[1]!.role).toBe("assistant");
    expect(second.messages[1]!.content).toEqual(FIXTURE.slice(0, 3) as unknown as Anthropic.Messages.ContentBlockParam[]);

    expect(fake.parseCalls.length).toBe(1);
    expect(fake.parseCalls[0]!.system).toBe(PARSE_SYSTEM);
    expect(fake.parseCalls[0]!.user).toContain("Notes:\nNotes about Testby IF.");
    expect(fake.parseCalls[0]!.user).toContain("URLs seen:\nhttps://testby-if.dk/\nhttps://testby-if.dk/nyt\nhttps://testby-if.dk/referat.pdf");

    expect(r.turns).toBe(2);
    expect(r.downgraded).toBe(1);
    expect(r.toolErrors).toEqual(["web_search: max_uses_exceeded", "web_fetch: url_not_accessible"]);
    expect(r.costUsd).toBeCloseTo(fake.expectedCost, 10);

    const lead = getLead(entity.id)!;
    expect(lead).toMatchObject({
      id: "lead_testby",
      product_id: "beta",
      org_name: "Testby IF",
      domain: "testby-if.dk",
      total: 41,
      classification: "WATCH",
      status: "new",
      first_seen: ctx.runDate,
      last_researched: ctx.runDate,
    });
    expect(lead.signals.map((s) => s.classification)).toEqual(["FACT", "HYPOTHESIS"]);
    expect(lead.call_brief?.length).toBe(5);
    expect(lead.research_cost_usd).toBeCloseTo(fake.expectedCost, 10);
  });

  test("re-investigating merges into the existing lead", async () => {
    const ctx = testCtx(minimalConfig());
    const entity = seedOrg();
    let next = output([signal("unfilled kiosk shifts", U)]);
    const fake1 = fakeClient({ next: () => next });
    await investigate(entity, ctx, apiFrom(fake1.client));
    setLeadStatus(entity.id, "contacted");

    next = output([signal("unfilled kiosk shifts", U), signal("new shift app", "https://testby-if.dk/nyt")]);
    const fake2 = fakeClient({ next: () => next });
    const r = await investigate(entity, ctx, apiFrom(fake2.client));
    expect(r.newSignals).toBe(1);
    const lead = getLead(entity.id)!;
    expect(lead.signals.map((s) => s.type)).toEqual(["unfilled kiosk shifts", "new shift app"]);
    expect(lead.status).toBe("contacted");
    expect(lead.research_cost_usd).toBeCloseTo(fake1.expectedCost + fake2.expectedCost, 10);
  });

  test("persons are never researched", async () => {
    const ctx = testCtx(minimalConfig());
    const person = seedEntity({ id: "lead_person", kind: "person", product_id: "beta" });
    const fake = fakeClient({ next: () => output([]) });
    await expect(investigate(person, ctx, apiFrom(fake.client))).rejects.toThrow("persons are never researched");
    expect(fake.calls.length).toBe(0);
    expect(getLead(person.id)).toBeNull();
  });

  test("a refusal fails without writing a lead", async () => {
    const ctx = testCtx(minimalConfig());
    const entity = seedOrg();
    const fake = fakeClient({ stops: ["refusal"], next: () => output([]) });
    await expect(investigate(entity, ctx, apiFrom(fake.client))).rejects.toThrow("research refused");
    expect(fake.parseCalls.length).toBe(0);
    expect(getLead(entity.id)).toBeNull();
  });

  test("run respects the daily cap and skips leads researched in the last 30 days", async () => {
    const ctx = testCtx(minimalConfig());
    const org = (id: string, signal_count: number) => seedEntity({ id, name: id, normalized_name: id, product_id: "beta", signal_count });
    org("today", 9);
    seedLead({ id: "today", last_researched: ctx.runDate }); // counts toward today's cap
    org("recent", 8);
    seedLead({ id: "recent", last_researched: addDays(ctx.runDate, -5) });
    org("stale", 5);
    seedLead({ id: "stale", last_researched: addDays(ctx.runDate, -40) });
    org("new1", 3);
    org("new2", 0);
    seedEntity({ id: "person", kind: "person", product_id: "beta", signal_count: 20 });

    const researched: string[] = [];
    const api: ResearchApi = {
      async investigate(_system, user) {
        researched.push(/^Organisation: (.*)$/m.exec(user)?.[1] ?? "?");
        return { text: "notes", urls: [], usage: [fakeUsage(1000, 100)], toolErrors: [], stop: "end_turn", turns: 1 };
      },
      async parse() {
        return { lead: output([]), usage: fakeUsage(500, 100) };
      },
    };
    const res = await run(ctx, api);
    // One lead was already researched today, so the cap leaves MAX_RESEARCH_PER_DAY - 1 (2 with the default of 3).
    const expected = ["stale", "new1", "new2"].slice(0, Math.max(0, MAX_RESEARCH_PER_DAY - 1));
    expect(researched).toEqual(expected);
    expect(res.count).toBe(expected.length);
    expect(res.errors).toEqual([]);
    const each = costUsd(fakeUsage(1000, 100), RESEARCH_MODEL) + costUsd(fakeUsage(500, 100), RESEARCH_MODEL);
    expect(res.costUsd).toBeCloseTo(expected.length * each, 10);
    if (expected.includes("stale")) expect(getLead("stale")?.last_researched).toBe(ctx.runDate);
    if (expected.includes("new1")) expect(getLead("new1")?.first_seen).toBe(ctx.runDate);
    expect(getLead("recent")?.last_researched).toBe(addDays(ctx.runDate, -5));

    // Cap reached: a second run researches nothing.
    researched.length = 0;
    expect((await run(ctx, api)).count).toBe(0);
    expect(researched).toEqual([]);
  });
});
