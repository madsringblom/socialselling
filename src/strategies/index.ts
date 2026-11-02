import { appstore } from "./appstore.ts";
import { bluesky } from "./bluesky.ts";
import { hn } from "./hn.ts";
import { reddit } from "./reddit.ts";
import { rss } from "./rss.ts";
import type { Strategy } from "./shared.ts";

export const STRATEGIES: Strategy[] = [reddit, hn, bluesky, appstore, rss];
export { fetchThreadContext } from "./reddit.ts";
export type { CollectResult } from "./shared.ts";
