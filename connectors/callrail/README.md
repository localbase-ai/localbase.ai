# CallRail connector

Syncs CallRail call tracking into `data/callrail/callrail.db`: every call with
the source, campaign, keyword and landing page that produced it, whether it was
answered, whether it was the caller's first, and how it was scored as a lead.
Stored locally, calls can be joined with ad spend, web traffic and orders — the
question CallRail alone can't answer is *which marketing dollars produced
phone calls that became business*.

## Setup

1. **Create an API key.** In CallRail, open your profile menu → **API Keys** →
   create a key. Keys belong to a user and see what that user sees; it must be
   an **admin** user (lower roles can't use the API). Agency users see every
   client company they manage — see step 3.
2. **Add it to `env.local`:**

   ```bash
   CALLRAIL_API_KEY=...
   CALLRAIL_ACCOUNT_ID=...      # leave blank on the first run to list your accounts
   CALLRAIL_COMPANY_IDS=...     # comma-separated; always required
   # CALLRAIL_HASH_SALT=...     # optional, see Privacy
   ```

   Run the sync once with `CALLRAIL_ACCOUNT_ID` empty and it prints the account
   IDs the key can see, then stops. The account ID is also in the CallRail URL
   (`app.callrail.com/a/<account_id>/…`).
3. **Pick companies.** The sync refuses to run until `CALLRAIL_COMPANY_IDS`
   names the companies that belong to this business, and prints the visible
   ones. This keeps an agency account from copying other clients' calls into
   this workspace, and holds even when the key sees a single company, which can
   still be someone else's. Calls the API returns for any other company are
   dropped.

## Sync

```bash
node connectors/callrail/sync.js                         # incremental
node connectors/callrail/sync.js --full                  # last 2 years
node connectors/callrail/sync.js --full --since 2024-01-01
node connectors/callrail/sync.js --company COM...        # one allowed company
node connectors/callrail/sync.js --no-forms              # skip form submissions
node connectors/callrail/sync.js --verbose
```

Incremental runs re-pull the **last 14 days** before the watermark, because
lead status, value and tags are usually set after the call — when someone
reviews it — and an append-only sync would miss that.

## What gets synced

| Table | Contents |
|---|---|
| `callrail_calls` | One row per call — timing, answered/voicemail, duration, first call, source, campaign, keywords, landing/referring URL, UTMs, gclid/fbclid, lead status, value, note, `caller_hash` |
| `callrail_call_tags` | `(call_id, tag)` — replaced on every re-sync, so removed tags disappear |
| `callrail_calls_daily` | **View** — calls, answered, voicemails, first-time callers, qualified leads (`lead_status = 'good_lead'`), value, by date, source and campaign |
| `callrail_trackers` | Tracking numbers and the source each represents |
| `callrail_form_submissions` | Form tracking, if the account has it (skipped quietly on 403/404) |
| `callrail_companies` | The synced companies and their timezones |
| `sync_state` | Watermark per company and entity |

`call_date` is the date in the offset CallRail reports `start_time` with — the
company's timezone — so a 9pm call is counted on the business's day, not UTC's.

## Privacy

By default **no caller-identifying data is stored**: no caller name, no phone
number, no email (forms), no transcript, no recording URL, no form field
contents. What's kept is attribution and outcome.

One exception: `note`, the free text staff type on a call in CallRail, is
stored as written. It's useful for lead follow-up but can contain a caller's
name or number, so treat `callrail_calls.note` as personal data.

The caller's number becomes `caller_hash`, a salted SHA-256 of its digits. That
is enough to count repeat callers and to join a person's call to their form
submission, without the number sitting in a file anyone with workspace access
can read. The salt is `CALLRAIL_HASH_SALT` if set, otherwise a random one
generated on first run into `data/callrail/salt` (owner-only). Changing or
deleting the salt changes every hash, so repeat-caller counts only hold within
one salt.

The hash is pseudonymous, not anonymous. Phone numbers are a small space and the
salt sits next to the database, so anyone holding both can recover a number by
brute force. Share the database without `data/callrail/salt` if that matters.

`has_recording` records only *whether* a recording exists; open it in CallRail.

## Caveats

- **`lead_status` is only as good as the review.** Unreviewed calls have no
  status, so `qualified_leads` understates recent days until someone scores
  them in CallRail (or an automation rule does).
- **`first_call` is CallRail's own judgement** across the whole account history,
  not just the synced window.
- **Source names are whatever the trackers are named.** Rename a tracker and
  old and new calls carry different `source_name`s; group on `source` for the
  stable type.
- **Deleted calls are not removed locally.** The API returns only calls that
  still exist; nothing marks one that was deleted.
- **Rate limits are hourly and daily.** A full pull of a busy account pages
  through 250 calls a request; the client waits out a 429 using `Retry-After`.

## Tests

```bash
node --test test/callrail.test.js
```

Offline (fetch is mocked). Covers the auth header, both pagination styles,
Retry-After handling, that no caller PII reaches a row, stable phone hashing,
the company allowlist, the trailing re-pull window, tag replacement, and the
daily rollup.
