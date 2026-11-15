-- 1. raw_jobs was a second copy of every job (full API payload) that nothing
--    read. ingest-jobs no longer writes it (edge function v7).
drop table if exists public.raw_jobs;

-- 2. Remove the CV tool (cv_documents, cv_usage quota + RPCs).
drop function if exists public.consume_cv_quota(text);
drop function if exists public.refund_cv_quota(text);
drop table if exists public.cv_documents;
drop table if exists public.cv_usage;

-- 3. Retention: listings not seen by any ingest run for 30 days are gone from
--    their source, so delete them. Runs daily at 03:17 UTC.
create index if not exists jobs_last_seen_at_idx on public.jobs (last_seen_at);

select cron.schedule(
  'prune-stale-jobs-daily',
  '17 3 * * *',
  $$ delete from public.jobs where last_seen_at < now() - interval '30 days' $$
);

-- Keep pg_cron's own run log from growing forever too.
select cron.schedule(
  'prune-cron-history-weekly',
  '23 4 * * 0',
  $$ delete from cron.job_run_details where end_time < now() - interval '14 days' $$
);
