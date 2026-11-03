import { SOCIAL_WINDOW_S } from "../config.ts";
import type { Config } from "../config.ts";
import type { Item } from "../db.ts";
import {
  GET_BATCH,
  extractParts,
  getGmailConfig,
  getMessage,
  header,
  isConfigured,
  isRefusedRefresh,
  labelId,
  listMessageIds,
  readToken,
} from "../mail/gmail.ts";
import type { GmailMessage } from "../mail/gmail.ts";
import { parseNotification, titleFrom } from "../mail/parse.ts";
import type { ParsedPost } from "../mail/parse.ts";
import { BODY_MAX, chunk, contentHash, errMsg } from "./shared.ts";
import type { CollectResult, Strategy } from "./shared.ts";

const FUTURE_SLACK_S = 5 * 60;
/** Consecutive batches in which every message failed before the pass is given up. */
const MAX_FAILED_BATCHES = 3;
const REFUSED = "mail: Gmail refused the refresh token; reconnect in Setup";

const mailEnabled = (cfg: Config) => cfg.products.some((p) => p.mail.enabled);

/** A parsed group notification as an item. The author is never stored. */
export function mailItem(p: ParsedPost, gmailId: string, label: string, now: number): Item {
  return {
    id: `mail:${gmailId}`,
    source: "mail",
    kind: "post",
    url: p.url,
    title: p.title,
    body: p.text.slice(0, BODY_MAX),
    author: "",
    subreddit: p.channel || (p.platform === "other" ? "mail" : p.platform),
    parent_id: null,
    created_at: p.createdAt ?? now,
    fetched_at: now,
    found_via: `mail:${label}`,
    num_comments: 0,
    score_ups: 0,
    locked: false,
    // The title is derived from the body, so hash the body only.
    content_hash: contentHash("", p.text),
    lang: null,
    rating: null,
  };
}

/** A post pasted in the UI (POST /api/capture): a mail item with found_via "paste", created now. */
export function pasteItem(text: string, url: string | null, channel: string | null, now: number): Item {
  const hash = contentHash("", text);
  return {
    id: `mail:paste:${hash.slice(0, 16)}`,
    source: "mail",
    kind: "post",
    url: url ?? "",
    title: titleFrom(text),
    body: text.slice(0, BODY_MAX),
    author: "",
    subreddit: channel?.trim() || "paste",
    parent_id: null,
    created_at: now,
    fetched_at: now,
    found_via: "paste",
    num_comments: 0,
    score_ups: 0,
    locked: false,
    content_hash: hash,
    lang: null,
    rating: null,
  };
}

function toParsed(m: GmailMessage, gmailId: string): ParsedPost | null {
  const parts = extractParts(m.payload);
  const internal = Number(m.internalDate);
  return parseNotification({
    messageId: gmailId,
    from: header(m, "From"),
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    text: parts.text,
    html: parts.html,
    internalDate: Number.isFinite(internal) && internal > 0 ? internal : undefined,
  });
}

export const mail: Strategy = {
  id: "mail",
  enabled: (cfg) => {
    if (!mailEnabled(cfg)) return "mail skipped: no product has mail enabled";
    if (!isConfigured()) return "mail skipped: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env";
    const token = readToken();
    if (!token?.refresh_token) return "mail skipped: Gmail not connected (bun run ui → Setup → Connect Gmail)";
    if (token.needs_reconnect) return "mail skipped: Gmail access expired or was revoked; reconnect in Setup";
    return true;
  },
  async collect(_cfg, now, log): Promise<CollectResult> {
    const errors: string[] = [];
    const notes: string[] = [];
    const items: Item[] = [];
    const g = getGmailConfig();
    let unreadable = 0;
    let failed = 0;
    let firstFailure = "";

    try {
      const label = await labelId(g.label);
      if (!label) {
        errors.push(`mail: Gmail label "${g.label}" not found; create it and a filter (see README)`);
        return { items, errors, notes };
      }
      const ids = await listMessageIds(label, g.maxPerRun);
      if (g.maxPerRun > 0 && ids.length >= g.maxPerRun) {
        notes.push(`mail: read the newest ${g.maxPerRun} messages in "${g.label}" (MAIL_MAX_PER_RUN); older ones were left`);
      }

      let failedBatches = 0;
      for (const batch of chunk(ids, GET_BATCH)) {
        const results = await Promise.allSettled(batch.map((id) => getMessage(id)));
        const refused = results.find((r) => r.status === "rejected" && isRefusedRefresh(r.reason));
        if (refused) throw (refused as PromiseRejectedResult).reason;

        let batchFailures = 0;
        for (const [i, r] of results.entries()) {
          const gid = batch[i] ?? "";
          if (r.status === "rejected") {
            batchFailures++;
            failed++;
            if (!firstFailure) firstFailure = `${gid}: ${errMsg(r.reason)}`;
            continue;
          }
          const p = toParsed(r.value, gid);
          if (!p) {
            unreadable++;
            continue;
          }
          if (p.createdAt == null || p.createdAt < now - SOCIAL_WINDOW_S || p.createdAt > now + FUTURE_SLACK_S) continue;
          items.push(mailItem(p, gid, g.label, now));
        }

        failedBatches = batchFailures === batch.length ? failedBatches + 1 : 0;
        if (failedBatches >= MAX_FAILED_BATCHES) {
          errors.push(`mail: ${MAX_FAILED_BATCHES} batches in a row failed; stopped reading Gmail`);
          break;
        }
      }
    } catch (e) {
      if (isRefusedRefresh(e)) {
        log("mail: Gmail refused the refresh token");
        return { items, errors: [REFUSED], notes };
      }
      errors.push(`mail: ${errMsg(e)}`);
    }

    if (failed > 0) errors.push(`mail: ${failed} ${failed === 1 ? "message" : "messages"} could not be read (first: ${firstFailure})`);
    if (unreadable > 0) {
      notes.push(`mail: ${unreadable} ${unreadable === 1 ? "notification" : "notifications"} had no readable post`);
    }
    log(`mail: done (${items.length} items, ${errors.length} errors)`);
    return { items, errors, notes };
  },
};
