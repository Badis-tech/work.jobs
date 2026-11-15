import { createAlert } from "@/app/account/actions";

// "Alert me about this search" for the current filters.
export function AlertButton({
  q,
  source,
  type,
  returnTo,
}: {
  q?: string;
  source?: string;
  type?: string;
  returnTo: string;
}) {
  if (!q && !source && !type) return null;
  return (
    <form action={createAlert} className="mt-3">
      <input type="hidden" name="q" value={q ?? ""} />
      <input type="hidden" name="source" value={source ?? ""} />
      <input type="hidden" name="type" value={type ?? ""} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <button
        type="submit"
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        🔔 Alert me about new matches
      </button>
    </form>
  );
}
