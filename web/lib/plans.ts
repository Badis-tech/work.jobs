// Plan catalogue shared by the pricing page, account page and webhook.
//
// The hard limits (saved jobs, alerts, browsing) are enforced in Postgres from
// the `plans` table (see 20261105120000_plans_saved_jobs_alerts.sql). The copy
// and price labels below are display-only: the real price is whatever the
// Lemon Squeezy variant charges, so keep the two in sync.

export type PlanId = "free" | "plus" | "pro";

export interface PlanInfo {
  id: PlanId;
  name: string;
  price: string; // display only
  tagline: string;
  features: string[];
  // Env var holding the Lemon Squeezy variant id; null for the free tier.
  variantEnv: string | null;
}

export const PLANS: PlanInfo[] = [
  {
    id: "free",
    name: "Free",
    price: "€0",
    tagline: "Browse the first 20 listings.",
    features: ["First 20 listings", "Save up to 10 jobs", "Account & profile"],
    variantEnv: null,
  },
  {
    id: "plus",
    name: "Plus",
    price: "€4.99/mo",
    tagline: "Every listing, no limit.",
    features: ["Unlimited listings", "Save up to 100 jobs", "1 email job alert"],
    variantEnv: "LEMONSQUEEZY_VARIANT_PLUS",
  },
  {
    id: "pro",
    name: "Pro",
    price: "€9.99/mo",
    tagline: "For an active search.",
    features: ["Unlimited listings", "Unlimited saved jobs", "10 email job alerts"],
    variantEnv: "LEMONSQUEEZY_VARIANT_PRO",
  },
];

export function isPlanId(v: unknown): v is PlanId {
  return v === "free" || v === "plus" || v === "pro";
}

export function planInfo(id: string): PlanInfo {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

// Lemon Squeezy variant id for a paid plan. LEMONSQUEEZY_VARIANT_ID is the
// pre-tiers variable and still maps to Plus so existing deployments keep working.
export function variantIdFor(plan: PlanId): string | null {
  const info = planInfo(plan);
  if (!info.variantEnv) return null;
  const v = process.env[info.variantEnv]?.trim();
  if (v) return v;
  if (plan === "plus") return process.env.LEMONSQUEEZY_VARIANT_ID?.trim() || null;
  return null;
}

// Reverse lookup used by the webhook: which plan does this variant belong to?
export function planForVariant(variantId: string | null | undefined): PlanId | null {
  if (!variantId) return null;
  for (const p of PLANS) {
    if (p.id !== "free" && variantIdFor(p.id) === String(variantId)) return p.id;
  }
  return null;
}
