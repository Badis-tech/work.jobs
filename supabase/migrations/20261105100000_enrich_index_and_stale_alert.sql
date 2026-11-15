-- 1. Jobsuche enrichment selects jobs with a null description ordered by
--    published_at. Without this index that is a sort over the whole jobs table
--    and has hit the statement timeout since 2026-10-28. The partial index
--    only holds the (small) pending backlog and matches the query's order.
create index if not exists jobs_jobsuche_pending_enrich_idx
  on public.jobs (published_at desc nulls last)
  where source = 'jobsuche' and description_html is null;

-- 2. Runs the function was killed in the middle of stay at 'running' forever.
--    ingest-jobs now expires them on each invocation; clear the existing ones.
update public.pipeline_runs
   set status = 'error',
       finished_at = coalesce(finished_at, now()),
       error = 'timed out (run never finished)'
 where status = 'running'
   and started_at < now() - interval '10 minutes';

-- 3. Alert when a source has had no successful run for 12 hours.
create table if not exists public.pipeline_alerts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  source text not null,
  last_success_at timestamptz,
  message text not null
);
alter table public.pipeline_alerts enable row level security; -- service role only

create or replace function public.check_pipeline_staleness()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  stale record;
  fired integer := 0;
  api_key text;
  recipient text;
begin
  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key';
  select decrypted_secret into recipient from vault.decrypted_secrets where name = 'alert_email';

  for stale in
    select source, max(started_at) filter (where status = 'success') as last_success_at
      from pipeline_runs
     where started_at > now() - interval '14 days'
     group by source
    having coalesce(max(started_at) filter (where status = 'success'), '-infinity') < now() - interval '12 hours'
  loop
    -- One alert per source per 12 hours, not one per check.
    if exists (
      select 1 from pipeline_alerts
       where source = stale.source and created_at > now() - interval '12 hours'
    ) then
      continue;
    end if;

    insert into pipeline_alerts (source, last_success_at, message)
    values (
      stale.source,
      stale.last_success_at,
      format('No successful ingest run for %s in over 12 hours (last success: %s)',
             stale.source, coalesce(stale.last_success_at::text, 'never in the last 14 days'))
    );
    fired := fired + 1;

    -- Email via Resend when the secrets exist (created out-of-band, like
    -- 'anon_key'): vault secrets 'resend_api_key' and 'alert_email'.
    if api_key is not null and recipient is not null then
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || api_key
        ),
        body := jsonb_build_object(
          'from', 'Jobs pipeline <onboarding@resend.dev>',
          'to', jsonb_build_array(recipient),
          'subject', 'Jobs pipeline: no success in 12h (' || stale.source || ')',
          'text', 'Source ' || stale.source || ' has had no successful ingest run for over 12 hours.'
        )
      );
    end if;
  end loop;
  return fired;
end;
$$;

revoke all on function public.check_pipeline_staleness() from public, anon, authenticated;

select cron.schedule(
  'check-pipeline-staleness-hourly',
  '41 * * * *',
  $$ select public.check_pipeline_staleness() $$
);
