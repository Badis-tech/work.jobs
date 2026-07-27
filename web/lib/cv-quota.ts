// Per-user daily quota for the CV tool.
//
// Counting happens in Postgres (see the cv_usage migration) because the routes
// are serverless: an in-memory counter neither survives a cold start nor agrees
// across concurrent instances. The DB increments; this module owns the limits
// and the decision.

import { createSupabaseServer } from "./supabase-server";

export type QuotaKind = "generate" | "reformat" | "extract";

// Defaults are generous enough not to bother a real applicant — a Bewerbung is
// written a handful of times, not hundreds — and low enough to bound a runaway.
const DEFAULT_LIMITS: Record<QuotaKind, number> = {
  generate: 10,
  reformat: 10,
  extract: 30,
};

const ENV_KEYS: Record<QuotaKind, string> = {
  generate: "CV_QUOTA_GENERATE",
  reformat: "CV_QUOTA_REFORMAT",
  extract: "CV_QUOTA_EXTRACT",
};

export function quotaFor(kind: QuotaKind): number {
  const raw = process.env[ENV_KEYS[kind]];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_LIMITS[kind];
}

export interface QuotaDecision {
  allowed: boolean;
  used: number;
  quota: number;
  /** Seconds until the counter resets, for a Retry-After header. */
  retryAfter: number;
}

/** Counters reset at 00:00 UTC, matching Postgres `current_date`. */
export function secondsUntilReset(now = new Date()): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Charge one unit and decide whether the caller may proceed.
 *
 * Fails CLOSED. A rate limiter that opens when its backing store is unreachable
 * is not a rate limiter, and the failure mode it would protect against — an
 * unbounded number of 160-second upstream calls — is exactly the expensive one.
 * If this starts returning `allowed: false` everywhere, check that the
 * cv_usage migration has actually been applied to the linked project.
 */
export async function consumeQuota(kind: QuotaKind): Promise<QuotaDecision> {
  const quota = quotaFor(kind);
  const retryAfter = secondsUntilReset();

  try {
    const supabase = await createSupabaseServer();
    const { data, error } = await supabase.rpc("consume_cv_quota", {
      p_kind: kind,
    });

    if (error || typeof data !== "number") {
      console.error("consumeQuota failed:", error?.message ?? "no count returned");
      return { allowed: false, used: quota, quota, retryAfter };
    }

    return { allowed: data <= quota, used: data, quota, retryAfter };
  } catch (e) {
    console.error("consumeQuota threw:", e);
    return { allowed: false, used: quota, quota, retryAfter };
  }
}

/**
 * Hand a unit back after work that never produced anything. Best effort: a lost
 * refund costs the user one generation, so it must never turn into a 500.
 */
export async function refundQuota(kind: QuotaKind): Promise<void> {
  try {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.rpc("refund_cv_quota", { p_kind: kind });
    if (error) console.error("refundQuota failed:", error.message);
  } catch (e) {
    console.error("refundQuota threw:", e);
  }
}

/** 429 body + headers, in the app's user-facing language. */
export function quotaExceededResponse(d: QuotaDecision): {
  body: { error: string; used: number; quota: number };
  headers: Record<string, string>;
} {
  return {
    body: {
      error: `Tageslimit erreicht (${d.quota} pro Tag). Bitte morgen erneut versuchen.`,
      used: d.used,
      quota: d.quota,
    },
    headers: { "Retry-After": String(d.retryAfter) },
  };
}
