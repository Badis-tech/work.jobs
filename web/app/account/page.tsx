import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getPlanId } from "@/lib/entitlement";
import { planInfo } from "@/lib/plans";
import { formatDate, sourceLabel, typeLabel } from "@/lib/format";
import { deleteAccount, deleteAlert, toggleSaveJob, updateEmail, updateUsername } from "./actions";

const NOTICES: Record<string, { text: string; error?: boolean }> = {
  profile_saved: { text: "Profile saved." },
  username_invalid: { text: "Username must be 3–30 characters: letters, numbers, underscore.", error: true },
  username_taken: { text: "That username is taken.", error: true },
  email_sent: { text: "Check both inboxes: confirm the change from the link we sent." },
  email_invalid: { text: "Enter a valid email address.", error: true },
  email_error: { text: "Could not change the email. Try again later.", error: true },
  alert_created: { text: "Alert created." },
  alert_deleted: { text: "Alert deleted." },
  billing_unavailable: { text: "Billing portal is unavailable right now.", error: true },
  delete_unconfirmed: { text: "Type DELETE to confirm account deletion.", error: true },
  delete_unavailable: { text: "Account deletion is unavailable right now. Nothing was deleted.", error: true },
  delete_cancel_failed: { text: "Could not cancel your subscription, so nothing was deleted. Cancel it in the billing portal first.", error: true },
};

const field =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";
const primaryBtn =
  "rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-dark";
const ghostBtn =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await searchParams;
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/account");

  const [planId, profile, sub, saved, alerts] = await Promise.all([
    getPlanId(),
    supabase.from("profiles").select("username").eq("id", user.id).maybeSingle(),
    supabase
      .from("subscriptions")
      .select("status, renews_at, ends_at, ls_subscription_id")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("saved_jobs")
      .select("created_at, jobs(id, title, company, source, job_type, published_at)")
      .order("created_at", { ascending: false }),
    supabase.from("job_alerts").select("id, query, job_type, source").order("created_at", { ascending: false }),
  ]);

  const plan = planInfo(planId);
  const s = sub.data;
  const cancelling = s?.status === "cancelled";
  const msg = notice ? NOTICES[notice] : undefined;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Your account</h1>

      {msg && (
        <p
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${
            msg.error
              ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
              : "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
          }`}
        >
          {msg.text}
        </p>
      )}

      <Section title="Plan & billing">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Current plan: <span className="font-semibold text-zinc-900 dark:text-zinc-100">{plan.name}</span>
          {planId !== "free" && ` (${plan.price})`}
        </p>
        {s && planId !== "free" && (
          <p className="mt-1 text-sm text-zinc-500">
            {cancelling
              ? `Cancelled — access until ${formatDate(s.ends_at)}.`
              : `Renews on ${formatDate(s.renews_at)}.`}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {planId === "free" ? (
            <Link href="/pricing" className={primaryBtn}>
              See plans
            </Link>
          ) : (
            <>
              <a href="/account/billing" className={primaryBtn}>
                Manage billing
              </a>
              <Link href="/pricing" className={ghostBtn}>
                Compare plans
              </Link>
            </>
          )}
        </div>
      </Section>

      <Section title="Profile">
        <form action={updateUsername} className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <label htmlFor="username" className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Username
            </label>
            <input id="username" name="username" defaultValue={profile.data?.username ?? ""} required className={field} />
          </div>
          <button type="submit" className={primaryBtn}>
            Save
          </button>
        </form>
        <form action={updateEmail} className="mt-4 flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Email
            </label>
            <input id="email" name="email" type="email" defaultValue={user.email ?? ""} required className={field} />
          </div>
          <button type="submit" className={ghostBtn}>
            Change email
          </button>
        </form>
      </Section>

      <Section title={`Saved jobs (${saved.data?.length ?? 0})`}>
        {!saved.data?.length ? (
          <p className="text-sm text-zinc-500">Nothing saved yet. Use ☆ on any job to keep it here.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {saved.data.map((row) => {
              const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
              if (!job) return null;
              return (
                <li key={job.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <Link href={`/jobs/${job.id}`} className="block truncate font-medium hover:text-brand">
                      {job.title}
                    </Link>
                    <p className="truncate text-xs text-zinc-500">
                      {[job.company, typeLabel(job.job_type), sourceLabel(job.source)].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <form action={toggleSaveJob}>
                    <input type="hidden" name="jobId" value={job.id} />
                    <input type="hidden" name="returnTo" value="/account" />
                    <button type="submit" className={ghostBtn}>
                      Remove
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title={`Job alerts (${alerts.data?.length ?? 0})`}>
        {!alerts.data?.length ? (
          <p className="text-sm text-zinc-500">
            {planId === "free" ? (
              <>
                Email alerts are part of <Link href="/pricing" className="underline">Plus and Pro</Link>. Search for
                something on the jobs page, then choose “Alert me”.
              </>
            ) : (
              "No alerts yet. Search for something on the jobs page, then choose “Alert me”."
            )}
          </p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {alerts.data.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>
                  {[a.query && `“${a.query}”`, a.job_type && typeLabel(a.job_type), a.source && sourceLabel(a.source)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <form action={deleteAlert}>
                  <input type="hidden" name="id" value={a.id} />
                  <button type="submit" className={ghostBtn}>
                    Delete
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Delete account" danger>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Permanently deletes your account, saved jobs and alerts, and cancels any active subscription. This cannot be
          undone.
        </p>
        <form action={deleteAccount} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <label htmlFor="confirm" className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Type DELETE to confirm
            </label>
            <input id="confirm" name="confirm" autoComplete="off" required className={field} />
          </div>
          <button
            type="submit"
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
          >
            Delete my account
          </button>
        </form>
      </Section>
    </main>
  );
}

function Section({ title, danger, children }: { title: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <section
      className={`rounded-xl border p-5 ${
        danger
          ? "border-red-300 dark:border-red-900/60"
          : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      <h2 className="mb-3 text-lg font-bold text-zinc-900 dark:text-zinc-100">{title}</h2>
      {children}
    </section>
  );
}
