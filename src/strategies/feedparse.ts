import { decodeEntities, stripHtml } from "./shared.ts";

/** One RSS 2.0 / RSS 1.0 item or Atom entry. Tolerant regex parsing; good enough for news feeds. */
export type FeedEntry = { id: string; title: string; link: string; summary: string; published: number | null; author: string };

const CDATA_RE = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

export function isFeedXml(xml: string): boolean {
  return /<(rss|feed|rdf:RDF)\b/i.test(xml.slice(0, 2048));
}

function innerText(raw: string): string {
  const cdata = CDATA_RE.exec(raw);
  return (cdata ? (cdata[1] ?? "") : decodeEntities(raw)).trim();
}

/** Text of the first <name> element (unprefixed first, then any namespace prefix such as dc: or content:). */
function tag(block: string, name: string): string {
  const plain = new RegExp(`<${name}(?:\\s[^>]*?)?(?<!/)>([\\s\\S]*?)</${name}>`, "i").exec(block);
  if (plain) return innerText(plain[1] ?? "");
  const prefixed = new RegExp(`<([\\w-]+:)${name}(?:\\s[^>]*?)?(?<!/)>([\\s\\S]*?)</\\1${name}>`, "i").exec(block);
  return prefixed ? innerText(prefixed[2] ?? "") : "";
}

function attr(el: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(el);
  return m ? (m[2] ?? m[3] ?? "") : "";
}

function linkOf(block: string): string {
  const text = tag(block, "link");
  if (text) return text;
  const links = block.match(/<link\b[^>]*>/gi) ?? [];
  const alternate = links.find((l) => attr(l, "rel").toLowerCase() === "alternate" && attr(l, "href"));
  const any = alternate ?? links.find((l) => attr(l, "href"));
  return any ? decodeEntities(attr(any, "href")).trim() : "";
}

function publishedOf(block: string): number | null {
  for (const name of ["pubDate", "published", "updated", "date"]) {
    const raw = tag(block, name);
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

function authorOf(block: string): string {
  const source = tag(block, "Source");
  if (source) return source;
  const creator = tag(block, "creator");
  if (creator) return creator;
  const author = tag(block, "author");
  return tag(author, "name") || author;
}

/** Callers check isFeedXml first; non-feed input usually yields []. */
export function parseFeed(xml: string): FeedEntry[] {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  const out: FeedEntry[] = [];
  for (const block of blocks) {
    const title = stripHtml(tag(block, "title")).replace(/\s+/g, " ").trim();
    const link = linkOf(block);
    if (!title && !link) continue;
    const rawSummary = [tag(block, "description"), tag(block, "summary"), tag(block, "encoded"), tag(block, "content")].find(
      (s) => s.length > 0,
    );
    out.push({
      id: tag(block, "guid") || tag(block, "id") || link,
      title,
      link,
      summary: rawSummary ? stripHtml(rawSummary) : "",
      published: publishedOf(block),
      author: authorOf(block),
    });
  }
  return out;
}
