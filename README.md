# SocialSelling: validation layer

Read-only social listening. Once a day it pulls recent items from five sources (Reddit, Hacker News and Bluesky posts and comments, App Store reviews of competitor apps, and news/feed articles), keeps the ones that look like someone has a problem one of the products in `products.yaml` solves (or that say something useful about a competitor), has Claude classify them, and writes `reports/YYYY-MM-DD.md`. It never posts, replies or votes.

Pipeline: collect (Reddit, HN, Bluesky, App Store, Bing News/RSS; each source is a strategy in `src/strategies/`) → SQLite (`data/social.db`) → keyword prefilter → optional thread context → Claude scoring (batches of 10) → markdown report + `data/stats.jsonl`.

## Setup

```sh
bun install
cp .env.example .env                  # then set ANTHROPIC_API_KEY and the three REDDIT_* keys
cp products.example.yaml products.yaml  # describe your products (git-ignored)
```

| Env | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | cost math assumes Haiku 5.5 prices |
| `REDDIT_CLIENT_ID` | (none) | Reddit app client id; without it Reddit is skipped |
| `REDDIT_CLIENT_SECRET` | (none) | Reddit app secret; without it Reddit is skipped |
| `REDDIT_USERNAME` | `anonymous` | your Reddit username, goes into the User-Agent |
| `FETCH_THREAD_CONTEXT` | `true` | fetch top 3 replies for up to 40 candidate posts |
| `MAX_SCORED_PER_DAY` | `400` | hard cap on items sent to Claude per day |

## Sources

A source whose config is missing is skipped with a one-line note in the report (for example "appstore skipped: no competitors[].app_store in products.yaml"); the other sources run as usual. The report's notes also list how many items each source fetched. App Store, Bluesky and RSS requests share one polite fetcher: at least 1s between requests to the same host, 20s timeout, no retries.

### Reddit

Reddit blocks unauthenticated JSON, so the collector uses the official OAuth API with an app-only token.

Note (Oct 2026): self-service app creation at prefs/apps no longer works without an approved [Data Access Request](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164), and Reddit has announced the public Data API ends in March 2027. Read the [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy) first; this tool is read-only and intended for personal, non-commercial use.

1. Log in and open https://www.reddit.com/prefs/apps.
2. "create app" (or "create another app").
3. Type: **script**. Name: anything. Redirect URI: `http://localhost:8080` (required by the form, never used).
4. Copy the client id (the string under the app name) into `REDDIT_CLIENT_ID` and the secret into `REDDIT_CLIENT_SECRET`. Set `REDDIT_USERNAME` to your username.

Each run fetches one token (`client_credentials` grant), then calls `oauth.reddit.com` through one sequential queue: at least 1s (+0-300ms jitter) between requests, pausing until the window resets when Reddit reports fewer than 5 requests left (limit is 100/min). 429, 5xx and network errors back off 5s/15s/45s (Retry-After honoured, capped at 60s); a 401 refreshes the token once. Three consecutive failed requests abort the Reddit pass.

Without `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` the run still works: Reddit (and thread context) is skipped, the report notes "reddit skipped: set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env", and HN runs as usual. If the token request fails, Reddit is skipped the same way and the failure is listed under errors.

### Hacker News

The public Algolia HN search API, no key needed: up to 20 `search_phrases` (round-robin across products) plus the latest Ask HN posts, stories and comments from the last 36h.

### Bluesky

The public AT Protocol AppView at `api.bsky.app` (`app.bsky.feed.searchPosts`), no key or account needed: up to 20 `search_phrases` (round-robin across products) plus up to 20 `bluesky.danish_phrases` searched with `lang=da`. Each phrase fetches the 50 latest posts (`sort=latest`) from the last 36h (one page of 50 per phrase, no pagination), at 1 request/s. Replies are kept only when the phrase itself appears in the reply; posts from the top-level `bluesky.own_handles` are skipped. `public.api.bsky.app` returns 403 for search, which is why `api.bsky.app` is used. Set `bluesky.enabled: false` on a product to leave its phrases out, or `bluesky.enabled: false` at the top level to turn the source off.

### App Store reviews

For every `competitors[].app_store` entry, the unauthenticated Apple customer-reviews RSS (JSON) is read per storefront in `countries`: 2 pages × 50 most recent reviews, within a 30-day window. The first run backfills 30 days; later runs only add new review ids. The first run may spend a large share of the day's scoring cap (MAX_SCORED_PER_DAY) on the 30-day backfill. Every review of a configured competitor passes the prefilter and is scored, so the report shows what users of that app complain about or value. The feed has no per-review URL, so links go to the app's review page. `google_play` is accepted in the config but not collected (there is no official feed). Trustpilot is deliberately excluded: its robots.txt disallows crawling and it returns 403.

### News & feeds

Each `news_queries` entry is searched with Bing News RSS (`setlang=da&cc=dk`, so Danish results). Google News RSS is not used because it geo-redirects. The top-level `feeds` list takes any RSS 2.0 or Atom URL, for example a Google Alert with delivery set to "RSS feed". Caps: 20 queries and 20 feeds per run; only articles from the last 7 days are kept. Bing's click-tracking links are unwrapped to the publisher URL.

#### Google Alerts as feeds

Google Alerts index Danish forums, local news and public Facebook pages far better than Bing News, and each alert can be delivered as an RSS feed. Alerts must be created in your own Google account; the tool only reads the resulting feed URL.

1. Open https://www.google.com/alerts while logged in.
2. Type a query. Open "Show options" and set: How often → As-it-happens; Sources → Automatic; Language → Danish (or English); Region → Denmark; How many → All results; Deliver to → **RSS feed**.
3. Create the alert, then click the RSS icon next to it and copy the URL (`https://www.google.com/alerts/feeds/<account>/<alert>`).
4. Add it under `feeds` in `products.yaml` with `lang: da` for Danish alerts and `products: [<id>]` so the prefilter maps it to the right product.

One alert per phrase works best; quoted phrases cut noise. Titles arrive with `<b>` highlighting, which the parser strips.

## Run

```sh
bun run daily                              # full run for today (Europe/Copenhagen date)
bun run report                             # re-render today's report from the DB
bun run report --date 2026-10-28           # re-render another day
```

A run takes a few minutes, mostly from Reddit's 1-second request spacing (sources are collected in parallel). `data/run.lock` stops overlapping runs (a lock older than 2h counts as stale).

Re-running is safe:

- Scoring picks up every prefilter-passing item that has no score yet (posts and comments from the last 36h, reviews and articles from the last 30 days), whichever day it was prefiltered, so items cut by `MAX_SCORED_PER_DAY` or lost to API errors get another chance. Nothing is scored twice. New scores count toward today's report and cap.
- In `daily_stats` (and the report funnel), `fetched` is the latest run's count of everything the sources returned, including already-known reviews, so it exceeds `new_items`; `new_items` and `api_cost_usd` add up across the day's runs; `prefiltered`, `scored` and lead counts are recounted from the DB.
- `data/stats.jsonl` is regenerated from `daily_stats` at the end of every run and on `bun run report`: one line per run date, oldest first, no duplicates.

## Schedule (launchd, daily 07:00)

Edit the `/Users/YOUR_USER/...` paths in `launchd/com.socialselling.daily.plist` first (launchd needs absolute paths), then:

```sh
mkdir -p data
cp launchd/com.socialselling.daily.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.socialselling.daily.plist
launchctl kickstart -k gui/$(id -u)/com.socialselling.daily   # optional: run once now
tail -f data/launchd.log
```

Unload with `launchctl bootout gui/$(id -u)/com.socialselling.daily`. The 07:00 trigger uses the Mac's system time zone; `TZ` in the plist only affects the run date and report times. If bun isn't at `~/.bun/bin/bun`, edit the plist.

## Tuning `products.yaml`

- `search_phrases`: drive the Reddit/HN/Bluesky searches and give +3 each in the prefilter (max 2 hits). Use phrases people actually write ("feast or famine"), not marketing copy.
- `problems_solved`: each is reduced to its 2-3 most distinctive words; an item containing all of them gets +2. Short, concrete wording works best. All of it also goes into the Claude prompt.
- `not_for`: a keyword hit gives -2, and Claude treats matches as non-leads.
- `subreddits` (no `r/`): scanned for new posts and comments, and searched with the phrases. The report's "Top channels for leads today" section shows where leads come from, so add or drop subs based on that.
- `non_english_subreddits` (default `[]`, e.g. `[Denmark]`): the only subreddits where non-English items are kept (Claude flags them `non-English`); non-English posts and comments anywhere else are dropped. These subs skip the phrase search, since the phrases are English, but their new posts and comments are still collected.
- `competitors` (default `[]`): `name` plus optional `app_store: { id, countries }` (id is the number in the apps.apple.com URL, countries are two-letter storefront codes, default `[dk]`) and optional `google_play` (accepted, not collected). Reviews of a competitor are hinted to the product that lists it.
- `news_queries` (default `[]`): Bing News searches. Short brand or topic terms work best ("Holdsport", "foreningsapp"). All Bing queries allow Danish (non-English) results.
- `feeds` (top level, default `[]`): `name`, `url`, optional `products` (product ids the feed belongs to, default all) and optional `lang` (default `en`; anything else keeps non-English entries).
- `bluesky` (per product, optional): `enabled` (default `true`; `false` leaves the product's phrases out of the Bluesky search) and `danish_phrases` (default `[]`): searched with `lang=da`, Bluesky posts found by them may be non-English, and they also count as phrases in the prefilter (+3 each, like `search_phrases`).
- `bluesky` (top level, optional): `enabled` (default `true`; `false` turns the source off) and `own_handles` (default `[]`): your own Bluesky handles (e.g. `me.bsky.social`, a leading `@` is fine); their posts are skipped.
- Edits take effect on the next run. Changing product text changes the cached system prompt, so the first batch after a change pays the cache write once.

Pass rule: the score is intent (+2) + `?` in a post title (+1) + `Ask HN` (+1) + the best single product's phrase/problem/not_for score. An item with a product hit (best > 0) passes at score 2 or more. An item with no product hit passes only if it comes from one of a product's `subreddits` and matches the intent regex ("is there a", "looking for a", "recommendations", …). Bluesky posts found via one of a product's phrases count as being in that product's channel, so intent alone passes them. HN items and site-wide search results from other subreddits always need a product hit; `?` and `Ask HN` add to the score but never pass an item on their own.

Reviews always pass (if their competitor is in some product's `competitors`): the hint is that product, with score 3 for 3 stars or fewer and 2 otherwise. Articles follow the same rule as posts: they need a phrase/problem hit, or intent plus a channel (news query or feed) mapped to a product. Age windows: 36h for posts and comments, 30 days for reviews and articles. Minimum lengths: 80 characters for posts, 120 for comments, 20 for reviews, 40 for articles.

## Report

`reports/YYYY-MM-DD.md` starts with the funnel, tier and product counts and a "By kind" line (non-irrelevant items split into social, reviews and articles), then the week-to-date table. The `asking_for_tool`, `describing_problem` and `passing_mention` sections only list Reddit/HN/Bluesky items. Two extra sections:

- **Competitor reviews** (shown when any product has `competitors`): one group per competitor with star rating, storefront, tier, product, confidence, a body excerpt and Claude's one-line insight (feature gap, switching reason); irrelevant reviews that still carry an insight are listed as one line each, the rest are only counted.
- **News & feeds** (shown when any `news_queries` or `feeds` are configured): headline, publication, query or feed, tier and insight; irrelevant articles that still carry an insight are listed as one line each, the rest are only counted.

Review and article tiers count toward the tier totals and the week table, just like social items. "Top channels for leads today" covers every source.

Prefilter decisions and reasons are in the `prefilter` table, so you can see why something was dropped:

```sh
sqlite3 data/social.db "select case when reason like 'score%' then 'passed=' || passed else reason end as r, count(*)
  from prefilter where run_date = '2026-10-29' group by r order by 2 desc"
```
