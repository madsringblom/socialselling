import { afterEach, describe, expect, test } from "bun:test";
import { clearToken, deps, writeToken } from "../src/mail/gmail.ts";
import { mail } from "../src/strategies/mail.ts";
import { configFrom, minimalConfig } from "./helpers.ts";
import {
  BOILERPLATE_ONLY,
  FB_PLAIN,
  LINKEDIN,
  clearGoogleEnv,
  freshToken,
  gmailApi,
  gmailMessage,
  jsonResponse,
  mailYaml,
  setGoogleEnv,
} from "./mail-fixtures.ts";

const realFetch = deps.fetch;
const quiet = () => {};

afterEach(() => {
  deps.fetch = realFetch;
  clearToken();
  clearGoogleEnv();
});

describe("mail.enabled", () => {
  test("skip notes in order, then true", () => {
    expect(mail.enabled(configFrom(mailYaml("all")))).toBe("mail skipped: no product has mail enabled");
    const cfg = minimalConfig();
    expect(mail.enabled(cfg)).toBe("mail skipped: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env");
    setGoogleEnv();
    expect(mail.enabled(cfg)).toBe("mail skipped: Gmail not connected (bun run ui → Setup → Connect Gmail)");
    writeToken({ ...freshToken(), needs_reconnect: true });
    expect(mail.enabled(cfg)).toBe("mail skipped: Gmail access expired or was revoked; reconnect in Setup");
    writeToken(freshToken());
    expect(mail.enabled(cfg)).toBe(true);
    // One product with mail is enough.
    expect(mail.enabled(configFrom(mailYaml("alpha")))).toBe(true);
  });
});

describe("mail.collect", () => {
  const now = Math.floor(Date.now() / 1000);
  const hourAgo = new Date((now - 3600) * 1000).toUTCString();

  test("label → ids → messages → items; unreadable ones only counted", async () => {
    setGoogleEnv();
    writeToken(freshToken());
    deps.fetch = gmailApi({
      labels: [{ id: "Label_1", name: "Signals" }],
      ids: ["m1", "m2", "m3"],
      messages: {
        m1: gmailMessage("m1", { ...FB_PLAIN, date: hourAgo }),
        m2: gmailMessage("m2", { ...LINKEDIN, date: hourAgo }),
        m3: gmailMessage("m3", { ...BOILERPLATE_ONLY, date: hourAgo }),
      },
    });
    const r = await mail.collect(minimalConfig(), now, quiet);
    expect(r.errors).toEqual([]);
    expect(r.items.map((i) => i.id)).toEqual(["mail:m1", "mail:m2"]);
    for (const it of r.items) {
      expect(it.source).toBe("mail");
      expect(it.kind).toBe("post");
      expect(it.author).toBe("");
      expect(it.found_via).toBe("mail:Signals");
      expect(it.lang).toBeNull();
      expect(it.content_hash).toMatch(/^[0-9a-f]{40}$/);
      expect(it.created_at).toBe(now - 3600);
      expect(it.fetched_at).toBe(now);
    }
    expect(r.items[0]!.subreddit).toBe("Frivillige i Idrætsforeninger");
    expect(r.items[0]!.url).toBe("https://www.facebook.com/groups/123456/permalink/7890/");
    expect(r.items[0]!.body).not.toContain("Anders");
    expect(r.items[1]!.subreddit).toBe("Danske Foreningsledere");
    expect(r.items[1]!.body).not.toContain("Mette");
    expect(r.notes).toContain("mail: 1 notification had no readable post");
  });

  test("a missing label is one error and nothing else is fetched", async () => {
    setGoogleEnv();
    writeToken(freshToken());
    const paths: string[] = [];
    const api = gmailApi({ labels: [{ id: "INBOX", name: "INBOX" }], ids: ["m1"], messages: {} });
    deps.fetch = async (input) => {
      paths.push(new URL(String(input)).pathname);
      return api(input);
    };
    const r = await mail.collect(minimalConfig(), now, quiet);
    expect(r.items).toEqual([]);
    expect(r.errors).toEqual(['mail: Gmail label "Signals" not found; create it and a filter (see README)']);
    expect(paths).toEqual(["/gmail/v1/users/me/labels"]);
  });

  test("posts older than 36h are skipped", async () => {
    setGoogleEnv();
    writeToken(freshToken());
    deps.fetch = gmailApi({
      labels: [{ id: "Label_1", name: "Signals" }],
      ids: ["old1"],
      messages: { old1: gmailMessage("old1", { ...FB_PLAIN, date: new Date((now - 40 * 3600) * 1000).toUTCString() }) },
    });
    const r = await mail.collect(minimalConfig(), now, quiet);
    expect(r.items).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test("a refused refresh token is a single error", async () => {
    setGoogleEnv();
    writeToken({ ...freshToken(), expires_at: 0 });
    deps.fetch = async () => jsonResponse({ error: "invalid_grant" }, 400);
    const r = await mail.collect(minimalConfig(), now, quiet);
    expect(r.items).toEqual([]);
    expect(r.errors).toEqual(["mail: Gmail refused the refresh token; reconnect in Setup"]);
  });
});
