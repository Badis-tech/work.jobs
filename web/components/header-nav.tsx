"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/app/auth/actions";

// Primary app navigation. Client-side so links can show an active state.
// `email` is resolved on the server and passed down (auth is server-only).
const NAV: { href: string; label: string; exact?: boolean }[] = [
  { href: "/", label: "Jobs", exact: true },
  { href: "/pricing", label: "Pricing" },
];

export function HeaderNav({ email }: { email: string | null }) {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 text-sm sm:gap-2">
      {NAV.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-2.5 py-1.5 font-medium transition-colors ${
              active
                ? "bg-brand/10 text-brand"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-brand dark:text-zinc-400 dark:hover:bg-zinc-900"
            }`}
          >
            {item.label}
          </Link>
        );
      })}

      {email ? (
        <>
          <Link
            href="/account"
            aria-current={pathname.startsWith("/account") ? "page" : undefined}
            className="hidden rounded-md px-2.5 py-1.5 font-medium text-zinc-600 hover:bg-zinc-100 hover:text-brand md:inline dark:text-zinc-400 dark:hover:bg-zinc-900"
          >
            {email}
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Sign out
            </button>
          </form>
        </>
      ) : (
        <Link
          href="/login"
          className="rounded-md bg-brand px-4 py-1.5 font-semibold text-white shadow-sm transition-colors hover:bg-brand-dark"
        >
          Sign in
        </Link>
      )}
    </nav>
  );
}
