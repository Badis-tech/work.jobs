import { fetchJobs, FREE_PAGES } from "@/lib/jobs";
import { isEntitled } from "@/lib/entitlement";
import { Filters } from "@/components/filters";
import { JobCard } from "@/components/job-card";
import { AlertButton } from "@/components/alert-button";
import { Pagination } from "@/components/pagination";
import { Paywall } from "@/components/paywall";
import { createSupabaseServer } from "@/lib/supabase-server";

interface SearchParams {
  q?: string;
  source?: string;
  type?: string;
  page?: string;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { q, source, type, page: pageParam } = await searchParams;
  const page = Math.max(1, Math.floor(Number(pageParam)) || 1);

  // GATE: pages beyond the free allowance require an active subscription.
  // We check entitlement BEFORE fetching, so locked job data never leaves the
  // server for a non-paying user. This cannot be bypassed from the client.
  const locked = page > FREE_PAGES;
  if (locked) {
    const entitled = await isEntitled();
    if (!entitled) {
      const supabase = await createSupabaseServer();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return (
        <main className="mx-auto w-full max-w-3xl px-4 py-8">
          <header className="mb-6">
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
              work.jobs
            </h1>
          </header>
          <Filters q={q} source={source} type={type} />
          <Paywall loggedIn={Boolean(user)} attemptedPage={page} />
        </main>
      );
    }
  }

  const { jobs, total, pageCount } = await fetchJobs({ q, source, type, page });

  // Which of these jobs the signed-in user has saved (RLS limits rows to them).
  const supabase = await createSupabaseServer();
  const { data: savedRows } = jobs.length
    ? await supabase.from("saved_jobs").select("job_id").in("job_id", jobs.map((j) => j.id))
    : { data: [] };
  const savedIds = new Set((savedRows ?? []).map((r) => r.job_id));
  const returnParams = new URLSearchParams();
  for (const [k, v] of Object.entries({ q, source, type, page: page > 1 ? String(page) : undefined })) {
    if (v) returnParams.set(k, v);
  }
  const returnTo = returnParams.size ? `/?${returnParams}` : "/";

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="mb-6">
        <div className="inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-3 py-1 text-xs font-medium text-brand">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
          </span>
          Refreshed every 6 hours
        </div>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-zinc-900 dark:text-zinc-100">
          Find your <span className="text-brand">Ausbildung</span> in Germany
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          {total.toLocaleString("en-GB")} live postings from the Bundesagentur für Arbeit,
          Arbeitnow, Remotive, Jobicy, Remote OK, Himalayas, Working Nomads and Landing.jobs.
        </p>
      </header>

      <Filters q={q} source={source} type={type} />
      <AlertButton q={q} source={source} type={type} returnTo={returnTo} />

      {jobs.length === 0 ? (
        <p className="mt-10 text-center text-zinc-500">No jobs match these filters.</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} saved={savedIds.has(job.id)} returnTo={returnTo} />
          ))}
        </ul>
      )}

      <div className="mt-8">
        <Pagination page={page} pageCount={pageCount} params={{ q, source, type }} />
      </div>
    </main>
  );
}
