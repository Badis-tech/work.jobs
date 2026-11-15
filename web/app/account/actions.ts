"use server";

import { createClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase-server";
import type { Database } from "@/lib/database.types";

// Only internal paths; blocks open redirects through the hidden `returnTo`.
function safeReturn(v: FormDataEntryValue | null, fallback: string): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : fallback;
}

function str(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}

async function requireUser() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

// Postgres limit triggers raise 'saved_jobs_limit' / 'alerts_limit'.
function isLimitError(message: string | undefined): boolean {
  return Boolean(message && /saved_jobs_limit|alerts_limit/.test(message));
}

export async function toggleSaveJob(formData: FormData) {
  const returnTo = safeReturn(formData.get("returnTo"), "/");
  const jobId = Number(formData.get("jobId"));
  if (!Number.isInteger(jobId)) redirect(returnTo);

  const { supabase, user } = await requireUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(returnTo)}`);

  const { data: existing } = await supabase
    .from("saved_jobs")
    .select("job_id")
    .eq("job_id", jobId)
    .maybeSingle();

  if (existing) {
    await supabase.from("saved_jobs").delete().eq("job_id", jobId);
  } else {
    const { error } = await supabase.from("saved_jobs").insert({ job_id: jobId, user_id: user.id });
    if (isLimitError(error?.message)) redirect("/pricing?reason=saved_limit");
  }
  revalidatePath("/account");
  redirect(returnTo);
}

export async function createAlert(formData: FormData) {
  const returnTo = safeReturn(formData.get("returnTo"), "/");
  const { supabase, user } = await requireUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(returnTo)}`);

  const query = str(formData.get("q")) || null;
  const job_type = str(formData.get("type")) || null;
  const source = str(formData.get("source")) || null;
  if (!query && !job_type && !source) redirect(returnTo);

  const { error } = await supabase
    .from("job_alerts")
    .insert({ user_id: user.id, query, job_type, source });
  if (isLimitError(error?.message)) redirect("/pricing?reason=alert_limit");
  revalidatePath("/account");
  redirect("/account?notice=alert_created");
}

export async function deleteAlert(formData: FormData) {
  const id = Number(formData.get("id"));
  const { supabase, user } = await requireUser();
  if (!user || !Number.isInteger(id)) redirect("/account");
  await supabase.from("job_alerts").delete().eq("id", id);
  revalidatePath("/account");
  redirect("/account?notice=alert_deleted");
}

export async function updateUsername(formData: FormData) {
  const { supabase, user } = await requireUser();
  if (!user) redirect("/login?next=/account");

  const username = str(formData.get("username"));
  if (!/^[A-Za-z0-9_]{3,30}$/.test(username)) redirect("/account?notice=username_invalid");

  const { data, error } = await supabase
    .from("profiles")
    .update({ username })
    .eq("id", user.id)
    .select("id");
  if (error || !data?.length) {
    // unique violation on username, or no profile row
    redirect("/account?notice=username_taken");
  }
  revalidatePath("/account");
  redirect("/account?notice=profile_saved");
}

export async function updateEmail(formData: FormData) {
  const { supabase, user } = await requireUser();
  if (!user) redirect("/login?next=/account");

  const email = str(formData.get("email"));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect("/account?notice=email_invalid");

  const { error } = await supabase.auth.updateUser({ email });
  redirect(error ? "/account?notice=email_error" : "/account?notice=email_sent");
}

// Permanently deletes the account. Cancels the Lemon Squeezy subscription
// first so the user is not billed for an account that no longer exists; all
// user rows cascade from auth.users.
export async function deleteAccount(formData: FormData) {
  const { supabase, user } = await requireUser();
  if (!user) redirect("/login?next=/account");
  if (str(formData.get("confirm")) !== "DELETE") redirect("/account?notice=delete_unconfirmed");

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!serviceKey || !supabaseUrl) redirect("/account?notice=delete_unavailable");

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("ls_subscription_id, status")
    .eq("user_id", user.id)
    .maybeSingle();

  const lsKey = process.env.LEMONSQUEEZY_API_KEY;
  if (sub?.ls_subscription_id && ["active", "on_trial", "past_due", "paused"].includes(sub.status)) {
    // Abort the deletion if we cannot cancel: otherwise billing would continue.
    if (!lsKey) redirect("/account?notice=delete_unavailable");
    const res = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${sub.ls_subscription_id}`, {
      method: "DELETE",
      headers: { Accept: "application/vnd.api+json", Authorization: `Bearer ${lsKey}` },
    });
    if (!res.ok && res.status !== 404) {
      console.error("LS cancel failed:", res.status, await res.text());
      redirect("/account?notice=delete_cancel_failed");
    }
  }

  const admin = createClient<Database>(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    console.error("deleteUser failed:", error.message);
    redirect("/account?notice=delete_unavailable");
  }

  await supabase.auth.signOut();
  redirect("/?notice=account_deleted");
}
