import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UI_PORT } from "../src/config.ts";
import {
  GmailError,
  accessPlan,
  clearToken,
  consentUrl,
  deps,
  extractParts,
  getAccessToken,
  getGmailConfig,
  gmailTokenPatch,
  labelId,
  listMessageIds,
  readToken,
  writeToken,
} from "../src/mail/gmail.ts";
import type { GmailConfig, GmailToken } from "../src/mail/gmail.ts";
import { b64, freshToken, jsonResponse } from "./mail-fixtures.ts";

const realFetch = deps.fetch;

afterEach(() => {
  deps.fetch = realFetch;
  clearToken();
});

const CFG: GmailConfig = {
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "test-secret",
  redirectUri: "http://127.0.0.1:8787/api/gmail/callback",
  label: "Signals",
  maxPerRun: 50,
};

describe("OAuth", () => {
  test("consentUrl asks for read-only Gmail, offline, with consent and the state", () => {
    const u = new URL(consentUrl(CFG, "st-1"));
    expect(`${u.origin}${u.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = u.searchParams;
    expect(q.get("client_id")).toBe(CFG.clientId);
    expect(q.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("state")).toBe("st-1");
    expect(q.has("client_secret")).toBe(false);
  });

  test("gmailTokenPatch keeps the prior refresh token, clears email and needs_reconnect", () => {
    const prev: GmailToken = {
      email: "old@example.com",
      refresh_token: "r-old",
      access_token: "a-old",
      expires_at: 1,
      needs_reconnect: true,
      connected_at: 1,
    };
    expect(gmailTokenPatch(prev, { access_token: "a-new", expires_in: 100 }, 1_000_000)).toEqual({
      email: null,
      refresh_token: "r-old",
      access_token: "a-new",
      expires_at: 1_100_000,
      needs_reconnect: false,
      connected_at: 1_000_000,
    });
    expect(gmailTokenPatch(prev, { access_token: "a", refresh_token: "r-new" }, 0).refresh_token).toBe("r-new");
    expect(gmailTokenPatch(null, { access_token: "a" }, 0)).toMatchObject({ refresh_token: null, expires_at: 3_600_000 });
  });

  test("accessPlan", () => {
    const now = 1_000_000_000;
    const tok = (p: Partial<GmailToken>): GmailToken => ({
      email: null,
      refresh_token: "r",
      access_token: "a",
      expires_at: now + 3600_000,
      needs_reconnect: false,
      connected_at: now,
      ...p,
    });
    expect(accessPlan(null, now)).toEqual({ kind: "reconnect" });
    expect(accessPlan(tok({ needs_reconnect: true }), now)).toEqual({ kind: "reconnect" });
    expect(accessPlan(tok({ access_token: null, refresh_token: null }), now)).toEqual({ kind: "reconnect" });
    expect(accessPlan(tok({}), now)).toEqual({ kind: "use", token: "a" });
    expect(accessPlan(tok({ expires_at: now + 30_000 }), now)).toEqual({ kind: "refresh" }); // inside the 60 s skew
    expect(accessPlan(tok({ expires_at: now - 1, refresh_token: null }), now)).toEqual({ kind: "reconnect" });
  });

  test("getAccessToken refreshes an expired token and saves it", async () => {
    writeToken({ ...freshToken(), access_token: "a-old", expires_at: Date.now() - 1000 });
    const calls: { url: string; body: string }[] = [];
    deps.fetch = async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return jsonResponse({ access_token: "a-new", expires_in: 3600 });
    };
    expect(await getAccessToken(CFG)).toBe("a-new");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("r-1");
    const saved = readToken();
    expect(saved?.access_token).toBe("a-new");
    expect(saved?.refresh_token).toBe("r-1");
    expect(saved!.expires_at).toBeGreaterThan(Date.now() + 3_000_000);

    // A valid token is used without calling Google.
    expect(await getAccessToken(CFG)).toBe("a-new");
    expect(calls).toHaveLength(1);
  });

  test("invalid_grant marks the token needs_reconnect and rethrows", async () => {
    writeToken({ ...freshToken(), expires_at: 0 });
    deps.fetch = async () => jsonResponse({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
    const err = await getAccessToken(CFG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GmailError);
    expect((err as GmailError).oauthError).toBe("invalid_grant");
    expect(readToken()?.needs_reconnect).toBe(true);
    // Flagged: no further call to Google.
    let called = false;
    deps.fetch = async () => {
      called = true;
      return jsonResponse({});
    };
    await expect(getAccessToken(CFG)).rejects.toBeInstanceOf(GmailError);
    expect(called).toBe(false);
  });
});

describe("token file", () => {
  test("creates the directory, mode 0600, round-trips, clears; unparsable reads as null", () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-gmail-"));
    try {
      const path = join(dir, "nested", "deeper", "gmail-token.json");
      expect(readToken(path)).toBeNull();
      const t = freshToken();
      writeToken(t, path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readToken(path)).toEqual(t);
      writeFileSync(path, "{not json");
      expect(readToken(path)).toBeNull();
      writeFileSync(path, "[1,2]");
      expect(readToken(path)).toBeNull();
      writeToken(t, path);
      clearToken(path);
      expect(existsSync(path)).toBe(false);
      clearToken(path); // missing file is fine
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Gmail API", () => {
  test("labelId matches the name case-insensitively and sends the access token", async () => {
    writeToken(freshToken());
    const auth: string[] = [];
    deps.fetch = async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/gmail/v1/users/me/labels");
      auth.push(new Headers(init?.headers).get("authorization") ?? "");
      return jsonResponse({ labels: [{ id: "INBOX", name: "INBOX" }, { id: "Label_7", name: "signals" }] });
    };
    expect(await labelId("Signals")).toBe("Label_7");
    expect(await labelId("Missing")).toBeNull();
    expect(auth[0]).toBe("Bearer a-1");
  });

  test("listMessageIds: label id, newer_than:2d, maxResults, bad ids dropped", async () => {
    writeToken(freshToken());
    const seen: URL[] = [];
    deps.fetch = async (input) => {
      seen.push(new URL(String(input)));
      return jsonResponse({ messages: [{ id: "m1" }, { id: "bad id!" }, { id: "m2" }, {}] });
    };
    expect(await listMessageIds("Label_7", 3)).toEqual(["m1", "m2"]);
    const u = seen[0]!;
    expect(u.pathname).toBe("/gmail/v1/users/me/messages");
    expect(u.searchParams.get("labelIds")).toBe("Label_7");
    expect(u.searchParams.get("q")).toBe("newer_than:2d");
    expect(u.searchParams.get("maxResults")).toBe("3");

    expect(await listMessageIds("Label_7", 500)).toEqual(["m1", "m2"]);
    expect(seen[1]!.searchParams.get("maxResults")).toBe("100");
    expect(await listMessageIds("Label_7", 0)).toEqual([]);
    expect(seen).toHaveLength(2);
  });

  test("extractParts walks nested multipart, decodes base64url, normalises CRLF", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/html", body: { data: b64("<p>Hej</p>") } },
            { mimeType: "text/plain", body: { data: b64("Hej æøå ???>>>\r\nlinje 2") } },
          ],
        },
        { mimeType: "image/png", body: { data: b64("png") } },
      ],
    };
    expect(b64("???>>>")).toContain("_"); // the fixture really exercises base64url
    expect(extractParts(payload)).toEqual({ text: "Hej æøå ???>>>\nlinje 2", html: "<p>Hej</p>" });
  });

  test("extractParts: html only, and nothing", () => {
    expect(extractParts({ mimeType: "text/html", body: { data: b64("<b>x</b>") } })).toEqual({ text: "", html: "<b>x</b>" });
    expect(extractParts(undefined)).toEqual({ text: "", html: "" });
  });
});

describe("config", () => {
  test("defaults: redirect on UI_PORT, label Signals, 50 per run", () => {
    const c = getGmailConfig({});
    expect(c).toEqual({
      clientId: "",
      clientSecret: "",
      redirectUri: `http://127.0.0.1:${UI_PORT}/api/gmail/callback`,
      label: "Signals",
      maxPerRun: 50,
    });
    expect(
      getGmailConfig({ GOOGLE_REDIRECT_URI: "http://localhost:9999/cb", MAIL_LABEL: "Grupper", MAIL_MAX_PER_RUN: "7" }),
    ).toMatchObject({ redirectUri: "http://localhost:9999/cb", label: "Grupper", maxPerRun: 7 });
  });

  test("MAIL_MAX_PER_RUN must be a non-negative integer", () => {
    expect(() => getGmailConfig({ MAIL_MAX_PER_RUN: "abc" })).toThrow("MAIL_MAX_PER_RUN");
    expect(() => getGmailConfig({ MAIL_MAX_PER_RUN: "-1" })).toThrow("MAIL_MAX_PER_RUN");
  });
});
