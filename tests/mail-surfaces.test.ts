import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setup } from "../src/api.ts";
import { mdLink, where } from "../src/report.ts";
import { configFrom, minimalConfig, nowS, scored, tempDb } from "./helpers.ts";
import { mailYaml } from "./mail-fixtures.ts";

describe("report: mail items", () => {
  test("where(): group posts name the group, pasted posts say so", () => {
    expect(where(scored({ id: "mail:m1", source: "mail", subreddit: "Foreningsledere DK", found_via: "mail:Signals" }))).toBe(
      "Foreningsledere DK (group)",
    );
    expect(where(scored({ id: "mail:paste:abc", source: "mail", subreddit: "paste", found_via: "paste" }))).toBe("Pasted post");
  });

  test("mdLink renders plain text for an item without a URL", () => {
    expect(mdLink("Title", "https://example.com/x")).toBe("[Title](<https://example.com/x>)");
    expect(mdLink("Title", "")).toBe("Title");
  });
});

describe("setup: mail source row", () => {
  let t: Awaited<ReturnType<typeof tempDb>>;
  beforeAll(async () => {
    t = await tempDb();
  });
  afterAll(() => t.cleanup());

  const mailRow = (cfg: Parameters<typeof setup>[0]) => setup(cfg, nowS()).sources.find((s) => s.id === "mail");

  test("no product with mail enabled: off, with that note (not the .env hint)", () => {
    expect(mailRow(configFrom(mailYaml("all")))).toMatchObject({ status: "off", note: "mail skipped: no product has mail enabled" });
  });

  test("Google client missing: unavailable with the .env hint", () => {
    expect(mailRow(minimalConfig())).toMatchObject({
      status: "unavailable",
      note: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env",
    });
  });
});
