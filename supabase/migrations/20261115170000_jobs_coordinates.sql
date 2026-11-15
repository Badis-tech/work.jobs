-- Workplace coordinates so jobs can be drawn on a map (quest-os JOBS layer).
-- Filled by ingest-jobs from the Bundesagentur Jobsuche API, which returns
-- breite/laenge per workplace; other sources leave them null.
alter table public.jobs
  add column if not exists lat double precision,
  add column if not exists lng double precision;

-- Map viewport queries: lat/lng range, newest first.
create index if not exists jobs_geo_idx
  on public.jobs (lat, lng)
  where lat is not null;

-- Jobs enriched before coordinates existed: put them back in the enrichment
-- queue once (newest first, ~1,800/hour) so the detail call can add them.
update public.jobs
   set description_html = null
 where source = 'jobsuche'
   and description_html <> ''
   and lat is null;
