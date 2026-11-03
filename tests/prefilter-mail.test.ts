import { describe, expect, test } from "bun:test";
import type { Item } from "../src/db.ts";
import { compileMatchers, prefilterItem } from "../src/prefilter.ts";
import { configFrom, minimalConfig } from "./helpers.ts";
import { mailYaml } from "./mail-fixtures.ts";

const now = Math.floor(Date.now() / 1000);

function mailPost(body: string, p: Partial<Item> = {}): Item {
  return {
    id: "mail:m1",
    source: "mail",
    kind: "post",
    url: "https://www.facebook.com/groups/123/posts/456/",
    title: body.split("\n")[0] ?? "",
    body,
    author: "",
    subreddit: "Frivillige i Idrætsforeninger",
    parent_id: null,
    created_at: now - 3600,
    fetched_at: now,
    found_via: "mail:Signals",
    num_comments: 0,
    score_ups: 0,
    locked: false,
    content_hash: "",
    lang: null,
    rating: null,
    ...p,
  };
}

describe("prefilter: mail items", () => {
  test("a short Danish group post passes, hinted to the products with mail enabled", () => {
    const m = compileMatchers(configFrom(mailYaml("alpha")));
    const r = prefilterItem(mailPost("Hvordan holder I styr på kontingent i foreningen?"), m, now);
    expect(r.pass).toBe(true);
    expect(r.productHints).toEqual(["beta"]);
    expect(r.reason).toContain("group mail");
    expect(r.localScore).toBeGreaterThanOrEqual(1);
    expect(r.lang).toBe("other");
  });

  test("a phrase hit ranks its product first", () => {
    const m = compileMatchers(minimalConfig());
    const r = prefilterItem(mailPost("Har nogen et godt system til vagtplan for frivillige i klubben?"), m, now);
    expect(r.pass).toBe(true);
    expect(r.productHints[0]).toBe("beta");
    expect(r.productHints).toContain("alpha");
    expect(r.reason).toContain('beta: phrase "vagtplan"');
  });

  test("older than 36h is rejected", () => {
    const m = compileMatchers(minimalConfig());
    const r = prefilterItem(mailPost("Hvordan holder I styr på kontingent i foreningen?", { created_at: now - 37 * 3600 }), m, now);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("older than 36h");
  });

  test("rejected when no product has mail enabled", () => {
    const m = compileMatchers(configFrom(mailYaml("all")));
    const r = prefilterItem(mailPost("Hvordan holder I styr på kontingent i foreningen?"), m, now);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("mail: no product has mail enabled");
  });

  test("a Danish Reddit post is still dropped as non-English", () => {
    const m = compileMatchers(minimalConfig());
    const body =
      "Vi har brug for et system til vagtplaner og kontingent, fordi regnearket ikke holder længere i vores klub med mange frivillige.";
    const r = prefilterItem(
      mailPost(body, { id: "reddit:t3_dk", source: "reddit", subreddit: "freelance", title: "Hjælp til vagtplaner", author: "someone" }),
      m,
      now,
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("non-English");
  });
});
