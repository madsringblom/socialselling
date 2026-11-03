/**
 * Facebook and LinkedIn group notification mails → one post (text, group, link). Pure.
 *
 * Everything format-specific lives in PLATFORMS. The rules were written without a real notification at hand
 * (plausible guesses at both platforms' mails, English and Danish): when a real mail parses badly, tune the
 * platform's regexes here and add the mail as a test fixture.
 *
 * Privacy: the author's name must never end up in the text, title or group. The author is found first (Subject
 * "X posted in Y", "X posted: …", the body's "X skrev i Y" line, a "X (via Facebook)" sender, or a Subject that
 * starts with the body's first line); then the author line and name-only lines go, the name (and first name) is
 * scrubbed from the text, and a group name that contains it is dropped.
 */
import { gmailWebLink } from "./gmail.ts";
import { decodeEntities, htmlToText } from "./text.ts";

export type Platform = "facebook" | "linkedin" | "other";
export type NotificationInput = {
  messageId: string;
  from: string;
  subject: string;
  date: string;
  text: string;
  html: string;
  /** Gmail internalDate, ms. */
  internalDate?: number;
};
export type ParsedPost = {
  platform: Platform;
  /** Group name, or "" when none could be found. */
  channel: string;
  /** Canonical post link, else the Gmail web link of the message. */
  url: string;
  text: string;
  title: string;
  /** Unix seconds, or null when the mail carries no usable date. */
  createdAt: number | null;
  postLinkFound: boolean;
};

type PlatformRules = {
  /** From-address domains (suffix match). */
  senderDomains: string[];
  /** From display names that are the platform itself, not a group. */
  genericSenders: RegExp;
  /** Group name from the Subject: first capture of the first match, in priority order. */
  subjectGroup: RegExp[];
  /** "Name posted in …" lines: capture 1 is the author. Also tried on the Subject. */
  authorLine: RegExp[];
  /** Notifications that are not posts (comments, reactions, replies). */
  skipSubject: RegExp | null;
  /** A link that may point at the post itself. */
  postLink: RegExp;
  /** The canonical post URL of a link that passed postLink, or null when it is not a post. */
  canonical(url: URL): string | null;
  /** Lines that are notification chrome, not post text. The first one after the post ends it. */
  boilerplate: RegExp[];
};

const NEVER = /(?!)/;
const MIN_TEXT = 20;
const TITLE_MAX = 80;

const isHost = (url: URL, domain: string) => {
  const h = url.hostname.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
};

function safeDecode(s: string): string {
  if (!/%[0-9a-f]{2}/i.test(s)) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const FB_POST_PATH = /^\/groups\/[^/]+\/(?:posts|permalink)\/\d+/;

/** facebook.com/n/?groups%2F1%2Fpermalink%2F2… and l.php?u=… wrappers unwrapped; query and fragment dropped. */
function facebookCanonical(url: URL, depth = 0): string | null {
  if (depth > 2 || !isHost(url, "facebook.com")) return null;
  let path = url.pathname;
  if (path === "/n/" || path === "/n") {
    // The target is the first query key (already percent-decoded once by URLSearchParams).
    const key = [...url.searchParams.keys()][0];
    if (!key) return null;
    path = `/${(safeDecode(key).split("?")[0] ?? "").replace(/^\/+/, "")}`;
  } else if (path === "/l.php") {
    const u = url.searchParams.get("u");
    if (!u) return null;
    try {
      return facebookCanonical(new URL(u), depth + 1);
    } catch {
      return null;
    }
  }
  return FB_POST_PATH.test(path) ? `https://www.facebook.com${path}` : null;
}

const LI_POST_PATH = /^\/(?:groups\/\d+\/(?:posts|discussions?)\/|feed\/update\/urn:li:|posts\/)/;

/** linkedin.com/comm/… tracking prefix stripped; query and fragment dropped. */
function linkedinCanonical(url: URL): string | null {
  if (!isHost(url, "linkedin.com")) return null;
  const path = url.pathname.replace(/^\/comm(?=\/)/, "");
  return LI_POST_PATH.test(path) ? `https://www.linkedin.com${path}` : null;
}

const SKIP_SUBJECT = /\b(commented|kommenterede|reacted|reagerede|replied|svarede)\b/i;

/**
 * "<Name> <verb> in <group>" verbs. One list for authorLine and subjectGroup, so a Subject that names a group
 * also yields the author and the other way round.
 */
const EN_IN =
  "(?:posted|shared(?: an? (?:post|link|photo|video))?|added a (?:new )?post|published|wrote|started a (?:new )?(?:conversation|discussion))";
const DA_I =
  "(?:skrev|har skrevet|(?:har slået|slog) (?:et opslag |noget )?op|har delt(?: et (?:link|opslag))?|delte(?: et (?:link|opslag))?|startede en (?:ny )?samtale)";

const groupAfter = (verbs: string, prep: string) => new RegExp(`${verbs}\\s+${prep}\\s+(.+?)\\s*(?::|[-–—]|$)`, "i");
const authorBefore = (verbs: string, prep: string) => new RegExp(`^(.{2,60}?)\\s+${verbs}\\s+${prep}\\b`, "i");

const SHARED_SUBJECT_GROUP = [
  groupAfter(EN_IN, "in"),
  groupAfter(DA_I, "i"),
  /^(?:new posts?|new activity|new conversation|nyt opslag|nye opslag|ny aktivitet|ny samtale)\s+(?:in|i)\s+(.+?)\s*(?::|$)/i,
];
const SHARED_AUTHOR_LINE = [
  authorBefore(EN_IN, "in"),
  authorBefore(DA_I, "i"),
  /^(.{2,60}?)\s+(?:posted|skrev)\s*[:.]?$/i,
];
/** Subject only: "Mette Hansen posted: Nogen der bruger Holdsport?" (no group named). */
const SUBJECT_AUTHOR = /^(.{2,60}?)\s+(?:posted|shared|wrote|published|skrev|har skrevet|delte|har delt)\s*:/i;
/** "Anders Jensen (via Facebook)": a person's name as the sender. */
const VIA_SENDER = /^(.+?)\s*\(?\s*via\s+(?:facebook|linkedin)\s*\)?$/i;
/** A line that looks like a person's name: one to four capitalised words, no sentence punctuation. */
const NAME_LIKE = /^\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,3}$/u;

export const PLATFORMS: Record<Platform, PlatformRules> = {
  facebook: {
    senderDomains: ["facebookmail.com", "facebook.com"],
    genericSenders: /^(facebook|meta|facebook groups?)$/i,
    subjectGroup: [/^\[(.+?)\]/, ...SHARED_SUBJECT_GROUP],
    authorLine: SHARED_AUTHOR_LINE,
    skipSubject: SKIP_SUBJECT,
    postLink: /facebook\.com\/(?:groups\/[^/?#\s]+\/(?:posts|permalink)\/\d+|n\/\?groups|l\.php\?u=)/i,
    canonical: (url) => facebookCanonical(url),
    boilerplate: [
      /^(?:view|see|open|vis|se)\s+(?:post|opslag|on facebook|på facebook)/i,
      /^(?:reply to this email|svar på denne e-mail)/i,
      /meta platforms|facebook, inc|1601 willow|menlo park/i,
      /^(?:this message was sent to|denne (?:meddelelse|besked) blev sendt til)/i,
      /^(?:to stop receiving|hvis du ikke (?:længere )?vil modtage)/i,
      /^(?:unsubscribe|afmeld)/i,
    ],
  },
  linkedin: {
    senderDomains: ["linkedin.com"],
    genericSenders: /^(linkedin|linkedin groups?|linkedin notifications?)$/i,
    // No "Group: title" fallback: "Mette Hansen: Nogen der bruger Holdsport?" would make the author the group.
    subjectGroup: SHARED_SUBJECT_GROUP,
    authorLine: SHARED_AUTHOR_LINE,
    skipSubject: SKIP_SUBJECT,
    postLink: /linkedin\.com\/(?:comm\/)?(?:groups\/\d+\/|feed\/update\/|posts\/)/i,
    canonical: linkedinCanonical,
    boilerplate: [
      /^(?:view|see|open|read)\s+(?:post|conversation|comment|on linkedin)/i,
      /^(?:se|åbn|læs)\s+(?:opslag|samtale|på linkedin)/i,
      /linkedin corporation|1000 w\.? maude|sunnyvale|wilton pl/i,
      /^(?:you are receiving|du modtager)/i,
      /^(?:unsubscribe|afmeld|manage (?:your )?(?:email|notifications)|administrer)/i,
      /^(?:this email was intended for|denne e-mail var tiltænkt)/i,
      /^learn why we included this/i,
      /^©\s*\d{4}/,
      /·\s*(?:1st|2nd|3rd\+?|1\.|2\.|3\.\+?)\s*$/i, // headline under the name: "Formand, Hjørring IF · 2nd"
    ],
  },
  other: {
    senderDomains: [],
    genericSenders: NEVER,
    subjectGroup: [],
    authorLine: [],
    skipSubject: null,
    postLink: NEVER,
    canonical: () => null,
    boilerplate: [],
  },
};

/** Lines that are never post text, whatever the platform. Lines of 2 characters or fewer are dropped too. */
const COMMON_BOILERPLATE: RegExp[] = [
  /^<?https?:\/\/\S+>?$/, // URL-only lines
  /^(?:©|\(c\)|copyright)/i,
  /^(?:download|hent|get) the app/i,
  /^(?:like|synes godt om|comment|kommenter|share|del)\s*(?:·|\||$)/i,
  /^(?:privacy|privatliv|help|hjælp|settings|indstillinger)\b.*(?:·|\|)/i,
  /\b(?:unsubscribe|afmeld)\b/i,
  /^\[image[^\]]*\]$/i,
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const same = (a: string, b: string) => a !== "" && b !== "" && a.toLowerCase() === b.toLowerCase();
const contains = (haystack: string, needle: string) =>
  needle !== "" && haystack.toLowerCase().includes(needle.toLowerCase());

function parseFrom(from: string): { name: string; address: string } {
  const raw = from.trim();
  const angle = /<([^<>\s]+)>\s*$/.exec(raw);
  const address = (angle?.[1] ?? raw).trim().toLowerCase();
  const name = angle
    ? raw
        .slice(0, angle.index)
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim()
    : "";
  return { name, address };
}

/** Platform from the From address's domain (suffix match), else "other". */
export function platformOf(from: string): Platform {
  const { address } = parseFrom(from);
  const at = address.lastIndexOf("@");
  const domain = at >= 0 ? address.slice(at + 1) : "";
  if (!domain) return "other";
  for (const p of ["facebook", "linkedin"] as const) {
    if (PLATFORMS[p].senderDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) return p;
  }
  return "other";
}

/** Collapsed spaces, no surrounding quotes, no trailing " - Facebook" / " | LinkedIn" / "(via Facebook)". */
function cleanGroup(s: string): string {
  return oneLine(s)
    .replace(/\s*\(?\s*via\s+(?:facebook|linkedin)\s*\)?$/i, "")
    .replace(/\s*[-–—|]\s*(?:facebook|linkedin)$/i, "")
    .replace(/^["'“”„«»]+|["'“”„«»]+$/g, "")
    .trim();
}

/** The group name in a notification's Subject, or "". */
export function groupFromSubject(subject: string, platform: Platform): string {
  for (const re of PLATFORMS[platform].subjectGroup) {
    const g = re.exec(subject)?.[1];
    const clean = g ? cleanGroup(g) : "";
    if (clean) return clean;
  }
  return "";
}

/** The canonical post URL for a link from the mail, or null when it is not a post link of this platform. */
export function canonicalPostUrl(link: string, platform: Platform): string | null {
  const rules = PLATFORMS[platform];
  if (!rules.postLink.test(link)) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  return rules.canonical(url);
}

/** Trimmed lines with runs of blank lines collapsed to one "" and no leading/trailing blanks. */
export function cleanLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** Blocks of lines between blank lines, each joined with "\n". */
function blocksOf(lines: string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of [...lines, ""]) {
    if (line !== "") {
      current.push(line);
    } else if (current.length > 0) {
      out.push(current.join("\n"));
      current = [];
    }
  }
  return out;
}

/** The longest block (lines between blank lines) by character count, joined with "\n"; the first on a tie. */
export function longestBlock(lines: string[]): string {
  let best = "";
  for (const b of blocksOf(lines)) if (b.length > best.length) best = b;
  return best;
}

/** First line of the text, at most 80 characters plus "…" (as for Bluesky). */
export function titleFrom(text: string): string {
  const first = oneLine(text.split("\n")[0] ?? "");
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX)}…` : first;
}

function candidateLinks(html: string, text: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const v = m[1] ?? m[2];
    if (v) out.push(decodeEntities(v).trim());
  }
  for (const m of text.matchAll(/https?:\/\/\S+/g)) out.push(m[0].replace(/[>).,]+$/, ""));
  return out;
}

/** First canonical post link among the candidates, or null. */
function firstPostLink(links: string[], platform: Platform): string | null {
  for (const link of links) {
    const c = canonicalPostUrl(link, platform);
    if (c) return c;
  }
  return null;
}

/** Capture 1 of the first authorLine rule that matches, trimmed, or null. */
function authorIn(line: string, rules: PlatformRules): string | null {
  for (const re of rules.authorLine) {
    const a = re.exec(line)?.[1]?.trim();
    if (a) return a;
  }
  return null;
}

/** The author's name on its own, or followed by a separator ("Mette Hansen · 2nd", "Mette Hansen, Formand"). */
function isAuthorLine(line: string, author: string): boolean {
  if (same(line, author)) return true;
  if (!line.toLowerCase().startsWith(author.toLowerCase())) return false;
  return /^\s*[·|,\-–—]/.test(line.slice(author.length));
}

/** The full name, and its first name when the name has several words and the first has 3+ letters. */
function scrubTerms(name: string): string[] {
  const words = name.split(/\s+/).filter(Boolean);
  const first = words[0] ?? "";
  return words.length > 1 && (first.match(/\p{L}/gu)?.length ?? 0) >= 3 ? [name, first] : [name];
}

function scrubNames(text: string, names: string[]): string {
  let out = text;
  for (const term of names.flatMap(scrubTerms)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "giu"), "");
  }
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim())
    .join("\n")
    .trim();
}

/** Unix seconds from the Date header, else from Gmail's internalDate, else null. */
function createdAtOf(input: NotificationInput): number | null {
  // "… +0100 (CET)": the trailing comment is not part of the date and trips some parsers.
  const ms = Date.parse(input.date.replace(/\s*\([^)]*\)\s*$/, ""));
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  const internal = input.internalDate;
  return internal != null && Number.isFinite(internal) && internal > 0 ? Math.floor(internal / 1000) : null;
}

/** Mail HTML → text; table cells end a line here (text.ts stays an exact port), so cells do not run together. */
function mailHtmlToText(html: string): string {
  return htmlToText(html.replace(/<\/t[dh]\s*>/gi, "\n"));
}

/**
 * The author, from (in order): the Subject's "X posted in Y" or "X posted: …", the first body line of the
 * "X skrev i Y" form, a "X (via Facebook)" sender, or, as a safety net, a name-like first body line that the
 * Subject starts with. `line` is the index of the body line that named the author, if any.
 */
function findAuthor(
  subject: string,
  lines: string[],
  sender: string,
  rules: PlatformRules,
  platform: Platform,
): { author: string | null; line: number; fromSubject: boolean } {
  const fromSubject = authorIn(subject, rules) ?? (platform === "other" ? null : SUBJECT_AUTHOR.exec(subject)?.[1]?.trim() || null);
  if (fromSubject) return { author: fromSubject, line: -1, fromSubject: true };
  const i = lines.findIndex((l) => l !== "" && authorIn(l, rules) !== null);
  if (i >= 0) return { author: authorIn(lines[i] ?? "", rules), line: i, fromSubject: false };
  const via = platform === "other" ? null : VIA_SENDER.exec(sender)?.[1]?.trim();
  if (via) return { author: via, line: -1, fromSubject: false };
  const first = lines.find((l) => l !== "") ?? "";
  if (
    platform !== "other" &&
    first.length <= 60 &&
    NAME_LIKE.test(first) &&
    subject.length > first.length &&
    subject.toLowerCase().startsWith(first.toLowerCase())
  ) {
    return { author: first, line: -1, fromSubject: false };
  }
  return { author: null, line: -1, fromSubject: false };
}

export function parseNotification(input: NotificationInput): ParsedPost | null {
  const platform = platformOf(input.from);
  const rules = PLATFORMS[platform];
  const subject = oneLine(input.subject);
  if (rules.skipSubject?.test(subject)) return null; // comments and reactions are not posts

  const plain = input.text.replace(/\r\n?/g, "\n");
  const body = plain.replace(/\s/g, "").length >= MIN_TEXT ? plain : mailHtmlToText(input.html);
  const sender = parseFrom(input.from).name;

  let lines = cleanLines(body);

  // 1. Author first, so it can never become the group.
  const found = findAuthor(subject, lines, sender, rules, platform);
  const names: string[] = [];
  if (found.author) names.push(found.author);
  const via = platform === "other" ? null : VIA_SENDER.exec(sender)?.[1]?.trim();
  if (via && !names.some((n) => same(n, via))) names.push(via);
  if (found.line >= 0) lines.splice(found.line, 1);
  if (found.fromSubject && found.author) {
    const a = found.author;
    lines = lines.filter((l) => !same(authorIn(l, rules) ?? "", a));
  }
  for (const n of names) lines = lines.filter((l) => l === "" || !isAuthorLine(l, n));
  lines = cleanLines(lines.join("\n"));

  // 2. Post link.
  const link = firstPostLink(candidateLinks(input.html, plain), platform);
  let url = link ?? gmailWebLink(input.messageId);
  let postLinkFound = link !== null;

  // 3. Group: Subject, then the /groups/<slug>/ of the post link, then the sender's display name when it is a
  //    group rather than a person. Never anything that contains the author's name. Unknown senders have no group.
  let channel = groupFromSubject(subject, platform);
  if (!channel && link) {
    const slug = /\/groups\/([^/]+)\//.exec(new URL(link).pathname)?.[1];
    if (slug && !/^\d+$/.test(slug)) channel = cleanGroup(safeDecode(slug).replace(/[-.]/g, " "));
  }
  if (
    !channel &&
    platform !== "other" &&
    sender &&
    !rules.genericSenders.test(sender) &&
    !/\bvia\s+(?:facebook|linkedin)\b/i.test(sender) &&
    authorIn(sender, rules) === null &&
    !names.some((n) => same(n, sender))
  ) {
    channel = cleanGroup(sender);
  }
  if (names.some((n) => contains(channel, n))) channel = "";

  // 4. The post: consecutive blocks from the first text line up to the first link or footer line. When more text
  //    follows that (a digest with several posts), keep only the longest block, with the link that follows it.
  const boilerplate = [...COMMON_BOILERPLATE, ...rules.boilerplate];
  const isChrome = (l: string) => boilerplate.some((re) => re.test(l));
  const isNoise = (l: string) => l.length <= 2 || same(l, channel) || same(l, subject);
  const post: string[] = [];
  let stop = -1;
  for (const [i, l] of lines.entries()) {
    const started = post.length > 0;
    if (l === "") {
      if (started) post.push("");
      continue;
    }
    if (isChrome(l)) {
      if (started) {
        stop = i;
        break;
      }
      continue;
    }
    if (isNoise(l) || (!started && NAME_LIKE.test(l))) continue;
    post.push(l);
  }

  const keep = (ls: string[]) => cleanLines(ls.filter((l) => l === "" || (!isChrome(l) && !isNoise(l))).join("\n"));
  const rest = stop >= 0 ? lines.slice(stop + 1) : [];
  const isDigest = blocksOf(keep(rest)).some((b) => b.length >= MIN_TEXT && !NAME_LIKE.test(b));

  let text: string;
  if (isDigest) {
    text = longestBlock(keep(lines));
    // The digest's own link for this post: the first post link after the block's last line.
    const last = text.split("\n").pop() ?? "";
    const at = lines.indexOf(last);
    const own = at >= 0 ? firstPostLink(candidateLinks("", lines.slice(at + 1).join("\n")), platform) : null;
    if (own) {
      url = own;
      postLinkFound = true;
    }
  } else {
    text = blocksOf(cleanLines(post.join("\n")))
      .filter((b) => !NAME_LIKE.test(b))
      .join("\n\n");
  }

  if (names.length > 0) text = scrubNames(text, names);
  if (text.length < MIN_TEXT) return null;

  return {
    platform,
    channel,
    url,
    text,
    title: titleFrom(text),
    createdAt: createdAtOf(input),
    postLinkFound,
  };
}
