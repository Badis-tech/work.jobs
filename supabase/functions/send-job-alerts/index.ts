import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Emails each user the jobs that first appeared since their alert last fired.
// Intended to run daily from pg_cron (same pattern as ingest-jobs).
// Secrets: RESEND_API_KEY, ALERT_FROM (e.g. "Jobs <alerts@yourdomain.com>"),
// SITE_URL (public site, for links).

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const MAX_JOBS_PER_EMAIL = 20;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

Deno.serve(async () => {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("ALERT_FROM");
  const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
  if (!resendKey || !from || !siteUrl) {
    return new Response(JSON.stringify({ error: "RESEND_API_KEY, ALERT_FROM and SITE_URL must be set" }), {
      status: 503,
    });
  }

  const { data: alerts, error } = await supabase.from("job_alerts").select("*");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let sent = 0;
  let skipped = 0;
  for (const alert of alerts ?? []) {
    // Users who downgraded keep their rows but stop receiving mail.
    const { data: plan } = await supabase.rpc("plan_of", { uid: alert.user_id });
    if (plan === "free") {
      skipped++;
      continue;
    }

    let q = supabase
      .from("jobs")
      .select("id, title, company, location")
      .gt("first_seen_at", alert.last_sent_at)
      .order("first_seen_at", { ascending: false })
      .limit(MAX_JOBS_PER_EMAIL);
    if (alert.source) q = q.eq("source", alert.source);
    if (alert.job_type) q = q.eq("job_type", alert.job_type);
    if (alert.query) {
      const term = alert.query.replace(/[,()]/g, " ").trim();
      if (term) q = q.or(`title.ilike.%${term}%,company.ilike.%${term}%`);
    }
    const { data: jobs, error: jobsError } = await q;
    if (jobsError || !jobs?.length) continue;

    const { data: userRes } = await supabase.auth.admin.getUserById(alert.user_id);
    const email = userRes?.user?.email;
    if (!email) continue;

    const items = jobs
      .map(
        (j) =>
          `<li><a href="${siteUrl}/jobs/${j.id}">${esc(j.title)}</a>${
            j.company ? ` — ${esc(j.company)}` : ""
          }${j.location ? ` (${esc(j.location)})` : ""}</li>`,
      )
      .join("");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `${jobs.length} new job${jobs.length === 1 ? "" : "s"} matching your alert`,
        html: `<p>New listings for your alert:</p><ul>${items}</ul><p><a href="${siteUrl}/account">Manage alerts</a></p>`,
      }),
    });
    if (!res.ok) {
      console.error("resend failed", res.status, await res.text());
      continue; // keep last_sent_at so the same jobs go out next run
    }
    await supabase.from("job_alerts").update({ last_sent_at: new Date().toISOString() }).eq("id", alert.id);
    sent++;
  }

  return new Response(JSON.stringify({ alerts: alerts?.length ?? 0, sent, skipped }), {
    headers: { "Content-Type": "application/json" },
  });
});
