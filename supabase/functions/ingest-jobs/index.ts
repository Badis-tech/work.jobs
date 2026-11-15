import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface NormalizedJob {
  source: string;
  external_id: string;
  title: string;
  company: string | null;
  location: string | null;
  remote: boolean | null;
  job_type: string | null;
  category: string | null;
  tags: string[];
  salary_text: string | null;
  url: string;
  // Omitted (not null) by sources that fill it in a later enrich step, so a
  // re-fetch of the same listing does not wipe the stored description.
  description_html?: string | null;
  published_at: string | null;
  last_seen_at: string;
  // Workplace coordinates (WGS84) when the source provides them; shown on
  // the quest-os map. Omitted by sources that have none.
  lat?: number | null;
  lng?: number | null;
}

interface Source {
  name: string;
  // Env vars that must be set for this source; missing ones skip the source
  // (reported in the response, no pipeline_runs row).
  requiredEnv?: string[];
  fetch: () => Promise<NormalizedJob[]>;
  // Optional per-job detail step, run by ?mode=enrich invocations only. Must
  // stop by `deadline` (epoch ms); returns the number of jobs processed.
  enrich?: (deadline: number) => Promise<number>;
}

// The platform kills a worker that exceeds its compute allowance
// (WORKER_RESOURCE_LIMIT, HTTP 546) or wall-clock limit without running any
// catch block, which leaves runs stuck at 'running'. Two guards against that:
// a wall-clock budget, and enrichment (the expensive part: one detail request
// plus one row update per job) runs in its own small invocations — see
// ?mode=enrich and JOBSUCHE_ENRICH_MAX. ~1,700 enrichments in one invocation
// was measured to hit the compute limit.
const RUN_BUDGET_MS = 110_000;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = "work.jobs ingest (job aggregator; links back to source)";

function env(name: string): string | null {
  const v = Deno.env.get(name)?.trim();
  return v ? v : null;
}

// fetch + JSON with a hard timeout, so one hung upstream cannot eat the budget.
async function getJson(label: string, url: string | URL, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${label} HTTP ${res.status}`);
  }
  return await res.json();
}

function salaryRange(
  min: number | null | undefined,
  max: number | null | undefined,
  currency?: string | null,
  period?: string | null,
): string | null {
  if (!min && !max) return null;
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  const range = min && max && min !== max ? `${fmt(min)}–${fmt(max)}` : fmt((min || max)!);
  return [range, currency, period].filter(Boolean).join(" ");
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

// Remotive timestamps and Jobsuche dates come without a timezone; they are UTC.
function toUtcIso(s: string | null | undefined): string | null {
  if (!s) return null;
  let normalized = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    normalized = s + "T00:00:00Z";
  } else if (!/Z$|[+-]\d{2}:?\d{2}$/.test(s)) {
    normalized = s + "Z";
  }
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function epochToIso(seconds: unknown): string | null {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

const remotive: Source = {
  name: "remotive",
  async fetch() {
    const body = await getJson("remotive", "https://remotive.com/api/remote-jobs?limit=200");
    const now = new Date().toISOString();
    const jobs: NormalizedJob[] = [];
    for (const j of body.jobs ?? []) {
      if (!j.id || !j.title || !j.url) continue;
      jobs.push({
        source: "remotive",
        external_id: String(j.id),
        title: j.title,
        company: j.company_name ?? null,
        location: j.candidate_required_location ?? null,
        remote: true,
        job_type: j.job_type ?? null,
        category: j.category ?? null,
        tags: Array.isArray(j.tags) ? j.tags : [],
        salary_text: j.salary || null,
        url: j.url,
        description_html: j.description ?? null,
        published_at: toUtcIso(j.publication_date),
        last_seen_at: now,
      });
    }
    return jobs;
  },
};

const arbeitnow: Source = {
  name: "arbeitnow",
  async fetch() {
    const now = new Date().toISOString();
    const jobs: NormalizedJob[] = [];
    for (let page = 1; page <= 3; page++) {
      const body = await getJson(
        `arbeitnow (page ${page})`,
        `https://www.arbeitnow.com/api/job-board-api?page=${page}`,
      );
      const items = body.data ?? [];
      for (const j of items) {
        if (!j.slug || !j.title || !j.url) continue;
        jobs.push({
          source: "arbeitnow",
          external_id: j.slug,
          title: j.title,
          company: j.company_name ?? null,
          location: j.location || null,
          remote: typeof j.remote === "boolean" ? j.remote : null,
          job_type: Array.isArray(j.job_types) && j.job_types.length ? j.job_types.join(", ") : null,
          category: null,
          tags: Array.isArray(j.tags) ? j.tags : [],
          salary_text: null,
          url: j.url,
          description_html: j.description ?? null,
          published_at: epochToIso(j.created_at),
          last_seen_at: now,
        });
      }
      if (items.length === 0 || !body.links?.next) break;
    }
    return jobs;
  },
};

// Bundesagentur für Arbeit Jobsuche API. "jobboerse-jobsuche" is the public
// client id documented at https://jobsuche.api.bund.dev/ — not a secret.
const JOBSUCHE_BASE = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc";
const JOBSUCHE_HEADERS = { "X-API-Key": "jobboerse-jobsuche" };
const JOBSUCHE_ENRICH_BATCH = 100;
// Per invocation. The cron calls ?mode=enrich every 10 minutes, so this
// drains ~43k jobs/day against ~2k new ones.
const JOBSUCHE_ENRICH_MAX = 300;
const JOBSUCHE_ENRICH_CONCURRENCY = 8;

// First workplace of a posting with usable coordinates.
function jobsucheCoords(locations: unknown): { lat: number; lng: number } | null {
  for (const l of Array.isArray(locations) ? locations : []) {
    const lat = Number(l?.breite);
    const lng = Number(l?.laenge);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) return { lat, lng };
  }
  return null;
}

const jobsuche: Source = {
  name: "jobsuche",
  async fetch() {
    const now = new Date().toISOString();
    const jobs: NormalizedJob[] = [];
    const seen = new Set<string>();
    // angebotsart 1 = ARBEIT, 4 = AUSBILDUNG / duales Studium. job_type keeps
    // the stellenangebotsart value so either kind can be filtered in SQL.
    for (const angebotsart of ["1", "4"]) {
      for (let page = 1; page <= 3; page++) {
        const body = await getJson(
          `jobsuche (angebotsart ${angebotsart}, page ${page})`,
          `${JOBSUCHE_BASE}/v6/jobs?size=100&page=${page}&angebotsart=${angebotsart}`,
          { headers: JOBSUCHE_HEADERS },
        );
        const items = body.ergebnisliste ?? [];
        for (const j of items) {
          if (!j.referenznummer || !j.stellenangebotsTitel || seen.has(j.referenznummer)) continue;
          seen.add(j.referenznummer);
          const address = j.stellenlokationen?.[0]?.adresse;
          const coords = jobsucheCoords(j.stellenlokationen);
          const location = address
            ? [address.ort, address.region, address.land].filter(Boolean).join(", ")
            : null;
          // No description_html here: the list endpoint has none, and sending
          // null would erase what enrich() stored on an earlier run.
          jobs.push({
            source: "jobsuche",
            external_id: j.referenznummer,
            title: j.stellenangebotsTitel,
            company: j.firma ?? null,
            location,
            remote: null,
            job_type: j.stellenangebotsart ?? null,
            category: j.hauptberuf ?? null,
            tags: Array.isArray(j.alleBerufe) ? j.alleBerufe : [],
            salary_text:
              j.verguetungsangabe && j.verguetungsangabe !== "KEINE_ANGABEN"
                ? j.verguetungsangabe
                : null,
            url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(j.referenznummer)}`,
            published_at: toUtcIso(j.datumErsteVeroeffentlichung ?? j.veroeffentlichungszeitraum?.von),
            last_seen_at: now,
            lat: coords?.lat ?? null,
            lng: coords?.lng ?? null,
          });
        }
        if (items.length === 0) break;
      }
    }
    return jobs;
  },

  // Fill description_html (Markdown text) from the v4 jobdetails endpoint for
  // jobs that don't have one yet, newest first, until the queue is empty,
  // JOBSUCHE_ENRICH_MAX is reached or the deadline is near. Delisted jobs (404) get '' so they are not retried
  // forever; anything else stays null for retry.
  //
  // 403 is NOT "delisted": the BA answers 403 on endpoint versions it has
  // retired (v3 did this from late 2026 and every description was blanked).
  // A batch that is mostly refusals aborts the run with an error instead.
  async enrich(deadline: number) {
    let done = 0;
    while (Date.now() < deadline && done < JOBSUCHE_ENRICH_MAX) {
      const { data: pending, error } = await supabase
        .from("jobs")
        .select("id, external_id")
        .eq("source", "jobsuche")
        .is("description_html", null)
        .order("published_at", { ascending: false, nullsFirst: false })
        .limit(Math.min(JOBSUCHE_ENRICH_BATCH, JOBSUCHE_ENRICH_MAX - done));
      if (error) throw new Error(`jobs select for enrich: ${error.message}`);
      if (!pending || pending.length === 0) break;

      let refused = 0;
      let progressed = 0;
      await mapConcurrent(pending, JOBSUCHE_ENRICH_CONCURRENCY, async (job) => {
        if (Date.now() >= deadline) return;
        const encoded = encodeURIComponent(btoa(job.external_id));
        let description: string | null = null;
        let coords: { lat: number; lng: number } | null = null;
        try {
          const res = await fetch(`${JOBSUCHE_BASE}/v4/jobdetails/${encoded}`, {
            headers: { ...JOBSUCHE_HEADERS, "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            const detail = await res.json();
            description = detail.stellenangebotsBeschreibung ?? "";
            coords = jobsucheCoords(detail.stellenlokationen);
          } else {
            await res.body?.cancel();
            if (res.status === 404) description = "";
            else refused++;
          }
        } catch (_err) {
          // network error / timeout: leave null, retried next run
        }
        if (description === null) return;
        const { error: updateError } = await supabase
          .from("jobs")
          .update(coords ? { description_html: description, ...coords } : { description_html: description })
          .eq("id", job.id);
        if (!updateError) progressed++;
      });
      done += progressed;

      if (refused > pending.length / 2) {
        throw new Error(
          `jobsuche jobdetails refused ${refused}/${pending.length} requests (endpoint changed or rate-limited); ${done} enriched before stopping`,
        );
      }
      // Nothing moved (all transient failures): the same rows would be
      // selected again, so stop instead of spinning until the deadline.
      if (progressed === 0) break;
    }
    return done;
  },
};

// Jobicy remote jobs feed (keyless). Their terms ask that Jobicy is credited
// and apply buttons link to the original job URL — we store their url as-is.
const jobicy: Source = {
  name: "jobicy",
  async fetch() {
    const body = await getJson("jobicy", "https://jobicy.com/api/v2/remote-jobs?count=100");
    const now = new Date().toISOString();
    const jobs: NormalizedJob[] = [];
    for (const j of body.jobs ?? []) {
      if (!j.id || !j.jobTitle || !j.url) continue;
      jobs.push({
        source: "jobicy",
        external_id: String(j.id),
        title: j.jobTitle,
        company: j.companyName ?? null,
        location: j.jobGeo || null,
        remote: true,
        job_type: Array.isArray(j.jobType) && j.jobType.length ? j.jobType.join(", ") : null,
        category: Array.isArray(j.jobIndustry) && j.jobIndustry.length ? j.jobIndustry[0] : null,
        tags: Array.isArray(j.jobIndustry) ? j.jobIndustry : [],
        salary_text: salaryRange(j.salaryMin, j.salaryMax, j.salaryCurrency, j.salaryPeriod),
        url: j.url,
        description_html: j.jobDescription ?? null,
        published_at: toUtcIso(j.pubDate),
        last_seen_at: now,
      });
    }
    return jobs;
  },
};

// Remote OK feed (keyless). Terms: mention Remote OK as the source and link
// back to the job's Remote OK URL — we store their url as-is. The first array
// element is the legal notice, not a job.
const remoteok: Source = {
  name: "remoteok",
  async fetch() {
    const body = await getJson("remoteok", "https://remoteok.com/api");
    const now = new Date().toISOString();
    const jobs: NormalizedJob[] = [];
    for (const j of Array.isArray(body) ? body : []) {
      if (!j.id || !j.position || !j.url) continue;
      jobs.push({
        source: "remoteok",
        external_id: String(j.id),
        title: j.position,
        company: j.company || null,
        location: j.location || null,
        remote: true,
        job_type: null,
        category: null,
        tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
        salary_text: salaryRange(Number(j.salary_min), Number(j.salary_max), "USD", "yearly"),
        url: j.url,
        description_html: j.description ?? null,
        published_at: toUtcIso(j.date) ?? epochToIso(j.epoch),
        last_seen_at: now,
      });
    }
    return jobs;
  },
};

// Himalayas remote jobs (keyless, https://himalayas.app/api). 20 jobs per
// request, newest first; `cursor` is their preferred pagination.
const HIMALAYAS_PAGES = 5;

const himalayas: Source = {
  name: "himalayas",
  async fetch() {
    const now = new Date().toISOString();
    const jobs: NormalizedJob[] = [];
    let cursor: string | null = null;
    for (let page = 1; page <= HIMALAYAS_PAGES; page++) {
      const url = new URL("https://himalayas.app/jobs/api");
      url.searchParams.set("limit", "20");
      if (cursor) url.searchParams.set("cursor", cursor);
      const body = await getJson(`himalayas (page ${page})`, url);
      const items = body.jobs ?? [];
      for (const j of items) {
        if (!j.guid || !j.title) continue;
        const restrictions: string[] = Array.isArray(j.locationRestrictions) ? j.locationRestrictions : [];
        const categories: string[] = Array.isArray(j.categories) ? j.categories : [];
        jobs.push({
          source: "himalayas",
          // guid is the canonical posting URL; keep only its path as the id.
          external_id: String(j.guid).replace(/^https?:\/\/himalayas\.app\//, ""),
          title: j.title,
          company: j.companyName ?? null,
          location: restrictions.length ? restrictions.join(", ") : "Worldwide",
          remote: true,
          job_type: j.employmentType ?? null,
          category: categories.length ? categories[0].replace(/-/g, " ") : null,
          tags: categories.map((c) => c.replace(/-/g, " ")),
          salary_text: salaryRange(j.minSalary, j.maxSalary, j.currency, j.salaryPeriod),
          url: j.applicationLink || j.guid,
          description_html: j.description ?? j.excerpt ?? null,
          published_at: epochToIso(j.pubDate),
          last_seen_at: now,
        });
      }
      cursor = body.nextCursor ?? null;
      if (items.length === 0 || !cursor) break;
    }
    return jobs;
  },
};

// Working Nomads remote jobs feed (keyless). Items have no id field; the
// number in the /job/go/<id>/ redirect URL is stable.
const workingnomads: Source = {
  name: "workingnomads",
  async fetch() {
    const body = await getJson("workingnomads", "https://www.workingnomads.com/api/exposed_jobs/");
    const now = new Date().toISOString();
    const jobs: NormalizedJob[] = [];
    for (const j of Array.isArray(body) ? body : []) {
      if (!j.url || !j.title) continue;
      const id = String(j.url).match(/\/(\d+)\/?$/)?.[1];
      if (!id) continue;
      jobs.push({
        source: "workingnomads",
        external_id: id,
        title: j.title,
        company: j.company_name || null,
        location: j.location || null,
        remote: true,
        job_type: null,
        category: j.category_name || null,
        tags: typeof j.tags === "string" ? j.tags.split(",").map((t: string) => t.trim()).filter(Boolean) : [],
        salary_text: null,
        url: j.url,
        description_html: j.description ?? null,
        published_at: toUtcIso(j.pub_date),
        last_seen_at: now,
      });
    }
    return jobs;
  },
};

// Landing.jobs — European tech jobs (keyless, https://landing.jobs/api/v1).
// The feed has no company name; it is the first path segment after /at/ in
// the job URL. Listings stay open for months, so expired ones are dropped.
const LANDINGJOBS_PAGES = 2;

function sectionHtml(heading: string, html: string | null | undefined): string {
  return html ? `<h3>${heading}</h3>${html}` : "";
}

const landingjobs: Source = {
  name: "landingjobs",
  async fetch() {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const jobs: NormalizedJob[] = [];
    for (let page = 0; page < LANDINGJOBS_PAGES; page++) {
      const items = await getJson(
        `landingjobs (page ${page + 1})`,
        `https://landing.jobs/api/v1/jobs?limit=50&offset=${page * 50}`,
      );
      if (!Array.isArray(items) || items.length === 0) break;
      for (const j of items) {
        if (!j.id || !j.title || !j.url) continue;
        if (j.expires_at && j.expires_at < today) continue;
        const slug = String(j.url).match(/\/at\/([^/]+)\//)?.[1];
        const company = slug
          ? slug.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
          : null;
        const places: string[] = (j.locations ?? [])
          .map((l: { city?: string; country_code?: string }) => [l.city, l.country_code].filter(Boolean).join(", "))
          .filter(Boolean);
        const description =
          (j.role_description ?? "") +
          sectionHtml("Requirements", j.main_requirements) +
          sectionHtml("Nice to have", j.nice_to_have) +
          sectionHtml("Perks", j.perks);
        jobs.push({
          source: "landingjobs",
          external_id: String(j.id),
          title: j.title,
          company,
          location: places.length ? places.join("; ") : null,
          remote: typeof j.remote === "boolean" ? j.remote : null,
          job_type: j.type ?? null,
          category: null,
          tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
          salary_text: salaryRange(j.gross_salary_low, j.gross_salary_high, j.currency_code, "yearly"),
          url: j.url,
          description_html: description || null,
          published_at: toUtcIso(j.published_at),
          last_seen_at: now,
        });
      }
      if (items.length < 50) break;
    }
    return jobs;
  },
};

// Adzuna aggregator (https://developer.adzuna.com/). Free tier: 25 req/min,
// 250 req/day — country list × 2 pages × 4 runs/day stays well inside that.
const adzuna: Source = {
  name: "adzuna",
  requiredEnv: ["ADZUNA_APP_ID", "ADZUNA_APP_KEY"],
  async fetch() {
    const appId = env("ADZUNA_APP_ID")!;
    const appKey = env("ADZUNA_APP_KEY")!;
    const countries = (env("ADZUNA_COUNTRIES") ?? "de,gb,us").split(",").map((c) => c.trim());
    const now = new Date().toISOString();
    const jobs: NormalizedJob[] = [];
    for (const cc of countries) {
      for (let page = 1; page <= 2; page++) {
        const body = await getJson(
          `adzuna (${cc}, page ${page})`,
          `https://api.adzuna.com/v1/api/jobs/${cc}/search/${page}?app_id=${appId}&app_key=${appKey}&results_per_page=50&sort_by=date`,
        );
        const items = body.results ?? [];
        for (const j of items) {
          if (!j.id || !j.title || !j.redirect_url) continue;
          jobs.push({
            source: "adzuna",
            // Prefix with country: Adzuna ids are per-market.
            external_id: `${cc}:${j.id}`,
            title: j.title,
            company: j.company?.display_name ?? null,
            location: j.location?.display_name ?? null,
            remote: null,
            job_type: [j.contract_time, j.contract_type].filter(Boolean).join(", ") || null,
            category: j.category?.label ?? null,
            tags: [],
            salary_text: salaryRange(j.salary_min, j.salary_max, cc.toUpperCase(), "yearly"),
            url: j.redirect_url,
            description_html: j.description ?? null,
            published_at: toUtcIso(j.created),
            last_seen_at: now,
          });
        }
        if (items.length === 0) break;
      }
    }
    return jobs;
  },
};

// Jooble aggregator (https://jooble.org/api/about). POST with the key in the
// URL path. Search terms are configurable via JOOBLE_KEYWORDS / JOOBLE_LOCATION.
const jooble: Source = {
  name: "jooble",
  requiredEnv: ["JOOBLE_API_KEY"],
  async fetch() {
    const key = env("JOOBLE_API_KEY")!;
    const keywords = env("JOOBLE_KEYWORDS") ?? "";
    const location = env("JOOBLE_LOCATION") ?? "";
    const now = new Date().toISOString();
    const jobs: NormalizedJob[] = [];
    for (let page = 1; page <= 3; page++) {
      const body = await getJson(`jooble (page ${page})`, `https://jooble.org/api/${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords, location, page }),
      });
      const items = body.jobs ?? [];
      for (const j of items) {
        if (!j.id || !j.title || !j.link) continue;
        jobs.push({
          source: "jooble",
          external_id: String(j.id),
          title: j.title,
          company: j.company || null,
          location: j.location || null,
          remote: null,
          job_type: j.type || null,
          category: null,
          tags: [],
          salary_text: j.salary || null,
          url: j.link,
          description_html: j.snippet ?? null,
          published_at: toUtcIso(j.updated),
          last_seen_at: now,
        });
      }
      if (items.length === 0) break;
    }
    return jobs;
  },
};

// USAJOBS federal jobs (https://developer.usajobs.gov/). The User-Agent must
// be the email address the key was registered with.
const usajobs: Source = {
  name: "usajobs",
  requiredEnv: ["USAJOBS_API_KEY", "USAJOBS_EMAIL"],
  async fetch() {
    const body = await getJson(
      "usajobs",
      "https://data.usajobs.gov/api/search?ResultsPerPage=250&SortField=DatePosted&SortDirection=Desc",
      {
        headers: {
          "Authorization-Key": env("USAJOBS_API_KEY")!,
          "User-Agent": env("USAJOBS_EMAIL")!,
        },
      },
    );
    const now = new Date().toISOString();
    const jobs: NormalizedJob[] = [];
    for (const item of body.SearchResult?.SearchResultItems ?? []) {
      const d = item.MatchedObjectDescriptor;
      if (!item.MatchedObjectId || !d?.PositionTitle || !d?.PositionURI) continue;
      const pay = d.PositionRemuneration?.[0];
      jobs.push({
        source: "usajobs",
        external_id: String(item.MatchedObjectId),
        title: d.PositionTitle,
        company: d.OrganizationName ?? null,
        location: d.PositionLocationDisplay ?? null,
        remote: d.UserArea?.Details?.RemoteIndicator ?? null,
        job_type: d.PositionSchedule?.[0]?.Name ?? null,
        category: d.JobCategory?.[0]?.Name ?? null,
        tags: [],
        salary_text: pay
          ? salaryRange(Number(pay.MinimumRange), Number(pay.MaximumRange), "USD", pay.RateIntervalCode)
          : null,
        url: d.PositionURI,
        description_html: d.UserArea?.Details?.JobSummary ?? null,
        published_at: toUtcIso(d.PublicationStartDate),
        last_seen_at: now,
      });
    }
    return jobs;
  },
};

// The Muse was removed: its public API (themuse.com/api/public/jobs) has
// returned 404 since late October 2026.
const SOURCES: Source[] = [
  remotive,
  arbeitnow,
  jobsuche,
  jobicy,
  remoteok,
  himalayas,
  workingnomads,
  landingjobs,
  adzuna,
  jooble,
  usajobs,
];

// A job can appear on two pages of the same fetch (listings shift between
// page requests); duplicate keys in one upsert batch make Postgres error with
// "cannot affect row a second time", so keep only the last occurrence.
function dedupeByExternalId<T extends { external_id: string }>(rows: T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) byId.set(row.external_id, row);
  return [...byId.values()];
}

async function upsertChunked(table: string, rows: object[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase
      .from(table)
      .upsert(rows.slice(i, i + 100), { onConflict });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
  }
}

// A run still at 'running' this long after it started was killed by the
// platform (no catch block ran). Real runs finish inside RUN_BUDGET_MS.
const STUCK_RUN_MINUTES = 10;

async function expireStuckRuns() {
  const cutoff = new Date(Date.now() - STUCK_RUN_MINUTES * 60_000).toISOString();
  const { error } = await supabase
    .from("pipeline_runs")
    .update({
      status: "error",
      finished_at: new Date().toISOString(),
      error: "timed out (run never finished)",
    })
    .eq("status", "running")
    .lt("started_at", cutoff);
  if (error) console.error(`expireStuckRuns: ${error.message}`);
}

async function finishRun(runId: number, fields: Record<string, unknown>) {
  const { error } = await supabase
    .from("pipeline_runs")
    .update({ finished_at: new Date().toISOString(), ...fields })
    .eq("id", runId);
  if (error) console.error(`pipeline_runs update ${runId}: ${error.message}`);
}

// Fetch + upsert one source, logged as one pipeline_runs row. Sources run
// concurrently, so a slow or failing source can never starve the others.
async function runSource(source: Source): Promise<Record<string, unknown>> {
  const { data: run, error: runError } = await supabase
    .from("pipeline_runs")
    .insert({ source: source.name })
    .select("id")
    .single();
  if (runError) return { source: source.name, status: "error", error: `pipeline_runs insert: ${runError.message}` };

  try {
    const fetched = await source.fetch();
    const jobs = dedupeByExternalId(fetched);
    await upsertChunked("jobs", jobs, "source,external_id");
    const counts = { jobs_fetched: fetched.length, jobs_upserted: jobs.length };
    await finishRun(run.id, { status: "success", ...counts });
    return { source: source.name, status: "success", ...counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(run.id, { status: "error", error: message });
    return { source: source.name, status: "error", error: message };
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// GET/POST /ingest-jobs               fetch + upsert every source
//          /ingest-jobs?source=name   one source only
//          /ingest-jobs?mode=enrich   enrichment only (no fetch, no run row);
//                                     called by cron every 10 minutes
Deno.serve(async (req: Request) => {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const url = new URL(req.url);
  const only = url.searchParams.get("source");
  const sources = only ? SOURCES.filter((s) => s.name === only) : SOURCES;
  if (sources.length === 0) return json({ error: `unknown source: ${only}` }, 400);

  if (url.searchParams.get("mode") === "enrich") {
    const results = [];
    for (const source of sources) {
      if (!source.enrich) continue;
      try {
        results.push({ source: source.name, status: "success", jobs_enriched: await source.enrich(deadline) });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`enrich ${source.name}: ${error}`);
        results.push({ source: source.name, status: "error", error });
      }
    }
    return json({ results }, results.every((r) => r.status !== "error") ? 200 : 500);
  }

  await expireStuckRuns();

  const results: Record<string, unknown>[] = [];
  const runnable: Source[] = [];
  for (const source of sources) {
    const missing = (source.requiredEnv ?? []).filter((name) => !env(name));
    if (missing.length > 0) {
      results.push({ source: source.name, status: "skipped", missing_env: missing });
    } else {
      runnable.push(source);
    }
  }

  results.push(...(await Promise.all(runnable.map(runSource))));

  return json({ results }, results.every((r) => r.status !== "error") ? 200 : 500);
});
