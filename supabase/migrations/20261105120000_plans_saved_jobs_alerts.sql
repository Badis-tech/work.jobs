-- Plan tiers, saved jobs and job alerts.
-- Limits live in `plans` and are enforced by triggers, so the client can never
-- exceed them. The tier itself is still written only by the Lemon Squeezy
-- webhook (service role), same as before.

create table if not exists public.plans (
  id text primary key,
  name text not null,
  rank integer not null unique,
  unlimited_browsing boolean not null,
  saved_jobs_limit integer,          -- null = unlimited
  alerts_limit integer not null
);

insert into public.plans (id, name, rank, unlimited_browsing, saved_jobs_limit, alerts_limit) values
  ('free', 'Free', 0, false, 10,   0),
  ('plus', 'Plus', 1, true,  100,  1),
  ('pro',  'Pro',  2, true,  null, 10)
on conflict (id) do nothing;

alter table public.plans enable row level security;
create policy "plans are publicly readable"
  on public.plans for select to anon, authenticated using (true);

-- Existing paid rows are the original EUR 4.99 tier, i.e. 'plus'.
alter table public.subscriptions
  add column if not exists plan text not null default 'plus' references public.plans (id);

-- Plan of an arbitrary user. Internal only (used by the limit triggers).
create or replace function public.plan_of(uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select s.plan
       from public.subscriptions s
      where s.user_id = uid
        and (
          s.status in ('active','on_trial')
          or (s.status = 'cancelled' and coalesce(s.ends_at, 'infinity'::timestamptz) > now())
        )),
    'free'
  );
$$;
revoke execute on function public.plan_of(uuid) from public, anon, authenticated;

-- The caller's own plan.
create or replace function public.current_plan()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public.plan_of(auth.uid());
$$;
revoke execute on function public.current_plan() from public;
grant execute on function public.current_plan() to authenticated;

-- Browsing entitlement now derives from the plan (unchanged behaviour for
-- existing callers: true for any paid, unexpired subscription).
create or replace function public.has_active_sub()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.plans p
     where p.id = public.plan_of(auth.uid())
       and p.unlimited_browsing
  );
$$;

-- Saved jobs -----------------------------------------------------------------
create table public.saved_jobs (
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id bigint not null references public.jobs (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, job_id)
);
alter table public.saved_jobs enable row level security;

create policy "read own saved jobs"
  on public.saved_jobs for select to authenticated
  using (user_id = (select auth.uid()));
create policy "save jobs as self"
  on public.saved_jobs for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "unsave own jobs"
  on public.saved_jobs for delete to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.enforce_saved_jobs_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  max_saved integer;
begin
  select p.saved_jobs_limit into max_saved
    from public.plans p where p.id = public.plan_of(new.user_id);
  if max_saved is not null
     and (select count(*) from public.saved_jobs where user_id = new.user_id) >= max_saved then
    raise exception 'saved_jobs_limit' using errcode = 'P0001',
      hint = 'Upgrade your plan to save more jobs.';
  end if;
  return new;
end;
$$;

create trigger saved_jobs_limit
  before insert on public.saved_jobs
  for each row execute function public.enforce_saved_jobs_limit();

-- Job alerts -----------------------------------------------------------------
create table public.job_alerts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  query text,
  job_type text,
  source text,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  check (query is not null or job_type is not null or source is not null)
);
create index job_alerts_user_idx on public.job_alerts (user_id);
alter table public.job_alerts enable row level security;

create policy "read own alerts"
  on public.job_alerts for select to authenticated
  using (user_id = (select auth.uid()));
create policy "create own alerts"
  on public.job_alerts for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "delete own alerts"
  on public.job_alerts for delete to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.enforce_alerts_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  max_alerts integer;
begin
  select p.alerts_limit into max_alerts
    from public.plans p where p.id = public.plan_of(new.user_id);
  if (select count(*) from public.job_alerts where user_id = new.user_id) >= max_alerts then
    raise exception 'alerts_limit' using errcode = 'P0001',
      hint = 'Upgrade your plan to create more alerts.';
  end if;
  return new;
end;
$$;

create trigger job_alerts_limit
  before insert on public.job_alerts
  for each row execute function public.enforce_alerts_limit();
