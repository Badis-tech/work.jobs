-- Per-user daily usage counters for the CV tool.
--
-- Generation is a 160-second serverless function calling a paid-by-the-request
-- upstream. Without a cap that is a denial-of-wallet button, so every model call
-- consumes a unit first. Counting lives in Postgres rather than in the app
-- because the app is serverless: in-memory counters do not survive, and do not
-- agree across concurrent instances.

create table if not exists public.cv_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- UTC day (the database's current_date); quotas reset at 00:00 UTC.
  day date not null default current_date,
  -- Which operation: they have separate budgets because they cost differently.
  kind text not null check (kind in ('generate','reformat','extract')),
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day, kind)
);

alter table public.cv_usage enable row level security;

-- A user may read their own counters (so the UI can show "3 von 10 heute").
-- There are deliberately NO insert/update/delete policies: the Data API must
-- not be able to reset a counter. The security-definer functions below are the
-- only writers.
--
-- Dropped first so the whole file stays re-runnable: this project shares its
-- migration ledger with the auth-service app, so a push may have to be redone
-- by hand in the SQL editor, and `create policy` alone is not idempotent.
drop policy if exists "read own cv usage" on public.cv_usage;
create policy "read own cv usage"
  on public.cv_usage for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Atomically increment today's counter and return the new value.
--
-- The limit is deliberately NOT a parameter: the caller enforces it. A user can
-- invoke this RPC directly through PostgREST, and the only thing that buys them
-- is a higher count of their own — there is no argument they can pass that
-- grants extra budget.
create or replace function public.consume_cv_quota(p_kind text)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_count integer;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  insert into public.cv_usage as u (user_id, day, kind, count)
  values (v_user, current_date, p_kind, 1)
  on conflict (user_id, day, kind)
    do update set count = u.count + 1, updated_at = now()
  returning u.count into v_count;

  return v_count;
end;
$$;

-- Give a unit back when the work never happened — the free models rate-limit
-- and time out often enough that charging for a failed generation would let a
-- user burn a whole day's budget on upstream 429s.
create or replace function public.refund_cv_quota(p_kind text)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_count integer;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  update public.cv_usage
     set count = greatest(count - 1, 0), updated_at = now()
   where user_id = v_user and day = current_date and kind = p_kind
  returning count into v_count;

  return coalesce(v_count, 0);
end;
$$;

revoke execute on function public.consume_cv_quota(text) from public;
revoke execute on function public.refund_cv_quota(text) from public;
grant execute on function public.consume_cv_quota(text) to authenticated;
grant execute on function public.refund_cv_quota(text) to authenticated;
