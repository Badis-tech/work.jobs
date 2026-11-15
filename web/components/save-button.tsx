import { toggleSaveJob } from "@/app/account/actions";

// Star toggle. A plain server-action form, so it works without client JS and
// the limit/login checks stay server-side.
export function SaveButton({
  jobId,
  saved,
  returnTo,
}: {
  jobId: number;
  saved: boolean;
  returnTo: string;
}) {
  return (
    <form action={toggleSaveJob}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <button
        type="submit"
        aria-label={saved ? "Remove from saved jobs" : "Save job"}
        title={saved ? "Remove from saved jobs" : "Save job"}
        className={`rounded-md px-2 py-1 text-lg leading-none transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
          saved ? "text-amber-500" : "text-zinc-400"
        }`}
      >
        {saved ? "★" : "☆"}
      </button>
    </form>
  );
}
