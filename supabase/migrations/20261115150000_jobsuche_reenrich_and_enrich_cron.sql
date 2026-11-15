-- 1. Jobsuche descriptions were blanked: the v3 jobdetails endpoint started
--    answering 403 for every job and ingest-jobs stored that as '' ("delisted").
--    ingest-jobs now reads v4 and only treats 404 as delisted. Put the blanked
--    rows back in the enrichment queue (null = pending).
update public.jobs
   set description_html = null
 where source = 'jobsuche'
   and description_html = '';

-- 2. Runs killed mid-enrichment by the function's wall-clock limit.
update public.pipeline_runs
   set status = 'error',
       finished_at = coalesce(finished_at, now()),
       error = 'timed out (run never finished)'
 where status = 'running'
   and started_at < now() - interval '10 minutes';

-- 3. Enrichment runs in its own small invocations every 10 minutes (300 jobs
--    each): doing it inside the ingest run exceeded the function's compute
--    limit and killed the run. Enrichment
--    only talks to the Bundesagentur detail endpoint, so this does not add
--    calls to the rate-limited sources (Remotive etc.).
select cron.schedule(
  'enrich-jobs-every-10m',
  '5-55/10 * * * *',
  $$
  select net.http_post(
    url := 'https://qhcqecodncwrpnlhullo.supabase.co/functions/v1/ingest-jobs?mode=enrich',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
