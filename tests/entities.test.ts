import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MODEL } from "../src/config.ts";
import { getEntity } from "../src/db.ts";
import { costUsd } from "../src/llm.ts";
import { canonicalDomain, entityId, normalizeName, run, upsertFromExtraction } from "../src/plays/entities.ts";
import type { EntityApi, Extracted } from "../src/plays/entities.ts";
import { fakeUsage, minimalConfig, scoreEntitiesAt, scored, seedItem, seedScore, tempDb, testCtx } from "./helpers.ts";

const sha10 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 10);

describe("normalisation", () => {
  test("canonicalDomain", () => {
    expect(canonicalDomain("https://www.Eksempel-Klub.dk/om-os")).toBe("eksempel-klub.dk");
    expect(canonicalDomain("http://klub.dk:8080?x=1")).toBe("klub.dk");
    expect(canonicalDomain("klub.dk#top")).toBe("klub.dk");
    expect(canonicalDomain("   ")).toBeNull();
  });

  test("normalizeName", () => {
    expect(normalizeName("  Nørre-Snede I.F. (Fodbold)  ")).toBe("nørre-snede if fodbold");
    expect(normalizeName("Ålborg   Æ&Ø Klub")).toBe("ålborg æø klub");
  });

  test("entityId", () => {
    expect(entityId("eksempel-klub.dk", "ignored")).toBe(`lead_${sha10("eksempel-klub.dk")}`);
    expect(entityId(null, "nørre-snede if fodbold")).toBe(`lead_${sha10("nørre-snede if fodbold")}`);
  });
});

describe("with a database", () => {
  let t: Awaited<ReturnType<typeof tempDb>>;
  beforeEach(async () => {
    t = await tempDb();
  });
  afterEach(() => t.cleanup());

  const org = (name: string, website: string | null = null): NonNullable<Extracted["entity"]> => ({
    kind: "organisation",
    name,
    website,
    municipality: null,
    sports: [],
  });

  test("upsertFromExtraction merges by name, then domain; id never changes", () => {
    const runDate = "2026-11-02";
    const item = (id: string) => scored({ id, matched_product: "beta" });

    const first = upsertFromExtraction(item("i1"), org("Eksempel Klub"), runDate);
    expect(first.id).toBe(entityId(null, "eksempel klub"));
    expect(first.domain).toBeNull();
    expect(first.signal_count).toBe(1);
    expect(first.product_id).toBe("beta");

    // Same name, now with a website: the name-matched row gets the domain filled, id unchanged.
    const second = upsertFromExtraction(item("i2"), org("Eksempel Klub", "https://www.eksempel-klub.dk/kontakt"), runDate);
    expect(second.id).toBe(first.id);
    expect(second.domain).toBe("eksempel-klub.dk");
    expect(second.website).toBe("https://www.eksempel-klub.dk/kontakt");
    expect(second.signal_count).toBe(2);

    // Different name, same domain: merged by domain.
    const third = upsertFromExtraction(item("i3"), org("EK Idræt", "https://eksempel-klub.dk"), "2026-11-03");
    expect(third.id).toBe(first.id);
    expect(third.signal_count).toBe(3);
    expect(third.last_seen).toBe("2026-11-03");
    expect(third.name).toBe("Eksempel Klub");

    // Linking the same item twice does not inflate the count.
    expect(upsertFromExtraction(item("i3"), org("EK Idræt", "https://eksempel-klub.dk"), runDate).signal_count).toBe(3);

    const person = upsertFromExtraction(item("i4"), { ...org("Jens Hansen"), kind: "person" }, runDate);
    expect(person.kind).toBe("person");
    expect(person.id).not.toBe(first.id);
  });

  test("upsertFromExtraction ignores non-http websites", () => {
    const e = upsertFromExtraction(scored({ id: "i1", matched_product: "beta" }), org("Klub", "eksempel.dk"), "2026-11-02");
    expect(e.website).toBeNull();
    expect(e.domain).toBeNull();
  });

  function seedPending(runDate: string) {
    seedItem({ id: "art", kind: "article", source: "rss", subreddit: "foreningsapp" });
    seedScore("art", { matched_product: "beta", tier: "describing_problem", run_date: runDate });
    seedItem({ id: "beta_post" });
    seedScore("beta_post", { matched_product: "beta", tier: "asking_for_tool", run_date: runDate });
    // alpha has no lead_research: its posts are not extraction candidates.
    seedItem({ id: "alpha_post" });
    seedScore("alpha_post", { matched_product: "alpha", run_date: runDate });
  }

  test("run marks every item of a successful batch, including null entities", async () => {
    const ctx = testCtx(minimalConfig());
    seedPending(ctx.runDate);
    const usage = fakeUsage(2000, 300);
    let calls = 0;
    const api: EntityApi = {
      async extract(_system, user) {
        calls++;
        const items = JSON.parse(user.slice(user.indexOf("\n\n") + 2)) as { i: number; kind: string }[];
        expect(items.length).toBe(2);
        const results: Extracted[] = items.map((x) => ({
          i: x.i,
          entity: x.kind === "article" ? org("Eksempel Klub", "https://www.eksempel-klub.dk/") : null,
        }));
        return { results, usage };
      },
    };
    const res = await run(ctx, api);
    expect(calls).toBe(1);
    expect(res.errors).toEqual([]);
    expect(res.count).toBe(1);
    expect(res.costUsd).toBeCloseTo(costUsd(usage, MODEL), 12);
    expect(scoreEntitiesAt(t.db, "art")).toBe(ctx.now);
    expect(scoreEntitiesAt(t.db, "beta_post")).toBe(ctx.now);
    expect(scoreEntitiesAt(t.db, "alpha_post")).toBeNull();
    expect(getEntity(entityId("eksempel-klub.dk", "eksempel klub"))?.signal_count).toBe(1);

    // Nothing pending any more: no second call.
    await run(ctx, api);
    expect(calls).toBe(1);
  });

  test("a failing batch stays pending and is reported", async () => {
    const ctx = testCtx(minimalConfig());
    seedPending(ctx.runDate);
    const api: EntityApi = {
      async extract() {
        throw new Error("boom");
      },
    };
    const res = await run(ctx, api);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toContain("boom");
    expect(res.count).toBe(0);
    expect(scoreEntitiesAt(t.db, "art")).toBeNull();
    expect(scoreEntitiesAt(t.db, "beta_post")).toBeNull();
  });
});
