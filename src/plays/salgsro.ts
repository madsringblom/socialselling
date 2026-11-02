import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SALGSRO_DIR, localDateTimeCompact } from "../config.ts";
import { getLead, insertAction, markLeadsExported } from "../db.ts";
import type { LeadRow } from "../db.ts";
import { topSignal } from "./leadscore.ts";

/** Salgsro's import columns (Danish), in order. */
export const CSV_HEADER = ["Navn", "Firma", "E-mail", "Telefon", "Hjemmeside", "Rolle", "Fase", "Noter"];
export const MAX_EXPORT = 200;
const BOM = String.fromCharCode(0xfeff); // UTF-8 BOM so Excel reads the file as UTF-8

/** One CSV row: the first public contact (or blanks), the organisation, and a short note with score, brief and source. */
export function csvRow(l: LeadRow): string[] {
  const c = l.contacts[0];
  const notes = [`${l.classification} ${l.total}/100`];
  for (const line of (l.call_brief ?? []).slice(0, 2)) notes.push(line);
  const url = topSignal(l)?.source_url;
  if (url) notes.push(`Kilde: ${url}`);
  return [c?.name ?? "", l.org_name, c?.email ?? "", c?.phone ?? "", l.website ?? "", c?.role ?? "", "Lead", notes.join(" · ")];
}

const FORMULA_START = /^[=+\-@\t\r]/;
/** Free-text columns get a leading apostrophe when they look like a spreadsheet formula. */
const TEXT_COLS = new Set([0, 1, 5, 7]); // Navn, Firma, Rolle, Noter

/**
 * Quotes a field when it contains the separator, a double quote or a line break (quotes doubled). With `text`, a
 * value starting with = + - @ tab or CR is prefixed with an apostrophe so spreadsheets do not run it as a formula.
 */
export function csvField(s: string, text = false): string {
  const v = text && FORMULA_START.test(s) ? `'${s}` : s;
  return /[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** UTF-8 BOM + header + at most 200 lead rows, ";"-separated, CRLF line endings. */
export function buildCsv(leads: LeadRow[]): string {
  const rows = [CSV_HEADER, ...leads.slice(0, MAX_EXPORT).map(csvRow)];
  return BOM + rows.map((r) => r.map((f, i) => csvField(f, TEXT_COLS.has(i))).join(";")).join("\r\n");
}

/**
 * Writes the given leads to data/salgsro/leads-<YYYY-MM-DD-HHmm>.csv (a "-2", "-3" … suffix when that file exists),
 * marks them exported and records a salgsro_export action per lead. Unknown ids are skipped; none known → throws.
 */
export function exportSalgsro(ids: string[], now = Math.floor(Date.now() / 1000), dir = SALGSRO_DIR): { path: string; count: number } {
  const leads = [...new Set(ids)]
    .map((id) => getLead(id))
    .filter((l): l is LeadRow => l !== null)
    .slice(0, MAX_EXPORT);
  if (leads.length === 0) throw new Error("no leads");

  mkdirSync(dir, { recursive: true });
  const stem = `leads-${localDateTimeCompact(new Date(now * 1000))}`;
  let path = join(dir, `${stem}.csv`);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${stem}-${n}.csv`);
  writeFileSync(path, buildCsv(leads), "utf8");

  const exported = leads.map((l) => l.id);
  markLeadsExported(exported, now);
  for (const id of exported) insertAction("salgsro_export", id, { path }, now);
  return { path, count: exported.length };
}
