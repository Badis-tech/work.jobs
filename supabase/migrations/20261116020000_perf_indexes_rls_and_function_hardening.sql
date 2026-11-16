-- Fixes from the Supabase performance + security advisors (2026-11-16).
-- DRAFT: review before applying; nothing here has been run against production.
--
-- 1. Indexes on foreign keys (saved_jobs cascades on jobs delete, so the daily
--    prune-stale-jobs job scans saved_jobs once per deleted job without this).
-- 2. RLS policies: evaluate auth.uid() once per query, and merge the two
--    overlapping user_roles SELECT policies into one.
-- 3. Stop exposing SECURITY DEFINER functions through /rest/v1/rpc to roles
--    that should not call them, and pin touch_updated_at's search_path.
--
-- Not changed on purpose: the unused indexes jobs_tags_idx and
-- job_alerts_user_idx (features may not have been exercised yet), and RLS
-- without policies on pipeline_runs / pipeline_alerts (service role only).

-- 1. Foreign-key indexes ---------------------------------------------------

create index if not exists saved_jobs_job_id_idx
  on public.saved_jobs (job_id);

create index if not exists subscriptions_plan_idx
  on public.subscriptions (plan);

-- 2. RLS policies ----------------------------------------------------------

alter policy "Users can update their own profile" on public.profiles
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- One SELECT policy instead of two permissive ones: own rows, or any row for
-- admins. has_role() stays executable by `authenticated` (section 3) because
-- this policy calls it as the signed-in user.
alter policy "Users can view their own roles" on public.user_roles
  using (
    (select auth.uid()) = user_id
    or public.has_role((select auth.uid()), 'admin'::public.app_role)
  );

drop policy "Admins can view all roles" on public.user_roles;

-- 3. Function exposure -----------------------------------------------------

-- Trigger functions: never meant to be called over the REST API. Postgres only
-- checks EXECUTE on a trigger function when the trigger is created, so
-- revoking does not stop the triggers from firing.
revoke execute on function public.handle_new_user()          from public, anon, authenticated;
revoke execute on function public.enforce_alerts_limit()     from public, anon, authenticated;
revoke execute on function public.enforce_saved_jobs_limit() from public, anon, authenticated;

-- Called by the web app for signed-in users. Logged-out callers of
-- current_plan() get an error and web/lib/entitlement.ts treats that as "free".
revoke execute on function public.current_plan()    from public, anon;
revoke execute on function public.has_active_sub()  from public, anon;
grant  execute on function public.current_plan()    to authenticated;
grant  execute on function public.has_active_sub()  to authenticated;

-- Used inside the user_roles RLS policy, which runs as the signed-in user, so
-- `authenticated` keeps EXECUTE. The advisor will still list it for that role.
revoke execute on function public.has_role(uuid, public.app_role) from public, anon;
grant  execute on function public.has_role(uuid, public.app_role) to authenticated;

-- Body is `new.updated_at = now()`; pg_catalog is always searched, so an empty
-- search_path is safe.
alter function public.touch_updated_at() set search_path = '';

-- Rollback sketch (policies only; grants restore with `grant execute ... to
-- public`): recreate "Admins can view all roles" with
--   using (public.has_role(auth.uid(), 'admin'::public.app_role))
-- and put the original single-condition using() back on
-- "Users can view their own roles".
