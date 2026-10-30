# Meta connector (Facebook + Instagram)

Syncs three things into `data/meta/meta.db`:

- **Ads**: daily performance at campaign, ad set and ad level, every action
  type, and the campaigns, ad sets and ads themselves.
- **Facebook Page**: daily Page metrics, posts, and lifetime post insights.
- **Instagram**: daily account metrics, the media list, and lifetime insights
  per post or reel.

With it, ad spend and organic reach can be joined locally with calls, web
traffic and orders.

**Read-only.** The connector asks for no write permission and never creates,
edits or pauses anything.

## Setup

### 1. A System User token

A System User belongs to your Business, not to a person. Its token doesn't
expire, and it keeps working when someone leaves.

1. **Business Settings → Users → System users → Add.** Give it the *Employee*
   role.
2. **Assign assets** to it (*Add assets*): the ad account(s), the Facebook
   Page(s) and the Instagram account(s) to sync. View/analyze access is enough.
   Don't grant manage access.
3. **Apps**: the System User needs an app to generate a token from. Create one
   at [developers.facebook.com](https://developers.facebook.com/apps) (type
   *Business*) owned by the same Business, and add it under *Business Settings →
   Accounts → Apps*.
4. **Generate new token** on the System User, choose the app, set expiry to
   *Never*, and tick only these permissions:

   | Permission | For |
   |---|---|
   | `ads_read` | ad insights and ad objects |
   | `read_insights` | Page insights |
   | `pages_show_list` | listing Pages |
   | `pages_read_engagement` | Page posts, and minting the Page token |
   | `instagram_basic` | Instagram profile and media |
   | `instagram_manage_insights` | Instagram insights (read-only, despite the name) |

   Do **not** add `ads_management`, `pages_manage_*`, `instagram_content_publish` or
   `business_management` (it can manage Business assets, and the connector only reads
   assets already assigned to the System User).

Page and Instagram insights are read with the **Page's** token. The connector
gets one from the System User token at run time and keeps it in memory only.

### 2. `env.local`

```bash
META_ACCESS_TOKEN=...                 # the System User token
META_AD_ACCOUNT_IDS=1234567890        # comma-separated; "act_" prefix optional
META_PAGE_IDS=1234567890              # comma-separated
# META_IG_USER_IDS=1784...            # optional; defaults to each Page's linked Instagram account
# META_APP_SECRET=...                 # optional; adds appsecret_proof (required if the app enforces it)
# META_API_VERSION=v23.0              # optional; overrides the pinned version
```

**Allowlists are required.** A token, especially an agency's System User
token, often reaches other businesses' ad accounts and Pages. With no
allowlist, the sync stops and prints every ad account and Page the token can
see, so you can choose. Allowlisted IDs the token can't see are reported.

### 3. Sync

```bash
node connectors/meta/sync.js --full                     # ads: 37 months; organic: 2 years
node connectors/meta/sync.js                            # incremental
node connectors/meta/sync.js --reports ads              # or page, instagram, comma-separated
node connectors/meta/sync.js --account 1234567890       # one ad account
node connectors/meta/sync.js --verbose                  # usage headers, async job progress
```

## What gets synced

| Table | Grain |
|---|---|
| `meta_campaign_daily`, `meta_adset_daily`, `meta_ad_daily` | spend, impressions, reach, clicks, CTR/CPC/CPM, frequency + headline actions, per object per day |
| `meta_actions_daily` | every action type: count, value, cost per action; per object per day |
| `meta_campaigns`, `meta_adsets`, `meta_ads`, `meta_ad_accounts` | names, status, objective, optimisation goal, budgets |
| `meta_page_daily` | Page metric per day (`metric`, `value`, `detail`) |
| `meta_page_posts`, `meta_post_insights` | posts (message excerpt only) and lifetime metrics per post |
| `meta_ig_daily` | Instagram account metric per day |
| `meta_ig_media`, `meta_ig_media_insights` | posts/reels (caption excerpt only) and lifetime metrics per item |
| `meta_metric_errors` | metrics Meta rejected, and why |
| `sync_state` | watermark per object and report |

**The three ads tables hold the same spend at different levels.** Query one;
never sum across them.

**Headline actions** copied onto the daily rows as columns: `leads` (`lead`),
`pixel_leads` (`offsite_conversion.fb_pixel_lead`), `link_click_actions`,
`messaging_starts` (`onsite_conversion.messaging_conversation_started_7d`),
`calls_placed` (`click_to_call_native_call_placed`), `calls_confirmed`
(`click_to_call_call_confirm`) and `video_views` (`video_view`, 3-second). The
two call columns are different steps of the same call and are not summed.
Every other action type is in `meta_actions_daily`.

**Budgets are stored in the currency's minor unit** (`daily_budget_minor`:
cents for USD). Dividing by 100 is wrong for zero-decimal currencies, so the
query does that, knowing the currency (`meta_ad_accounts.currency`).

**Post text is truncated** to 280 characters. The connector stores no comments,
commenter names or audience demographics.

## How it behaves

**Restatement.** Meta keeps revising recent days as delayed conversions are
attributed. Incremental runs re-pull the last **28 days** behind the
watermark and upsert over them.

**Long windows use async jobs.** A window over 90 days (a `--full` run) goes
through an async insights report job, one year at a time. A synchronous daily
ad-level request over years times out.

**Retired metrics are skipped, not fatal.** Meta retired much of the Page and
Instagram insights catalogue in 2025: the `page_impressions` family and
Instagram `impressions`/`plays` gave way to *views* metrics. The connector asks
for its metric list in one call. If Meta rejects the set, it asks for each
metric alone, records the rejected ones in `meta_metric_errors`, and carries
on. Override the lists without code changes:

```bash
META_PAGE_METRICS=page_media_view,page_post_engagements,page_follows
META_POST_METRICS=post_media_view,post_clicks
META_IG_METRICS=reach:time_series,follower_count:time_series,views:total_value
META_IG_MEDIA_METRICS=reach,views,saved,shares,total_interactions
```

Most Instagram account metrics now come only as `metric_type=total_value`
(one number per window), so those are requested **one day at a time**. That's
one call per day per run, cheap incrementally and slower on `--full`.

**Rate limits.** Meta reports usage in response headers (`X-App-Usage`,
`X-Business-Use-Case-Usage`, `X-Ad-Account-Usage`). The client reads them on
every call and starts pacing itself above 75%. Throttling errors (codes 4,
17, 32, 613, 80000-series) are retried with backoff, or after the regain time
Meta states. Auth errors (190) fail immediately.

## Caveats

- **Attribution.** Actions use the ad account's default attribution setting
  (commonly 7-day click / 1-day view), recorded per row in
  `attribution_setting` where Meta returns it. Numbers won't match a report in
  Ads Manager set to a different window.
- **iOS and modelled conversions.** Since Apple's App Tracking Transparency,
  part of the conversion count is modelled, not observed. Treat small
  day-level differences as noise.
- **Reach doesn't add up.** Reach is unique people per row; summing daily
  reach overcounts people who saw ads on several days.
- **Retention.** Insights go back 37 months. Instagram account insights go
  back about 2 years, and `follower_count` only 30 days. A database built from
  a daily sync is the only longer history.
- **Page insights need a Page with enough activity.** Small Pages return empty
  or partial series for some metrics. That's not a sync failure.

## Tests

```bash
node --test test/meta.test.js
```

Offline. Covers ad row mapping (spend, headline actions, no ad set columns on
campaign rows), action merging, upsert over a restated day, end-time-to-date
conversion, object-valued metrics, the retired-metric fallback, throttling
header parsing, retry classification, paging without a duplicate token,
appsecret_proof, the async job flow, and allowlist resolution.
