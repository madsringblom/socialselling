import { describe, expect, test } from "bun:test";
import {
  canonicalPostUrl,
  cleanLines,
  groupFromSubject,
  longestBlock,
  parseNotification,
  platformOf,
  titleFrom,
} from "../src/mail/parse.ts";
import { decodeEntities, htmlToText } from "../src/mail/text.ts";
import {
  BOILERPLATE_ONLY,
  FB_COMMENT,
  FB_HTML,
  FB_PLAIN,
  FB_TABLE,
  FB_VIA,
  LINKEDIN,
  LI_COLON,
  LI_DIGEST,
  LI_POSTED_COLON,
  UNKNOWN_SENDER,
  input,
} from "./mail-fixtures.ts";
import type { ParsedPost } from "../src/mail/parse.ts";

/** The author's name appears nowhere in what is stored. */
function expectNoName(p: ParsedPost | null, ...names: string[]): void {
  expect(p).not.toBeNull();
  for (const n of names) {
    expect(p!.channel.toLowerCase()).not.toContain(n.toLowerCase());
    expect(p!.title.toLowerCase()).not.toContain(n.toLowerCase());
    expect(p!.text.toLowerCase()).not.toContain(n.toLowerCase());
  }
}

describe("parseNotification", () => {
  test("Facebook plain text: group from subject, unwrapped /n/ link, author dropped", () => {
    const p = parseNotification(input(FB_PLAIN));
    expect(p).not.toBeNull();
    expect(p!.platform).toBe("facebook");
    expect(p!.channel).toBe("Frivillige i Idrætsforeninger");
    expect(p!.url).toBe("https://www.facebook.com/groups/123456/permalink/7890/");
    expect(p!.postLinkFound).toBe(true);
    expect(p!.text.startsWith("Hej alle, er der nogen")).toBe(true);
    expect(p!.text).not.toContain("Anders");
    expect(p!.text).not.toContain("Se opslag");
    expect(p!.text).not.toContain("Meta Platforms");
    expect(p!.title.startsWith("Hej alle")).toBe(true);
  });

  test("Facebook html only: entities decoded, group from [brackets], link without query", () => {
    const p = parseNotification(input(FB_HTML));
    expect(p).not.toBeNull();
    expect(p!.platform).toBe("facebook");
    expect(p!.channel).toBe("Foreningsledere DK");
    expect(p!.url).toBe("https://www.facebook.com/groups/foreningsledere/posts/112233/");
    expect(p!.text).toContain("håndterer I kontingentændringer og økonomi");
    expect(p!.text).not.toContain("Lise");
    expect(p!.text).not.toContain("Foreningsledere DK");
  });

  test("LinkedIn: group from subject, /comm/ stripped, name and headline lines dropped", () => {
    const p = parseNotification(input(LINKEDIN));
    expect(p).not.toBeNull();
    expect(p!.platform).toBe("linkedin");
    expect(p!.channel).toBe("Danske Foreningsledere");
    expect(p!.url).toBe("https://www.linkedin.com/groups/9876/posts/7123456789");
    expect(p!.text.startsWith("Nogen der bruger Holdsport")).toBe(true);
    expect(p!.text).not.toContain("Mette");
    expect(p!.text).not.toContain("Unsubscribe");
    expect(p!.text).not.toContain("LinkedIn Corporation");
  });

  test("unknown sender: platform other, Gmail link, no group", () => {
    const p = parseNotification(input(UNKNOWN_SENDER, { messageId: "abc123" }));
    expect(p).not.toBeNull();
    expect(p!.platform).toBe("other");
    expect(p!.url).toBe("https://mail.google.com/mail/u/0/#all/abc123");
    expect(p!.postLinkFound).toBe(false);
    expect(p!.channel).toBe("");
    // Blocks up to the first link are joined: the greeting stays with the text.
    expect(p!.text).toBe("Kære medlem\n\nHusk generalforsamlingen på torsdag kl. 19 i klubhuset. Vi skal vælge en ny kasserer.");
  });

  test("LinkedIn subject 'Name: title' and 'Name posted: title': the name is neither group nor text", () => {
    for (const f of [LI_COLON, LI_POSTED_COLON]) {
      const p = parseNotification(input(f));
      expectNoName(p, "Mette Hansen", "Mette");
      expect(p!.channel).toBe("");
      expect(p!.text.startsWith("Nogen der bruger Holdsport")).toBe(true);
    }
  });

  test("Facebook sender 'Name (via Facebook)': group from the link slug, name nowhere", () => {
    const p = parseNotification(input(FB_VIA));
    expectNoName(p, "Anders Jensen", "Anders");
    expect(p!.channel).toBe("foreningsledere");
    expect(p!.url).toBe("https://www.facebook.com/groups/foreningsledere/posts/1/");
    expect(p!.text.startsWith("Hej alle. Vi leder efter")).toBe(true);
    expect(p!.text.endsWith("Tak,")).toBe(true); // "Tak, Anders": the first name is scrubbed too
  });

  test("author and subject verbs agree (Danish and English forms)", () => {
    const post = "Hej alle, er der nogen der kan anbefale et system til vagtplaner? Tak, Anders";
    for (const verb of [
      "har slået et opslag op i",
      "har slået noget op i",
      "slog et opslag op i",
      "har skrevet i",
      "delte et link i",
      "har delt i",
      "shared a link in",
      "shared a photo in",
      "shared a post in",
      "shared in",
      "added a new post in",
      "posted in",
    ]) {
      const subject = `Anders Jensen ${verb} Klubledere`;
      const p = parseNotification(input({ from: FB_PLAIN.from, subject, text: `${subject}\n\n${post}` }));
      expectNoName(p, "Anders Jensen", "Anders");
      expect(p!.channel).toBe("Klubledere");
    }
  });

  test("table cells do not glue the author line to the post", () => {
    const p = parseNotification(input(FB_TABLE));
    expectNoName(p, "Lise Holm", "Lise");
    expect(p!.text).toBe("Vi er en lille forening og søger et nyt system til kontingent.");
    expect(p!.channel).toBe("Foreningsledere DK");
  });

  test("consecutive blocks are joined up to the first link", () => {
    const text = `Anders Jensen skrev i Klubledere

Hej alle,

vi har 200 medlemmer og styrer kontingent i et regneark. Hvad bruger I?

Se opslag: https://www.facebook.com/groups/klubledere/posts/9/

Hvis du ikke vil modtage disse e-mails, kan du afmelde dig.`;
    const p = parseNotification(input({ from: FB_PLAIN.from, subject: "[Klubledere] Nyt opslag", text }));
    expectNoName(p, "Anders Jensen", "Anders");
    expect(p!.text).toBe("Hej alle,\n\nvi har 200 medlemmer og styrer kontingent i et regneark. Hvad bruger I?");
  });

  test("a digest keeps the longest post and its own link", () => {
    const p = parseNotification(input(LI_DIGEST));
    expectNoName(p, "Mette Hansen", "Jens Olsen");
    expect(p!.channel).toBe("Danske Foreningsledere");
    expect(p!.text.startsWith("Vi har lige skiftet fra regneark")).toBe(true);
    expect(p!.text).not.toContain("Kort spørgsmål");
    expect(p!.url).toBe("https://www.linkedin.com/groups/9876/posts/222");
  });

  test("boilerplate only and comment notifications are not posts", () => {
    expect(parseNotification(input(BOILERPLATE_ONLY))).toBeNull();
    expect(parseNotification(input(FB_COMMENT))).toBeNull();
    expect(parseNotification(input({ ...FB_PLAIN, subject: "Anders Jensen kommenterede et opslag i Frivillige" }))).toBeNull();
  });

  test("createdAt: Date header, else internalDate, else null", () => {
    const at = Date.UTC(2026, 10, 3, 7, 15, 0);
    expect(parseNotification(input(FB_PLAIN, { date: new Date(at).toUTCString() }))!.createdAt).toBe(at / 1000);
    expect(parseNotification(input(FB_PLAIN, { date: "Tue, 03 Nov 2026 08:15:00 +0100 (CET)" }))!.createdAt).toBe(at / 1000);
    expect(parseNotification(input(FB_PLAIN, { date: "", internalDate: 1_700_000_000_123 }))!.createdAt).toBe(1_700_000_000);
    expect(parseNotification(input(FB_PLAIN, { date: "not a date" }))!.createdAt).toBeNull();
  });
});

describe("parser helpers", () => {
  test("platformOf by sender domain", () => {
    expect(platformOf('"Facebook" <notification@facebookmail.com>')).toBe("facebook");
    expect(platformOf("groups-noreply@linkedin.com")).toBe("linkedin");
    expect(platformOf("Someone <someone@notfacebookmail.com>")).toBe("other");
    expect(platformOf("")).toBe("other");
  });

  test("groupFromSubject strips quotes and the platform suffix", () => {
    expect(groupFromSubject('Ny aktivitet i "Trænere i DK" - Facebook', "facebook")).toBe("Trænere i DK");
    // No "Group: title" fallback: the part before the colon is as likely a person's name.
    expect(groupFromSubject("Danske Foreningsledere: ny samtale", "linkedin")).toBe("");
    expect(groupFromSubject("Ny samtale i Danske Foreningsledere", "linkedin")).toBe("Danske Foreningsledere");
    expect(groupFromSubject("Nyt opslag i Klubledere (via Facebook)", "facebook")).toBe("Klubledere");
    expect(groupFromSubject("Ugens nyheder", "other")).toBe("");
  });

  test("canonicalPostUrl unwraps l.php and rejects non-post links", () => {
    const wrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent("https://www.facebook.com/groups/abc/posts/123/?x=1")}&h=AT0`;
    expect(canonicalPostUrl(wrapped, "facebook")).toBe("https://www.facebook.com/groups/abc/posts/123/");
    expect(canonicalPostUrl("https://www.facebook.com/settings?tab=notifications", "facebook")).toBeNull();
    expect(canonicalPostUrl("https://www.linkedin.com/feed/update/urn:li:activity:42/?trk=x", "linkedin")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:42/",
    );
    expect(canonicalPostUrl("https://www.linkedin.com/groups/9876/posts/1", "facebook")).toBeNull();
  });

  test("cleanLines and longestBlock", () => {
    const lines = cleanLines("  a  \n\n\n b b \nccc\n\n");
    expect(lines).toEqual(["a", "", "b b", "ccc"]);
    expect(longestBlock(lines)).toBe("b b\nccc");
    expect(longestBlock([])).toBe("");
  });

  test("titleFrom cuts at 80 characters", () => {
    const long = "x".repeat(100);
    expect(titleFrom(`${long}\nsecond line`)).toBe(`${"x".repeat(80)}…`);
    expect(titleFrom("Short   title\nrest")).toBe("Short title");
  });
});

describe("text port (Salgsro text.js)", () => {
  test("decodeEntities", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("a&#150;b")).toBe("a–b");
    expect(decodeEntities("&oslash;&aelig;&aring;&#248;&#xE6;")).toBe("øæåøæ");
    expect(decodeEntities("&AMP; &NBSP;")).toBe("& \xa0");
    expect(decodeEntities("&unknown; &#0;")).toBe("&unknown; \u{FFFD}");
    expect(decodeEntities(null)).toBe("");
  });

  test("htmlToText keeps line breaks and collapses spaces", () => {
    expect(htmlToText("<p>Hej</p><p>med&nbsp;&nbsp;dig</p>a<br>b")).toBe("Hej\nmed dig\na\nb");
    expect(htmlToText("<style>p{}</style><script>x()</script><div>one</div>\n\n\n\n<div>two</div>")).toBe("one\n\ntwo");
  });
});
