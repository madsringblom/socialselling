import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addDays, localDate } from "../src/config.ts";
import {
  draftCandidates,
  findEntity,
  insertAction,
  insertDraft,
  latestActionByTarget,
  linkEntityItem,
  researchQueue,
} from "../src/db.ts";
import { nowS, seedEntity, seedItem, seedLead, seedScore, tempDb } from "./helpers.ts";

let t: Awaited<ReturnType<typeof tempDb>>;
beforeEach(async () => {
  t = await tempDb();
});
afterEach(() => t.cleanup());

test("openDb creates the new tables and columns", () => {
  for (const table of ["drafts", "entities", "entity_items", "leads", "actions", "ideas"]) {
    expect(t.db.query(`PRAGMA table_info(${table})`).all().length).toBeGreaterThan(0);
  }
  const scoreCols = t.db
    .query<{ name: string }, []>("PRAGMA table_info(scores)")
    .all()
    .map((c) => c.name);
  expect(scoreCols).toContain("entities_at");
});

describe("draftCandidates", () => {
  test("filters and orders", () => {
    const now = nowS();
    const since = now - 24 * 3600;
    const add = (id: string, item: Parameters<typeof seedItem>[0] | null, score: Parameters<typeof seedScore>[1]) => {
      seedItem({ id, ...(item ?? {}) });
      seedScore(id, score);
    };
    add("ask_hi", null, { tier: "asking_for_tool", confidence: 0.9 });
    add("ask_lo", null, { tier: "asking_for_tool", confidence: 0.7 });
    add("problem", { id: "problem", kind: "comment" }, { tier: "describing_problem", confidence: 0.95 });
    add("review", { id: "review", kind: "review", source: "appstore" }, { tier: "asking_for_tool" });
    add("mention", null, { tier: "passing_mention" });
    add("lowconf", null, { confidence: 0.3 });
    add("old", { id: "old", created_at: now - 48 * 3600 }, {});
    add("drafted", null, {});
    add("skipped", null, {});
    add("posted", null, {});
    insertDraft({ id: "d1", item_id: "drafted", variant: "default", direction: null, text: "x", model: "m", created_at: now });
    insertAction("skip", "skipped", { reason: "not relevant" });
    // Any 'posted' action excludes the item for good, even if a later 'undo_posted' exists.
    insertAction("posted", "posted");
    insertAction("undo_posted", "posted");

    const ids = draftCandidates({ since, minConfidence: 0.6 }).map((r) => r.id);
    expect(ids).toEqual(["ask_hi", "ask_lo", "problem"]);
  });
});

test("latestActionByTarget picks the newest action per target among kinds", () => {
  insertAction("status", "t1", { status: "contacted" });
  insertAction("status", "t1", { status: "replied" });
  insertAction("note", "t1", "ignored kind");
  insertAction("status", "t2", { status: "meeting" });
  const latest = latestActionByTarget(["status"]);
  expect(latest.size).toBe(2);
  expect(latest.get("t1")?.payload).toEqual({ status: "replied" });
  expect(latest.get("t2")?.payload).toEqual({ status: "meeting" });
  expect(latestActionByTarget([]).size).toBe(0);
});

test("findEntity: domain first, then name fallback", () => {
  seedEntity({ id: "e_dom", domain: "a.dk", normalized_name: "alpha club" });
  seedEntity({ id: "e_name", domain: null, normalized_name: "beta club" });
  expect(findEntity("a.dk", "something else")?.id).toBe("e_dom");
  expect(findEntity(null, "beta club")?.id).toBe("e_name");
  expect(findEntity(null, "alpha club")?.id).toBe("e_dom");
  // A domain with no match falls back to a same-name row without a domain...
  expect(findEntity("b.dk", "beta club")?.id).toBe("e_name");
  // ...but never to a same-name row with a different domain.
  expect(findEntity("c.dk", "alpha club")).toBeNull();
  expect(findEntity(null, "nobody")).toBeNull();
});

test("researchQueue: organisations without a fresh lead, by signal count", () => {
  const today = localDate();
  seedEntity({ id: "e_new", last_seen: today });
  seedEntity({ id: "e_person", kind: "person" });
  seedEntity({ id: "e_fresh" });
  seedLead({ id: "e_fresh", last_researched: today });
  seedEntity({ id: "e_stale" });
  seedLead({ id: "e_stale", last_researched: addDays(today, -40) });
  seedEntity({ id: "e_other_product", product_id: "alpha" });
  linkEntityItem("e_stale", "i1");
  linkEntityItem("e_stale", "i2");

  const queue = researchQueue(["beta"], addDays(today, -30), 10);
  expect(queue.map((e) => e.id)).toEqual(["e_stale", "e_new"]);
  expect(queue[0]!.signal_count).toBe(2);
  expect(researchQueue(["beta"], addDays(today, -30), 1).map((e) => e.id)).toEqual(["e_stale"]);
});
