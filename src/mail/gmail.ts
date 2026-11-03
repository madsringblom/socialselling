/**
 * Gmail, read-only: OAuth2 (one local user, tokens in a 0600 JSON file) and the few Gmail API calls the mail
 * source needs. OAuth, the token patch and the MIME walk are ported from Salgsro (server/src/lib/mail/gmail.js);
 * the token file, accessPlan and the label/list/get helpers are new. Never logs codes, tokens or the secret.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GMAIL_TOKEN_PATH, UI_PORT } from "../config.ts";
import { FETCH_TIMEOUT_MS, errMsg } from "../strategies/shared.ts";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Gmail ids are opaque url-safe tokens; anything else never reaches the API path. */
export const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** An OAuth state nonce is valid this long and only once. */
export const STATE_TTL_MS = 10 * 60_000;
/** An access token this close to expiry is refreshed instead of used. */
const REFRESH_SKEW_MS = 60_000;
/** Gmail search window; the prefilter drops posts older than 36h anyway. */
export const NEWER_THAN = "2d";
/** Messages fetched in parallel per batch. */
export const GET_BATCH = 5;
const DEFAULT_LABEL = "Signals";
const DEFAULT_MAX_PER_RUN = 50;
const LIST_PAGE_MAX = 100;

export type GmailToken = {
  email: string | null;
  refresh_token: string | null;
  access_token: string | null;
  /** ms */
  expires_at: number;
  needs_reconnect: boolean;
  /** ms */
  connected_at: number;
};
export type GmailConfig = { clientId: string; clientSecret: string; redirectUri: string; label: string; maxPerRun: number };
export type GmailStatus =
  | { state: "not_configured"; redirect_uri: string; label: string }
  | { state: "not_connected"; redirect_uri: string; label: string }
  | { state: "needs_reconnect"; email: string | null; redirect_uri: string; label: string }
  | { state: "connected"; email: string | null; connected_at: number; redirect_uri: string; label: string };
export type AccessPlan = { kind: "use"; token: string } | { kind: "refresh" } | { kind: "reconnect" };

type GmailHeader = { name?: string; value?: string };
export type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: GmailHeader[] };
export type GmailMessage = { id?: string; threadId?: string; internalDate?: string; payload?: GmailPart };
type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: unknown;
  error_description?: unknown;
};

/** Test seam: tests replace deps.fetch and restore it afterwards. */
export const deps: { fetch: (input: string | URL, init?: RequestInit) => Promise<Response> } = {
  fetch: (input, init) => fetch(input, init),
};

export class GmailError extends Error {
  /** OAuth error code from the token endpoint (e.g. "invalid_grant"), else null. */
  readonly oauthError: string | null;
  readonly status: number;
  constructor(message: string, status = 0, oauthError: string | null = null) {
    super(message);
    this.name = "GmailError";
    this.status = status;
    this.oauthError = oauthError;
  }
}

/** `invalid_grant` on a refresh = access withdrawn (or expired): no retry fixes it, only a reconnect. */
export const isRefusedRefresh = (e: unknown): boolean => e instanceof GmailError && e.oauthError === "invalid_grant";

export const mintState = (): string => randomBytes(16).toString("base64url");

export const gmailWebLink = (id: string): string => `https://mail.google.com/mail/u/0/#all/${id}`;

// ---------------------------------------------------------------- config

/** Read per call (not at import) so tests can toggle the env. Throws on a junk MAIL_MAX_PER_RUN, like intEnv. */
export function getGmailConfig(env: Record<string, string | undefined> = process.env): GmailConfig {
  const raw = env.MAIL_MAX_PER_RUN?.trim();
  let maxPerRun = DEFAULT_MAX_PER_RUN;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) throw new Error(`MAIL_MAX_PER_RUN must be a non-negative integer, got "${raw}"`);
    maxPerRun = n;
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID?.trim() || "",
    clientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || "",
    redirectUri: env.GOOGLE_REDIRECT_URI?.trim() || `http://127.0.0.1:${UI_PORT}/api/gmail/callback`,
    label: env.MAIL_LABEL?.trim() || DEFAULT_LABEL,
    maxPerRun,
  };
}

export const isConfigured = (cfg: GmailConfig = getGmailConfig()): boolean => Boolean(cfg.clientId && cfg.clientSecret);

// ---------------------------------------------------------------- token file

/** The stored token, or null when the file is missing or unreadable. */
export function readToken(path = GMAIL_TOKEN_PATH): GmailToken | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    email: str(o.email),
    refresh_token: str(o.refresh_token),
    access_token: str(o.access_token),
    expires_at: num(o.expires_at),
    needs_reconnect: o.needs_reconnect === true,
    connected_at: num(o.connected_at),
  };
}

/** Writes the token file with mode 0600 (chmod too: the open mode only applies when the file is created). */
export function writeToken(t: GmailToken, path = GMAIL_TOKEN_PATH): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(t, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function clearToken(path = GMAIL_TOKEN_PATH): void {
  rmSync(path, { force: true });
}

export function gmailStatus(cfg: GmailConfig = getGmailConfig(), token: GmailToken | null = readToken()): GmailStatus {
  const base = { redirect_uri: cfg.redirectUri, label: cfg.label };
  if (!isConfigured(cfg)) return { state: "not_configured", ...base };
  if (!token?.refresh_token) return { state: "not_connected", ...base };
  if (token.needs_reconnect) return { state: "needs_reconnect", email: token.email, ...base };
  return { state: "connected", email: token.email, connected_at: token.connected_at, ...base };
}

// ---------------------------------------------------------------- OAuth

/** Google's consent screen for a state the server minted. */
export function consentUrl(cfg: GmailConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_BASE}?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await deps.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const parsed: unknown = await res.json().catch(() => null);
  const json: TokenResponse = parsed && typeof parsed === "object" ? (parsed as TokenResponse) : {};
  if (!res.ok) {
    const code = typeof json.error === "string" ? json.error : null;
    const desc = typeof json.error_description === "string" ? json.error_description : null;
    throw new GmailError(desc || code || `Token request failed (${res.status})`, res.status, code);
  }
  return json;
}

const expiresAt = (expiresIn: number | undefined, now: number) =>
  now + (typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600) * 1000;

/**
 * The token a Gmail connect writes, given the token stored before. Pure.
 *
 * Google only returns a refresh token on the first consent: never null an existing one. The email is
 * cleared, not carried over: a re-consent may be a different Google account, and if the profile lookup
 * after it fails the old address must not be shown against the new mailbox.
 */
export function gmailTokenPatch(prev: GmailToken | null, t: TokenResponse, now = Date.now()): GmailToken {
  return {
    email: null,
    refresh_token: t.refresh_token || prev?.refresh_token || null,
    access_token: t.access_token || null,
    expires_at: expiresAt(t.expires_in, now),
    needs_reconnect: false,
    connected_at: now,
  };
}

/** What getAccessToken does with a stored token. Pure. */
export function accessPlan(t: GmailToken | null, now = Date.now()): AccessPlan {
  if (!t || t.needs_reconnect || (!t.access_token && !t.refresh_token)) return { kind: "reconnect" };
  if (t.access_token && now < t.expires_at - REFRESH_SKEW_MS) return { kind: "use", token: t.access_token };
  if (t.refresh_token) return { kind: "refresh" };
  return { kind: "reconnect" };
}

/** Exchanges the callback's code, stores the token, then looks up the account's address (non-fatal). */
export async function exchangeCode(code: string, cfg: GmailConfig = getGmailConfig()): Promise<GmailToken> {
  const res = await tokenRequest({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });
  let token = gmailTokenPatch(readToken(), res);
  writeToken(token);

  // Show which account is linked. Non-fatal if it fails.
  try {
    const profile = await apiGet<{ emailAddress?: unknown }>("/profile", {}, cfg);
    if (typeof profile.emailAddress === "string" && profile.emailAddress) {
      token = { ...token, email: profile.emailAddress };
      writeToken(token);
    }
  } catch (e) {
    console.error(`[gmail] profile lookup failed: ${errMsg(e)}`);
  }
  return token;
}

/**
 * A valid access token: the stored one, or a refreshed one. A refused refresh (invalid_grant) marks the
 * token needs_reconnect and rethrows; a missing or flagged token throws without calling Google.
 */
export async function getAccessToken(cfg: GmailConfig = getGmailConfig()): Promise<string> {
  const t = readToken();
  const plan = accessPlan(t);
  if (plan.kind === "use") return plan.token;
  if (plan.kind === "reconnect" || !t?.refresh_token) {
    throw new GmailError("Gmail is not connected or access expired; reconnect in Setup", 401);
  }

  let res: TokenResponse;
  try {
    res = await tokenRequest({
      refresh_token: t.refresh_token,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
    });
  } catch (e) {
    if (isRefusedRefresh(e)) writeToken({ ...t, needs_reconnect: true });
    throw e;
  }
  if (!res.access_token) throw new GmailError("Gmail token refresh returned no access token", 502);

  writeToken({
    ...t,
    access_token: res.access_token,
    refresh_token: res.refresh_token || t.refresh_token,
    expires_at: expiresAt(res.expires_in, Date.now()),
  });
  return res.access_token;
}

// ---------------------------------------------------------------- Gmail API

type Params = Record<string, string | number | string[] | undefined>;

async function apiGet<T>(path: string, params: Params = {}, cfg: GmailConfig = getGmailConfig()): Promise<T> {
  const accessToken = await getAccessToken(cfg);
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
    else if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await deps.fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (json as { error?: { message?: unknown } } | null)?.error?.message;
    throw new GmailError(typeof msg === "string" && msg ? msg : `Gmail API error (${res.status})`, res.status);
  }
  if (!json || typeof json !== "object") throw new GmailError(`Gmail API returned no JSON (${res.status})`, res.status);
  return json as T;
}

/** Id of the user label with this name (case-insensitive), or null. */
export async function labelId(name: string): Promise<string | null> {
  const res = await apiGet<{ labels?: { id?: unknown; name?: unknown }[] }>("/labels");
  const want = name.trim().toLowerCase();
  for (const l of Array.isArray(res.labels) ? res.labels : []) {
    const labelName = l?.name;
    const id = l?.id;
    if (typeof labelName === "string" && typeof id === "string" && labelName.toLowerCase() === want) return id;
  }
  return null;
}

/** Newest message ids in the label from the last 2 days, one page, at most `max` (and 100). */
export async function listMessageIds(label: string, max: number): Promise<string[]> {
  if (max <= 0) return [];
  const res = await apiGet<{ messages?: { id?: unknown }[] }>("/messages", {
    labelIds: label,
    q: `newer_than:${NEWER_THAN}`,
    maxResults: Math.min(max, LIST_PAGE_MAX),
  });
  return (Array.isArray(res.messages) ? res.messages : [])
    .map((m) => m?.id)
    .filter((id): id is string => typeof id === "string" && MESSAGE_ID.test(id))
    .slice(0, max);
}

export async function getMessage(id: string): Promise<GmailMessage> {
  if (!MESSAGE_ID.test(id)) throw new GmailError(`not a Gmail message id: ${id.slice(0, 40)}`, 400);
  return apiGet<GmailMessage>(`/messages/${encodeURIComponent(id)}`, { format: "full" });
}

/** A header of the message (case-insensitive name), or "". */
export function header(m: GmailMessage, name: string): string {
  const want = name.toLowerCase();
  const raw = m.payload?.headers;
  for (const h of Array.isArray(raw) ? raw : []) {
    const n = h?.name;
    if (typeof n === "string" && n.toLowerCase() === want) return typeof h.value === "string" ? h.value : "";
  }
  return "";
}

function decodePart(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8").replace(/\r\n?/g, "\n");
}

/** First part of this mime type anywhere in the (possibly nested) MIME tree. */
function findPart(payload: GmailPart | undefined, mimeType: string): GmailPart | null {
  if (!payload) return null;
  if (payload.mimeType === mimeType && payload.body?.data) return payload;
  for (const part of Array.isArray(payload.parts) ? payload.parts : []) {
    const found = findPart(part, mimeType);
    if (found) return found;
  }
  return null;
}

/** The first text/plain and text/html parts, decoded (html raw; the parser converts it). "" when absent. */
export function extractParts(payload?: GmailPart): { text: string; html: string } {
  const plain = findPart(payload, "text/plain");
  const html = findPart(payload, "text/html");
  return { text: plain ? decodePart(plain) : "", html: html ? decodePart(html) : "" };
}
