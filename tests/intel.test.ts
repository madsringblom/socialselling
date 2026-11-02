import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { actionsFor, ideasForWeek } from "../src/db.ts";
import { bucket, digest, run } from "../src/plays/intel.ts";
import type { IdeaApi } from "../src/plays/intel.ts";
import { fakeUsage, minimalConfig, scored, seedItem, seedScore, tempDb, testCtx } from "./helpers.ts";

const review = (partial: Parameters<typeof scored>[0]) =>
  scored({ kind: "review", source: "appstore", subreddit: "Rival", matched_product: "beta", ...partial });

test("bucket: the prototype review cases", () => {
  expect(bucket(review({ id: "a", rating: 3, tier: "passing_mention", insight: "No shift swap" }))).toBe("gap");
  expect(bucket(review({ id: "b", rating: 5, tier: "passing_mention", insight: "Love the calendar" }))).toBe("praise");
  expect(bucket(review({ id: "c", rating: 2, tier: "passing_mention", insight: "Chat is slow" }))).toBe("gap");
  expect(bucket(review({ id: "d", rating: 4, tier: "describing_problem", insight: "Missing RSVP reminders" }))).toBe("gap");
  expect(bucket(review({ id: "e", rating: 1, tier: "describing_problem", insight: null }))).toBe("other");
  expect(bucket(review({ id: "f", rating: 4, tier: "passing_mention", insight: "Good overview" }))).toBe("praise");
  expect(bucket(review({ id: "g", rating: 1, tier: "asking_for_tool", insight: null }))).toBe("switching");
  expect(bucket(review({ id: "h", rating: 5, tier: "irrelevant", insight: "Fast sync" }))).toBe("praise");
});

describe("with a database", () => {
  let t: Awaited<ReturnType<typeof tempDb>>;
  beforeEach(async () => {
    t = await tempDb();
  });
  afterEach(() => t.cleanup());

  const RUN_DATE = "2026-11-04"; // 2026-W45: 2026-11-02 .. 2026-11-08
  const NOW = Date.UTC(2026, 10, 5, 12) / 1000;

  function seedReview(id: string, rating: number, runDate: string, score: Parameters<typeof seedScore>[1]) {
    seedItem({ id, kind: "review", source: "appstore", subreddit: "Rival", rating, created_at: NOW - 2 * 86400, body: `Review ${id}` });
    seedScore(id, { run_date: runDate, ...score });
  }

  function seedGap() {
    seedReview("appstore:dk:1", 2, "2026-11-03", { matched_product: "beta", tier: "describing_problem", insight: "No way to swap shifts" });
  }
  function seedPraise() {
    seedReview("appstore:no:2", 4, RUN_DATE, { matched_product: "beta", tier: "passing_mention", insight: "Love the calendar" });
  }

  test("digest counts per competitor within the week (by run_date)", () => {
    seedGap();
    seedPraise();
    seedReview("appstore:dk:3", 5, "2026-10-28", { matched_product: null, tier: "irrelevant" }); // previous week

    const d = digest(minimalConfig(), "2026-W45", NOW);
    expect(d).toMatchObject({ week: "2026-W45", monday: "2026-11-02", sunday: "2026-11-08" });
    expect(d.competitors).toEqual([{ name: "Rival", product_id: "beta", stores: ["dk", "no"], reviews: 2, avg_rating: 3 }]);
    expect(d.gaps.map((g) => [g.id, g.store, g.lang, g.age_d])).toEqual([["appstore:dk:1", "dk", "da", 2]]);
    expect(d.praise.map((g) => [g.id, g.store, g.lang])).toEqual([["appstore:no:2", "no", "nb"]]);
    expect(d.switching).toEqual([]);
    // A date inside the week resolves to the same window.
    expect(digest(minimalConfig(), RUN_DATE, NOW).gaps.length).toBe(1);
  });

  function fakeApi(n: number) {
    let calls = 0;
    const api: IdeaApi = {
      async ideas() {
        calls++;
        return {
          ideas: Array.from({ length: n }, (_, i) => ({ title: `Idea ${i}`, why: "Because of the gaps.", kind: "help_article" as const })),
          usage: fakeUsage(500, 200),
        };
      },
    };
    return { api, calls: () => calls };
  }

  test("run writes at most 3 ideas once per product and week", async () => {
    seedGap();
    const ctx = testCtx(minimalConfig(), NOW, RUN_DATE);
    const fake = fakeApi(4);
    const res = await run(ctx, fake.api);
    expect(res.errors).toEqual([]);
    expect(res.count).toBe(3);
    expect(res.costUsd).toBeGreaterThan(0);
    const ideas = ideasForWeek("2026-W45");
    expect(ideas.map((i) => i.id)).toEqual(["beta:2026-W45:0", "beta:2026-W45:1", "beta:2026-W45:2"]);
    expect(ideas[0]!.gap_refs).toEqual(["appstore:dk:1"]);
    expect(actionsFor("beta:2026-W45").map((a) => a.kind)).toEqual(["ideas_run"]);

    await run(ctx, fake.api);
    expect(fake.calls()).toBe(1);
  });

  test("no gaps: no call and no marker", async () => {
    seedPraise();
    const ctx = testCtx(minimalConfig(), NOW, RUN_DATE);
    const fake = fakeApi(2);
    const res = await run(ctx, fake.api);
    expect(fake.calls()).toBe(0);
    expect(res.count).toBe(0);
    expect(actionsFor("beta:2026-W45")).toEqual([]);
  });
});
