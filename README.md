# work.jobs

Supabase-native jobs ETL with a Next.js frontend. (Formerly `jobs-pipe-line`; the GitHub repo and Vercel project still carry that name.)

- **Pipeline** — the `ingest-jobs` Edge Function (`supabase/functions/ingest-jobs/`) pulls from the sources below into a normalized `jobs` table, with per-run logging in `pipeline_runs`. Scheduled every 6 hours via pg_cron; do not tighten that schedule (Remotive's terms ask for ~4 calls/day). A second cron calls `?mode=enrich` every 10 minutes to fill in Jobsuche descriptions (300 per call), which need one detail request per job — doing that inside the ingest run exceeds the function's compute limit.
- **Web** — Next.js app in `web/`, live at [jobs-pipe-line.vercel.app](https://jobs-pipe-line.vercel.app). Pushes to `main` deploy automatically via the Vercel git integration (project root directory: `web`).
- **Setup & deployment** — see [SETUP_AND_DEPLOYMENT.md](SETUP_AND_DEPLOYMENT.md).

## Sources

| Source | Key | Notes |
|---|---|---|
| Bundesagentur für Arbeit Jobsuche | none | Ausbildung + Arbeit. List from `v6/jobs`, descriptions from `v4/jobdetails` |
| Arbeitnow | none | |
| Remotive | none | ~4 calls/day max |
| Jobicy | none | Must be credited and linked |
| Remote OK | none | Must be named as source and linked |
| Himalayas | none | 100 newest per run (cursor pagination) |
| Working Nomads | none | |
| Landing.jobs | none | European tech jobs |
| Adzuna, Jooble, USAJOBS | required | Dormant until their secrets are set — see [SEARCH_APIS_SETUP.md](SEARCH_APIS_SETUP.md) |

Job data is credited to and links back to its original source.

## Operations

- The function budgets itself to 110 s per invocation. Sources fetch concurrently, so one slow or broken source cannot block the others.
- Listings not seen for 30 days are deleted daily (`prune-stale-jobs-daily`).
- `check_pipeline_staleness()` runs hourly and records an alert in `pipeline_alerts` when a source has had no successful run for 12 hours.
- Test one source: `curl "<project-url>/functions/v1/ingest-jobs?source=himalayas" -H "Authorization: Bearer <anon key>"`.
