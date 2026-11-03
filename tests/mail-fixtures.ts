/**
 * Notification fixtures for the mail source. Plausible guesses, replace with a real mail: none of these was
 * copied from an actual Facebook or LinkedIn notification. When a real one parses badly, paste it here and
 * tune PLATFORMS in src/mail/parse.ts.
 */
import type { GmailMessage, GmailToken } from "../src/mail/gmail.ts";
import type { NotificationInput } from "../src/mail/parse.ts";
import { MINIMAL_YAML } from "./helpers.ts";

export type Fixture = { from: string; subject: string; text?: string; html?: string };

// plausible guess, replace with a real mail
export const FB_PLAIN: Fixture = {
  from: '"Facebook" <notification@facebookmail.com>',
  subject: "Anders Jensen slog et opslag op i Frivillige i Idrætsforeninger",
  text: `Anders Jensen slog et opslag op i Frivillige i Idrætsforeninger

Hej alle, er der nogen der har erfaring med et system til vagtplaner og kontingent? Vi drukner i regneark…

Se opslag: https://www.facebook.com/n/?groups%2F123456%2Fpermalink%2F7890%2F&aref=1&medium=email&mid=abc

Denne meddelelse blev sendt til anders@example.com. Hvis du ikke vil modtage disse e-mails fra Meta i fremtiden, skal du afmelde dig.
Meta Platforms, Inc., Attention: Community Support, 1 Meta Way, Menlo Park, CA 94025`,
};

// plausible guess, replace with a real mail
export const FB_HTML: Fixture = {
  from: '"Facebook" <notification@facebookmail.com>',
  subject: "[Foreningsledere DK] Nyt opslag",
  html: `<html><head><style>td { font-family: Helvetica; }</style></head><body>
<table width="100%"><tr><td><b>Foreningsledere DK</b></td></tr>
<tr><td>Lise Holm skrev i Foreningsledere DK</td></tr>
<tr><td>Vi er en lille forening med 120 medlemmer. Hvordan h&aring;ndterer I kontingent&aelig;ndringer og &#248;konomi uden tre forskellige regneark?</td></tr>
<tr><td><a href="https://www.facebook.com/groups/foreningsledere/posts/112233/?__cft__[0]=x&amp;__tn__=R">Se opslag</a></td></tr>
<tr><td>Denne meddelelse blev sendt til lise@example.com.</td></tr>
</table></body></html>`,
};

// plausible guess, replace with a real mail
export const LINKEDIN: Fixture = {
  from: '"LinkedIn Groups" <groups-noreply@linkedin.com>',
  subject: "Mette Hansen posted in Danske Foreningsledere: Nogen der bruger Holdsport?",
  text: `Mette Hansen
Formand, Hjørring IF · 2nd

Nogen der bruger Holdsport eller lignende til kontingent? Vi er 300 medlemmer, og kassereren bruger hver måned en hel aften på at rykke for betalinger.

View post: https://www.linkedin.com/comm/groups/9876/posts/7123456789?trk=eml-x&midToken=1

You are receiving Groups notifications. Unsubscribe · Help
© 2026 LinkedIn Corporation, 1000 West Maude Avenue, Sunnyvale, CA 94085.`,
};

export const UNKNOWN_SENDER: Fixture = {
  from: "Klubnyt <nyhedsbrev@klubnyt.dk>",
  subject: "Ugens nyheder fra klubben",
  text: `Kære medlem

Husk generalforsamlingen på torsdag kl. 19 i klubhuset. Vi skal vælge en ny kasserer.

https://klubnyt.dk/nyhed/1`,
};

// plausible guess, replace with a real mail
export const BOILERPLATE_ONLY: Fixture = {
  from: '"Facebook" <notification@facebookmail.com>',
  subject: "Nyt opslag i Frivillige i Idrætsforeninger",
  text: `Se opslag på Facebook

Denne meddelelse blev sendt til x@example.com.
Meta Platforms, Inc., 1601 Willow Road, Menlo Park, CA 94025
Afmeld`,
};

// plausible guess, replace with a real mail
export const FB_COMMENT: Fixture = {
  from: '"Facebook" <notification@facebookmail.com>',
  subject: "Anders Jensen commented on a post in Frivillige i Idrætsforeninger",
  text: "Anders Jensen commented: Vi bruger et delt regneark til vagtplanen, det virker fint for os.",
};

// plausible guess, replace with a real mail. No group in the Subject: the author's name must not become the group.
export const LI_COLON: Fixture = {
  from: '"LinkedIn Groups" <groups-noreply@linkedin.com>',
  subject: "Mette Hansen: Nogen der bruger Holdsport?",
  text: LINKEDIN.text,
};

// plausible guess, replace with a real mail
export const LI_POSTED_COLON: Fixture = {
  from: '"LinkedIn Groups" <groups-noreply@linkedin.com>',
  subject: "Mette Hansen posted: Nogen der bruger Holdsport?",
  text: LINKEDIN.text,
};

// plausible guess, replace with a real mail. The person's name is the sender; the group is only in the link.
export const FB_VIA: Fixture = {
  from: '"Anders Jensen (via Facebook)" <notification@facebookmail.com>',
  subject: "Nyt opslag fra Anders Jensen",
  text: `Anders Jensen har skrevet i Foreningsledere

Hej alle. Vi leder efter en afløser for vores gamle medlemssystem, gerne noget med kontingent og vagtplaner. Tak, Anders

Se opslag: https://www.facebook.com/groups/foreningsledere/posts/1/

Denne meddelelse blev sendt til x@example.com.`,
};

// plausible guess, replace with a real mail. A digest: two posts, only the longest is kept, with its own link.
export const LI_DIGEST: Fixture = {
  from: '"LinkedIn Groups" <groups-noreply@linkedin.com>',
  subject: "New posts in Danske Foreningsledere",
  text: `Mette Hansen
Formand · 2nd

Kort spørgsmål: bruger I Holdsport?

View post: https://www.linkedin.com/comm/groups/9876/posts/111?trk=d

Jens Olsen
Kasserer · 3rd

Vi har lige skiftet fra regneark til et rigtigt system til kontingent, og det har sparet os mange timer hver måned.

View post: https://www.linkedin.com/comm/groups/9876/posts/222?trk=d

You are receiving Groups notifications. Unsubscribe · Help`,
};

// plausible guess, replace with a real mail. Author and post in neighbouring table cells.
export const FB_TABLE: Fixture = {
  from: '"Facebook" <notification@facebookmail.com>',
  subject: "[Foreningsledere DK] Nyt opslag",
  html: `<table><tr><td>Lise Holm skrev i Foreningsledere DK</td><td>Vi er en lille forening og søger et nyt system til kontingent.</td></tr>
<tr><td><a href="https://www.facebook.com/groups/foreningsledere/posts/5/">Se opslag</a></td></tr></table>`,
};

/** A parser input for a fixture: message id m1, Date header one hour ago unless given. */
export function input(f: Fixture, o: Partial<NotificationInput> = {}): NotificationInput {
  return {
    messageId: "m1",
    from: f.from,
    subject: f.subject,
    date: new Date(Date.now() - 3600_000).toUTCString(),
    text: f.text ?? "",
    html: f.html ?? "",
    ...o,
  };
}

export const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** A Gmail API message (format=full) for a fixture: multipart/alternative with the parts it has. */
export function gmailMessage(id: string, f: Fixture & { date: string }, internalDate?: number): GmailMessage {
  const parts = [
    ...(f.text ? [{ mimeType: "text/plain", body: { data: b64(f.text) } }] : []),
    ...(f.html ? [{ mimeType: "text/html", body: { data: b64(f.html) } }] : []),
  ];
  return {
    id,
    threadId: id,
    ...(internalDate !== undefined ? { internalDate: String(internalDate) } : {}),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: f.from },
        { name: "Subject", value: f.subject },
        { name: "Date", value: f.date },
      ],
      parts,
    },
  };
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A connected token whose access token is valid for another hour. */
export function freshToken(): GmailToken {
  const now = Date.now();
  return {
    email: "me@example.com",
    refresh_token: "r-1",
    access_token: "a-1",
    expires_at: now + 3600_000,
    needs_reconnect: false,
    connected_at: now,
  };
}

/** A fake Gmail API for deps.fetch: labels, one page of message ids, and the messages by id. */
export function gmailApi(o: { labels: { id: string; name: string }[]; ids: string[]; messages: Record<string, GmailMessage> }) {
  return async (input: string | URL): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
    if (path === "/labels") return jsonResponse({ labels: o.labels });
    if (path === "/messages") return jsonResponse({ messages: o.ids.map((id) => ({ id, threadId: id })) });
    const id = /^\/messages\/([^/]+)$/.exec(path)?.[1];
    const msg = id ? o.messages[decodeURIComponent(id)] : undefined;
    return msg ? jsonResponse(msg) : jsonResponse({ error: { message: "Not Found" } }, 404);
  };
}

/** MINIMAL_YAML with `mail: { enabled: false }` on alpha only, or on every product. */
export function mailYaml(off: "alpha" | "all"): string {
  const re = /( {4}search_phrases: .*\n)/;
  return off === "alpha"
    ? MINIMAL_YAML.replace(re, "$1    mail: { enabled: false }\n")
    : MINIMAL_YAML.replace(new RegExp(re.source, "g"), "$1    mail: { enabled: false }\n");
}

export const GOOGLE_ENV = { GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "test-secret" };

export function setGoogleEnv(): void {
  Object.assign(process.env, GOOGLE_ENV);
}

export function clearGoogleEnv(): void {
  for (const k of [...Object.keys(GOOGLE_ENV), "GOOGLE_REDIRECT_URI", "MAIL_LABEL", "MAIL_MAX_PER_RUN"]) delete process.env[k];
}
