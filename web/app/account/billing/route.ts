import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";

// Sends the logged-in subscriber to their Lemon Squeezy customer portal
// (change plan, update card, cancel). Portal URLs are signed and short-lived,
// so we ask the API for a fresh one on every click instead of storing it.
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/account", origin));

  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("ls_subscription_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!apiKey || !sub?.ls_subscription_id) {
    return NextResponse.redirect(new URL("/account?notice=billing_unavailable", origin));
  }

  const res = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${sub.ls_subscription_id}`, {
    headers: { Accept: "application/vnd.api+json", Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    console.error("LS portal lookup failed:", res.status, await res.text());
    return NextResponse.redirect(new URL("/account?notice=billing_unavailable", origin));
  }
  const portal: string | undefined = (await res.json())?.data?.attributes?.urls?.customer_portal;
  if (!portal) return NextResponse.redirect(new URL("/account?notice=billing_unavailable", origin));
  return NextResponse.redirect(portal);
}
