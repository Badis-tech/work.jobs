# Search APIs Setup Guide

The `ingest-jobs` Edge Function pulls from two kinds of sources:

- **Keyless sources** (always active, nothing to configure): Bundesagentur für Arbeit Jobsuche, Arbeitnow, Remotive, Jobicy, Remote OK, Himalayas, Working Nomads, Landing.jobs.
- **Key-based sources** (coded but dormant until you set their secrets): **Adzuna**, **Jooble**, **USAJOBS**.

A key-based source whose required environment variables are missing is simply reported as `"skipped"` in the function response — nothing breaks. This guide covers getting the keys and turning each source on.

---

## Table of Contents

1. [How activation works](#how-activation-works)
2. [Adzuna](#adzuna)
3. [Jooble](#jooble)
4. [USAJOBS](#usajobs)
5. [Setting the secrets](#setting-the-secrets)
6. [Testing a single source](#testing-a-single-source)
7. [Verifying results](#verifying-results)
8. [Environment variable reference](#environment-variable-reference)

---

## How activation works

Each key-based source declares `requiredEnv` in `supabase/functions/ingest-jobs/index.ts`. On every run the function checks those variables:

- **All present** → the source fetches, writes to `jobs`, and logs a `pipeline_runs` row.
- **Any missing** → the source returns `status: "skipped"` in the HTTP response and writes **no** `pipeline_runs` row.

So activation is purely a matter of setting Edge Function secrets — no code change, no redeploy needed (secrets are injected on the next invocation).

---

## Adzuna

Aggregator covering many countries. Free tier: **25 requests/min, 250 requests/day**. The pipeline's usage (country list × 2 pages × 4 runs/day) stays well inside that with the default 3 countries.

### Get the keys

1. Register at <https://developer.adzuna.com/> (free).
2. After signing up, open your dashboard — you get an **Application ID** and an **Application Key**.

### Variables

| Variable | Required | Meaning |
|---|---|---|
| `ADZUNA_APP_ID` | ✅ | Application ID from the dashboard |
| `ADZUNA_APP_KEY` | ✅ | Application Key from the dashboard |
| `ADZUNA_COUNTRIES` | optional | Comma-separated country codes, default `de,gb,us` |

Notes:

- Country codes must be markets Adzuna supports (e.g. `de`, `gb`, `us`, `fr`, `nl`, `at`, ...). Each country costs 2 API calls per run — keep the list short enough to stay under 250 calls/day at 4 runs/day.
- Adzuna job IDs are only unique per market, so the pipeline stores `external_id` as `{country}:{id}` (e.g. `de:4321…`). Expect that prefix when querying.

---

## Jooble

Aggregator with a simple POST API: <https://jooble.org/api/about>.

### Get the key

1. Go to <https://jooble.org/api/about> and request API access (free; they email you a key, sometimes after a short manual review).
2. The key is used directly in the URL path (`https://jooble.org/api/<key>`), so treat it as a secret.

### Variables

| Variable | Required | Meaning |
|---|---|---|
| `JOOBLE_API_KEY` | ✅ | Your Jooble API key |
| `JOOBLE_KEYWORDS` | optional | Search keywords (default: empty = broad results) |
| `JOOBLE_LOCATION` | optional | Location filter (default: empty) |

Notes:

- The pipeline fetches up to 3 pages per run and de-duplicates job IDs within a run.
- If you care about a niche (e.g. `JOOBLE_KEYWORDS=ausbildung`, `JOOBLE_LOCATION=Deutschland`), set the optional variables — otherwise you get generic top results.

---

## USAJOBS

US federal government jobs: <https://developer.usajobs.gov/>.

### Get the key

1. Request an API key at <https://developer.usajobs.gov/apirequest/> — you register with your **email address**.
2. The key arrives by email.

### Variables

| Variable | Required | Meaning |
|---|---|---|
| `USAJOBS_API_KEY` | ✅ | The key from the registration email |
| `USAJOBS_EMAIL` | ✅ | **The exact email address you registered with** |

⚠️ **Important:** USAJOBS requires the `User-Agent` header to be the registration email — that's what `USAJOBS_EMAIL` is for. If it doesn't match the email tied to the key, requests are rejected.

The pipeline fetches the 250 most recently posted positions per run.

---

## Setting the secrets

Set the variables as **Edge Function secrets** (not in `web/.env.local` — the frontend never talks to these APIs).

### Option A — Supabase Dashboard

1. Open the project dashboard → **Edge Functions** → **Secrets**.
2. Add each variable name/value and save.

### Option B — Supabase CLI

From the repo root (project ref `qhcqecodncwrpnlhullo`):

```bash
npx supabase secrets set ADZUNA_APP_ID=xxxx ADZUNA_APP_KEY=xxxx
npx supabase secrets set JOOBLE_API_KEY=xxxx
npx supabase secrets set USAJOBS_API_KEY=xxxx USAJOBS_EMAIL=you@example.com
```

Verify what's set (values are not shown, only names/digests):

```bash
npx supabase secrets list
```

No redeploy is needed — the next function invocation picks the secrets up.

---

## Testing a single source

The function accepts a `?source=<name>` query parameter, so you can test one source without hammering the others (Remotive in particular should stay at ~4 calls/day per their terms).

```bash
curl -s "https://qhcqecodncwrpnlhullo.supabase.co/functions/v1/ingest-jobs?source=adzuna" \
  -H "Authorization: Bearer <anon key>"
```

Valid source names: `remotive`, `arbeitnow`, `jobsuche`, `jobicy`, `remoteok`, `himalayas`, `workingnomads`, `landingjobs`, `adzuna`, `jooble`, `usajobs`.

The Muse was removed in November 2026: its public API now returns 404.

Expected responses:

- Secrets set correctly → `"status": "ok"` with fetched/inserted counts.
- Secrets missing → `"status": "skipped"` listing the missing variable names.
- Wrong key → `"status": "error"` with an HTTP status from the upstream API (e.g. `adzuna HTTP 401`).

---

## Verifying results

After a successful test (or the next scheduled 6-hourly run), check the logging table:

```sql
select source, status, jobs_fetched, jobs_upserted, error, started_at
from pipeline_runs
order by started_at desc
limit 20;
```

And confirm rows landed:

```sql
select source, count(*) from jobs group by source order by 2 desc;
```

Remember: skipped sources write **no** `pipeline_runs` row, so absence of a row for e.g. `jooble` means its secrets aren't set — not that it failed.

---

## Environment variable reference

| Variable | Source | Required to activate | Default |
|---|---|---|---|
| `ADZUNA_APP_ID` | Adzuna | ✅ | — |
| `ADZUNA_APP_KEY` | Adzuna | ✅ | — |
| `ADZUNA_COUNTRIES` | Adzuna | — | `de,gb,us` |
| `JOOBLE_API_KEY` | Jooble | ✅ | — |
| `JOOBLE_KEYWORDS` | Jooble | — | (empty) |
| `JOOBLE_LOCATION` | Jooble | — | (empty) |
| `USAJOBS_API_KEY` | USAJOBS | ✅ | — |
| `USAJOBS_EMAIL` | USAJOBS | ✅ | — |
