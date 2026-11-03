/**
 * Mail text helpers, ported unchanged from Salgsro (server/src/lib/mail/text.js): entity decoding and
 * HTML → readable text that keeps line breaks. src/strategies/shared.ts keeps its own simpler
 * decodeEntities/stripHtml for the other sources.
 */

/**
 * The named entities people's notes and mails actually carry: Danish letters, typographic quotes and
 * dashes. A Map, so `&constructor;` finds nothing.
 */
const NAMED_ENTITIES = new Map<string, string>([
  ["nbsp", "\xa0"],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["aelig", "æ"],
  ["AElig", "Æ"],
  ["oslash", "ø"],
  ["Oslash", "Ø"],
  ["aring", "å"],
  ["Aring", "Å"],
  ["eacute", "é"],
  ["auml", "ä"],
  ["ouml", "ö"],
  ["uuml", "ü"],
  ["hellip", "…"],
  ["ndash", "–"],
  ["mdash", "—"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["laquo", "«"],
  ["raquo", "»"],
  ["bull", "•"],
  ["euro", "€"],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"],
  ["shy", "\xad"],
]);
/** These were always read case-insensitively here (`&AMP;`, `&NBSP;`). */
const CASELESS_ENTITIES = new Set(["nbsp", "amp", "lt", "gt", "quot", "apos"]);

/**
 * `&#128;`–`&#159;` as Windows-1252, the way browsers read them: Word and Outlook write their dashes and
 * quotes like that. 0 is a code with no character in 1252, dropped.
 */
const CP1252 = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0, 0,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

function codePointText(code: number): string {
  if (code >= 0x80 && code <= 0x9f) {
    const mapped = CP1252[code - 0x80];
    return mapped ? String.fromCodePoint(mapped) : "";
  }
  const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return valid ? String.fromCodePoint(code) : "\u{FFFD}";
}

/**
 * `&amp;`, `&#229;`, `&#xE6;`, `&hellip;` → their characters, in ONE pass: `&amp;lt;` is the text `&lt;`,
 * never `<`. A number that is no character (0, a surrogate, past U+10FFFF) reads as U+FFFD, 128–159 as
 * Windows-1252; a name we do not know is left exactly as written.
 */
export function decodeEntities(s: string | null | undefined): string {
  return String(s ?? "").replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match: string, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      return codePointText(Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    const named = NAMED_ENTITIES.get(body);
    if (named !== undefined) return named;
    const lower = body.toLowerCase();
    return CASELESS_ENTITIES.has(lower) ? (NAMED_ENTITIES.get(lower) ?? match) : match;
  });
}

/**
 * HTML → readable email text. Unlike `stripHtml` (website scraping) this keeps the line breaks: a mail
 * without its paragraphs is unreadable.
 */
export function htmlToText(html: string | null | undefined): string {
  return (
    decodeEntities(
      String(html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(?:p|div|tr|li|h[1-6])\s*>/gi, "\n")
        .replace(/<[^>]+>/g, ""),
    )
      // A no-break space (`&nbsp;`, `&#160;` or the character itself) is a plain space here, so the runs
      // below collapse it like one.
      .replace(/\xa0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
