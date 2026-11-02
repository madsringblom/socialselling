import type { Config } from "../config.ts";
import { errMsg } from "../strategies/shared.ts";
import * as drafts from "./drafts.ts";
import * as entities from "./entities.ts";
import * as intel from "./intel.ts";
import * as research from "./research.ts";

export type PlayCtx = { cfg: Config; now: number; runDate: string; log: (m: string) => void };
export type PlayResult = { count: number; costUsd: number; errors: string[]; notes: string[] };
export type PlaysSummary = {
  drafts: number;
  researched: number;
  ideas: number;
  costUsd: number;
  errors: string[];
  notes: string[];
};

type Counter = "drafts" | "researched" | "ideas" | null;

/** Runs drafts → entities → research → intel. A failing play is recorded as an error and the rest still run. */
export async function runPlays(ctx: PlayCtx): Promise<PlaysSummary> {
  const s: PlaysSummary = { drafts: 0, researched: 0, ideas: 0, costUsd: 0, errors: [], notes: [] };
  const steps: [string, () => Promise<PlayResult>, Counter][] = [
    ["drafts", () => drafts.run(ctx), "drafts"],
    ["entities", () => entities.run(ctx), null],
    ["research", () => research.run(ctx), "researched"],
    ["intel", () => intel.run(ctx), "ideas"],
  ];
  for (const [name, fn, counter] of steps) {
    try {
      const r = await fn();
      s.costUsd += r.costUsd;
      s.errors.push(...r.errors.map((e) => `${name}: ${e}`));
      s.notes.push(...r.notes);
      if (counter) s[counter] += r.count;
    } catch (e) {
      s.errors.push(`${name} play failed: ${errMsg(e)}`);
    }
  }
  return s;
}

export function playsNote(s: PlaysSummary): string {
  return `plays: drafts ${s.drafts} · researched ${s.researched} · ideas ${s.ideas} · cost $${s.costUsd.toFixed(4)}`;
}
