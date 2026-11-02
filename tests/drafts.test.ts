import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DRAFT_MODEL, MAX_DRAFTS_PER_DAY } from "../src/config.ts";
import { draftsForItem, insertDraft } from "../src/db.ts";
import { costUsd } from "../src/llm.ts";
import { buildDraftSystem, clampDraft, eligible, redraft, run } from "../src/plays/drafts.ts";
import type { DraftApi } from "../src/plays/drafts.ts";
import { fakeUsage, minimalConfig, seedItem, seedScore, tempDb, testCtx } from "./helpers.ts";

test("opus pricing: 1000 in / 100 out = $0.006", () => {
  expect(costUsd(fakeUsage(1000, 100), "claude-opus-5-5")).toBeCloseTo(0.006, 12);
});

describe("prompt and clamp", () => {
  test("buildDraftSystem includes the product facts", () => {
    const alpha = minimalConfig().products[0]!;
    const s = buildDraftSystem(alpha);
    expect(s).toContain("maker of Alpha");
    for (const f of alpha.key_features) expect(s).toContain(`  - ${f}`);
    for (const n of alpha.voice.never_claim) expect(s).toContain(`  - ${n}`);
    expect(s).toContain("Link: https://alpha.example");
    expect(s).toContain("1. A daily list fixed this for me.");
  });

  test("link line says none when no link is configured", () => {
    const beta = minimalConfig().products[1]!;
    expect(buildDraftSystem(beta)).toContain("Link: none");
  });

  test("clampDraft", () => {
    expect(clampDraft("  a\n\n\n\nb  ")).toBe("a\n\nb");
    const long = "This is one useful sentence about follow-ups. ".repeat(40);
    const out = clampDraft(long);
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out.endsWith(".")).toBe(true);
    const words = clampDraft("word ".repeat(400));
    expect(words.length).toBeLessThanOrEqual(900);
    expect(words.endsWith("word")).toBe(true);
    expect(clampDraft("x".repeat(2000)).length).toBe(900);
  });
});

describe("with a database", () => {
  let t: Awaited<ReturnType<typeof tempDb>>;
  beforeEach(async () => {
    t = await tempDb();
  });
  afterEach(() => t.cleanup());

  function seed() {
    seedItem({ id: "reddit:t3_ask" });
    seedScore("reddit:t3_ask", { matched_product: "alpha", tier: "asking_for_tool", confidence: 0.8 });
    seedItem({ id: "reddit:t3_problem" });
    seedScore("reddit:t3_problem", { matched_product: "alpha", tier: "describing_problem", confidence: 0.95 });
    // beta has reply_drafts off
    seedItem({ id: "reddit:t3_beta" });
    seedScore("reddit:t3_beta", { matched_product: "beta", tier: "asking_for_tool", confidence: 0.99 });
  }

  const usage = fakeUsage(1000, 100);
  function fakeApi() {
    const calls: { system: string; user: string }[] = [];
    const api: DraftApi = {
      async draft(system, user) {
        calls.push({ system, user });
        return { draft: "Try a daily list. I make Alpha: https://alpha.example", draft_no_link: "Try a daily list. I make Alpha.", usage };
      },
      async redraft(system, user) {
        calls.push({ system, user });
        return { draft: "Shorter: try a daily list.", usage };
      },
    };
    return { api, calls };
  }

  test("eligible respects the product play flag and the cap", () => {
    seed();
    const ctx = testCtx(minimalConfig());
    expect(eligible(ctx, 10).map((r) => r.id)).toEqual(["reddit:t3_ask", "reddit:t3_problem"]);
    expect(eligible(ctx, 1).map((r) => r.id)).toEqual(["reddit:t3_ask"]);
    expect(eligible(ctx, 0)).toEqual([]);
  });

  test("run inserts default + no_link drafts and reports cost", async () => {
    seedItem({ id: "reddit:t3_ask" });
    seedScore("reddit:t3_ask", { matched_product: "alpha" });
    const ctx = testCtx(minimalConfig());
    const { api, calls } = fakeApi();
    const res = await run(ctx, api);
    expect(res.errors).toEqual([]);
    expect(res.count).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]!.user.startsWith("Write the reply.\n\n")).toBe(true);
    expect(res.costUsd).toBeCloseTo(costUsd(usage, DRAFT_MODEL), 12);
    const drafts = draftsForItem("reddit:t3_ask");
    expect(drafts.map((d) => d.variant).sort()).toEqual(["default", "no_link"]);
    expect(drafts.every((d) => d.created_at === ctx.now && d.model === DRAFT_MODEL)).toBe(true);
    expect(drafts.find((d) => d.variant === "no_link")!.text).not.toContain("http");

    // Already drafted: a second run makes no call.
    await run(ctx, api);
    expect(calls.length).toBe(1);
  });

  test("run respects MAX_DRAFTS_PER_DAY via countDraftsSince", async () => {
    seed();
    const ctx = testCtx(minimalConfig());
    for (let i = 0; i < MAX_DRAFTS_PER_DAY; i++) {
      insertDraft({ id: `pre${i}`, item_id: `other${i}`, variant: "default", direction: null, text: "x", model: "m", created_at: ctx.now });
    }
    const { api, calls } = fakeApi();
    const res = await run(ctx, api);
    expect(calls.length).toBe(0);
    expect(res.count).toBe(0);
  });

  test("redraft stores a redraft variant with its direction", async () => {
    seedItem({ id: "reddit:t3_ask" });
    seedScore("reddit:t3_ask", { matched_product: "alpha" });
    const cfg = minimalConfig();
    const { api, calls } = fakeApi();
    await run(testCtx(cfg), api);
    const out = await redraft("reddit:t3_ask", "make it shorter", api, cfg);
    expect(out.draft.variant).toBe("redraft");
    expect(out.draft.direction).toBe("make it shorter");
    expect(out.costUsd).toBeCloseTo(costUsd(usage, DRAFT_MODEL), 12);
    const user = calls[1]!.user;
    expect(user.startsWith("Rewrite the previous draft following the direction.")).toBe(true);
    expect(user).toContain("I make Alpha: https://alpha.example");
    expect(user).toContain("make it shorter");
    expect(draftsForItem("reddit:t3_ask")[0]!.variant).toBe("redraft");
  });
});
