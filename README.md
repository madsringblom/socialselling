# SocialSelling: validation layer

Read-only social listening. Once a day it pulls recent Reddit and Hacker News posts and comments, keeps the ones that look like someone has a problem one of the products in `products.yaml` solves, has Claude classify them, and writes `reports/YYYY-MM-DD.md`. It never posts, replies or votes.

Pipeline: collect (Reddit, HN) → SQLite (`data/social.db`) → keyword prefilter → optional thread context → Claude scoring (batches of 10) → markdown report + `data/stats.jsonl`.

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

### Reddit app

Reddit blocks unauthenticated JSON, so the collector uses the official OAuth API with an app-only token.

Note (Oct 2026): self-service app creation at prefs/apps no longer works without an approved [Data Access Request](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164), and Reddit has announced the public Data API ends in March 2027. Read the [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy) first; this tool is read-only and intended for personal, non-commercial use.

1. Log in and open https://www.reddit.com/prefs/apps.
2. "create app" (or "create another app").
3. Type: **script**. Name: anything. Redirect URI: `http://localhost:8080` (required by the form, never used).
4. Copy the client id (the string under the app name) into `REDDIT_CLIENT_ID` and the secret into `REDDIT_CLIENT_SECRET`. Set `REDDIT_USERNAME` to your username.

Each run fetches one token (`client_credentials` grant), then calls `oauth.reddit.com` through one sequential queue: at least 1s (+0-300ms jitter) between requests, pausing until the window resets when Reddit reports fewer than 5 requests left (limit is 100/min). 429, 5xx and network errors back off 5s/15s/45s (Retry-After honoured, capped at 60s); a 401 refreshes the token once. Three consecutive failed requests abort the Reddit pass.

Without `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` the run still works: Reddit (and thread context) is skipped, the report notes "reddit skipped: set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env", and HN runs as usual. If the token request fails, Reddit is skipped the same way and the failure is listed under errors.

## Run

```sh
bun run daily                              # full run for today (Europe/Copenhagen date)
bun run report                             # re-render today's report from the DB
bun run report --date 2026-10-28           # re-render another day
```

A run takes a few minutes, mostly from Reddit's 1-second request spacing. `data/run.lock` stops overlapping runs (a lock older than 2h counts as stale).

Re-running is safe:

- Scoring picks up every prefilter-passing item from the last 36h that has no score yet, whichever day it was prefiltered, so items cut by `MAX_SCORED_PER_DAY` or lost to API errors get another chance. Nothing is scored twice. New scores count toward today's report and cap.
- In `daily_stats` (and the report funnel), `fetched` is the latest run's count; `new_items` and `api_cost_usd` add up across the day's runs; `prefiltered`, `scored` and lead counts are recounted from the DB.
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

- `search_phrases`: drive the Reddit/HN searches and give +3 each in the prefilter (max 2 hits). Use phrases people actually write ("feast or famine"), not marketing copy.
- `problems_solved`: each is reduced to its 2-3 most distinctive words; an item containing all of them gets +2. Short, concrete wording works best. All of it also goes into the Claude prompt.
- `not_for`: a keyword hit gives -2, and Claude treats matches as non-leads.
- `subreddits` (no `r/`): scanned for new posts and comments, and searched with the phrases. The report's "Top subreddits for leads today" section shows where leads come from, so add or drop subs based on that.
- `non_english_subreddits` (default `[]`, e.g. `[Denmark]`): the only places non-English items are kept (Claude flags them `non-English`); non-English items anywhere else are dropped. These subs skip the phrase search, since the phrases are English, but their new posts and comments are still collected.
- Edits take effect on the next run. Changing product text changes the cached system prompt, so the first batch after a change pays the cache write once.

Pass rule: the score is intent (+2) + `?` in a post title (+1) + `Ask HN` (+1) + the best single product's phrase/problem/not_for score. An item with a product hit (best > 0) passes at score 2 or more. An item with no product hit passes only if it comes from one of a product's `subreddits` and matches the intent regex ("is there a", "looking for a", "recommendations", …). HN items and site-wide search results from other subreddits always need a product hit; `?` and `Ask HN` add to the score but never pass an item on their own.

Prefilter decisions and reasons are in the `prefilter` table, so you can see why something was dropped:

```sh
sqlite3 data/social.db "select case when reason like 'score%' then 'passed=' || passed else reason end as r, count(*)
  from prefilter where run_date = '2026-10-29' group by r order by 2 desc"
```
