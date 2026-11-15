import Link from "next/link";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getPlanId } from "@/lib/entitlement";
import { PLANS, type PlanId } from "@/lib/plans";

const REASONS: Record<string, string> = {
  saved_limit: "You've reached the saved-jobs limit on your plan.",
  alert_limit: "Your plan has no more room for job alerts.",
};

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const current: PlanId = user ? await getPlanId() : "free";

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10">
      <h1 className="text-center text-3xl font-extrabold tracking-tight text-zinc-900 dark:text-zinc-100">
        Pick your plan
      </h1>
      <p className="mt-2 text-center text-sm text-zinc-500">Cancel anytime. VAT handled for you via Lemon Squeezy.</p>
      {reason && REASONS[reason] && (
        <p className="mx-auto mt-4 max-w-md rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-center text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          {REASONS[reason]}
        </p>
      )}

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {PLANS.map((p) => {
          const isCurrent = p.id === current;
          const cta = (() => {
            if (isCurrent) return <span className="block text-center text-sm font-medium text-zinc-500">Your current plan</span>;
            if (p.id === "free") return null;
            if (!user)
              return (
                <Link href={`/login?next=${encodeURIComponent(`/checkout?plan=${p.id}`)}`} className={btn}>
                  Sign in to choose {p.name}
                </Link>
              );
            // Existing subscribers change plan in the billing portal so we never
            // create a second subscription for the same account.
            if (current !== "free")
              return (
                <a href="/account/billing" className={btn}>
                  Switch in billing portal
                </a>
              );
            return (
              <Link href={`/checkout?plan=${p.id}`} className={btn}>
                Choose {p.name}
              </Link>
            );
          })();
          return (
            <section
              key={p.id}
              className={`flex flex-col rounded-xl border p-6 ${
                p.id === "plus" ? "border-brand shadow-md" : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{p.name}</h2>
              <p className="mt-1 text-2xl font-extrabold text-zinc-900 dark:text-zinc-100">{p.price}</p>
              <p className="mt-1 text-sm text-zinc-500">{p.tagline}</p>
              <ul className="mt-4 flex-1 space-y-1.5 text-sm text-zinc-700 dark:text-zinc-300">
                {p.features.map((f) => (
                  <li key={f}>✓ {f}</li>
                ))}
              </ul>
              <div className="mt-6">{cta}</div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

const btn =
  "block rounded-md bg-brand px-4 py-2.5 text-center text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-dark";
