// German CV (Lebenslauf) + cover letter (Anschreiben) generation via OpenRouter
// free models. REST API only — no SDK dependency. Server-side only: the API key
// must never reach the browser.
//
// The model returns the structured schema from cv-types, not prose; layout and
// DIN 5008 formatting are the renderer's job.
//
// Applicant PII never reaches the model: the prompt carries `{{PII_*}}` tokens
// and the real values are restored here (see cv-privacy). Anything in this file
// that reads a personal field must therefore run AFTER restoreDocs.

import { normalizeDocs, ShapeError, type GeneratedDocs } from "./cv-types";
import {
  PII_PROMPT_NOTE,
  redactCandidate,
  redactFreeText,
  restoreDocs,
  type PiiMap,
} from "./cv-privacy";

export type { GeneratedDocs };

/**
 * Set Ort and Datum ourselves. The model often omits them, costing the
 * Lebenslauf its signature block and the Anschreiben the date line DIN 5008
 * requires — but the bigger problem is when it supplies them: it cannot know
 * today's date, and in practice it copies the example date out of SCHEMA_RULES
 * (a document dated three days ago went out under exactly this bug).
 *
 * So the date is always ours, and the place is ours whenever the address gives
 * us one. Only when there is no address to derive from does the model's value
 * stand.
 */
function applyPlaceAndDate(docs: GeneratedDocs): GeneratedDocs {
  // SYSTEM_RULES tells the model to emit "[Datum]" style placeholders for
  // unknown fields, so a missing value arrives as a non-empty string.
  const real = (v?: string) =>
    v && !/^\[[^\]]*\]$/.test(v.trim()) ? v : undefined;

  const today = new Date().toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  // "Musterstraße 12, 10115 Berlin" -> "Berlin"; also handles a bare "10115
  // Berlin" and an address with no postal code at all.
  const address = real(docs.lebenslauf.persoenlicheDaten.adresse) ?? "";
  const lastPart = address.split(",").pop()?.trim() ?? "";
  const city = lastPart.replace(/^\d{4,5}\s+/, "").trim();

  const ort = city || undefined;

  return {
    lebenslauf: {
      ...docs.lebenslauf,
      ort: ort ?? real(docs.lebenslauf.ort),
      datum: today,
    },
    anschreiben: {
      ...docs.anschreiben,
      ort: ort ?? real(docs.anschreiben.ort),
      datum: today,
    },
  };
}

/**
 * Overwrite the identity block with the values the applicant actually typed.
 *
 * Same reasoning as applyPlaceAndDate — these are facts we hold, so there is no
 * reason to depend on the model for them — but here it also makes the
 * pseudonymization safe: if a model drops or mangles a `{{PII_*}}` token, the
 * field is restored from the form rather than lost. Only the form path can do
 * this; a reformatted upload has no structured input to trust.
 */
function applyKnownFacts(docs: GeneratedDocs, c: CandidateInput): GeneratedDocs {
  const keep = (real: string | undefined, generated?: string) =>
    real?.trim() || generated;

  const p = docs.lebenslauf.persoenlicheDaten;
  const lines = (v?: string) =>
    (v ?? "").split(",").map((l) => l.trim()).filter(Boolean);

  const address = c.address?.trim();
  // "Musterstraße 1, 10115 Berlin" -> two lines, which is what DIN 5008 wants.
  const senderLines = address
    ? [...lines(address), c.phone?.trim(), c.email?.trim()].filter(
        (l): l is string => Boolean(l),
      )
    : undefined;

  // The recipient block is ours to build too. Beyond correctness, it closes a
  // hole the tokens opened: a model told about `{{PII_*}}` will occasionally
  // invent one of its own (`{{PII_ADRESSE_FIRMA}}` was observed here), and
  // stripTokens would then delete the company address rather than print
  // scaffolding. We know the employer, so we never have to depend on it.
  const recipientLines = c.company?.trim()
    ? [c.company.trim(), c.contactPerson?.trim(), ...lines(c.companyAddress)].filter(
        (l): l is string => Boolean(l),
      )
    : undefined;

  return {
    lebenslauf: {
      ...docs.lebenslauf,
      persoenlicheDaten: {
        name: keep(c.fullName, p.name) ?? p.name,
        adresse: keep(c.address, p.adresse),
        telefon: keep(c.phone, p.telefon),
        email: keep(c.email, p.email),
        geburtsdatum: keep(c.birthDate, p.geburtsdatum),
        geburtsort: keep(c.birthPlace, p.geburtsort),
        staatsangehoerigkeit: keep(c.nationality, p.staatsangehoerigkeit),
      },
    },
    anschreiben: {
      ...docs.anschreiben,
      absender: {
        name: keep(c.fullName, docs.anschreiben.absender.name) ?? "",
        zeilen: senderLines ?? docs.anschreiben.absender.zeilen,
      },
      empfaenger: {
        zeilen: recipientLines ?? docs.anschreiben.empfaenger.zeilen,
      },
      unterschrift: keep(c.fullName, docs.anschreiben.unterschrift) ?? "",
    },
  };
}

export interface CandidateInput {
  // Personal
  fullName: string;
  address?: string;
  phone?: string;
  email?: string;
  birthDate?: string; // e.g. "15.03.2007"
  birthPlace?: string;
  nationality?: string;
  // Target
  ausbildungTitle: string; // e.g. "Kaufmann im Einzelhandel"
  company?: string;
  companyAddress?: string;
  contactPerson?: string; // e.g. "Frau Müller" — for the salutation
  startDate?: string; // e.g. "September 2027"
  // Background (free text — the model structures it)
  education?: string; // schools, degrees, grades
  experience?: string; // jobs, internships (Praktika)
  skills?: string; // IT, other Kenntnisse
  languages?: string; // e.g. "Deutsch (B2), Englisch (fließend), Arabisch (Muttersprache)"
  hobbies?: string;
  motivation?: string; // why this Ausbildung / this company — free text
}

const SYSTEM_RULES = `Du bist ein Experte für deutsche Bewerbungsunterlagen für Ausbildungsstellen.
Du erstellst tadellose, kulturell korrekte deutsche Lebensläufe und Anschreiben.

STRIKTE REGELN FÜR DEN LEBENSLAUF (tabellarisch, umgekehrt chronologisch — neueste zuerst):
- Abschnitte in dieser Reihenfolge: "Persönliche Daten", "Schulbildung", "Praktika / Berufserfahrung" (nur wenn vorhanden), "Kenntnisse", "Sprachen", "Hobbys" (optional).
- KEIN "Karriereziel"- oder "Objective"-Abschnitt (das ist amerikanisch, in Deutschland unüblich).
- Persönliche Daten: Name, Adresse, Telefon, E-Mail, Geburtsdatum und -ort, Staatsangehörigkeit. Familienstand nur wenn angegeben (freiwillig wegen AGG).
- Datumsformat: TT.MM.JJJJ oder "Monat JJJJ". Zeiträume z. B. "09/2023 – 07/2026".
- Am Ende: "Ort, Datum" und Platz für die Unterschrift.
- Maximal 1–2 Seiten, sachlich, keine Übertreibungen.

STRIKTE REGELN FÜR DAS ANSCHREIBEN (DIN 5008):
- Betreffzeile OHNE das Wort "Betreff:". Nennt die konkrete Ausbildungsstelle.
- Anrede: "Sehr geehrte Frau [Name]," / "Sehr geehrter Herr [Name]," oder "Sehr geehrte Damen und Herren," wenn kein Name.
- 3–4 prägnante Absätze: (1) Motivation & Bezug zur Stelle, (2) schulische Stärken & relevante Erfahrung, (3) warum genau DIESE Firma, (4) Schlusssatz mit Gesprächswunsch.
- Abschluss: "Mit freundlichen Grüßen", dann Name.
- Formell, motiviert, authentisch — deutsche Personaler legen bei Azubis großen Wert auf Motivation. Keine Floskeln, keine Übertreibung.

Das Layout (Seitenränder, Blocksatz, rechtsbündiges Datum, fette Betreffzeile) wird
NICHT von dir erzeugt — du lieferst nur die strukturierten Inhalte. Schreibe daher
keine Sternchen, Bindestrich-Linien oder sonstige Textformatierung in die Felder.

Schreibe fehlerfrei auf Deutsch. Erfinde KEINE Fakten, die nicht in den Angaben stehen. Wenn Angaben fehlen, lasse den Platzhalter in eckigen Klammern, z. B. [Adresse].`;

// The output contract. Prose is unusable downstream — it cannot be laid out to
// DIN 5008, edited field-by-field, or exported — so the model fills a schema
// instead and all formatting happens in the renderer.
const SCHEMA_RULES = `Antworte AUSSCHLIESSLICH mit einem JSON-Objekt in exakt dieser Struktur.
Keine Markdown-Codeblöcke, kein Text davor oder danach.

{
  "lebenslauf": {
    "persoenlicheDaten": {
      "name": "Max Mustermann",
      "adresse": "Musterstraße 1, 10115 Berlin",
      "telefon": "+49 170 1234567",
      "email": "max@example.com",
      "geburtsdatum": "15.03.2007",
      "geburtsort": "Tunis",
      "staatsangehoerigkeit": "tunesisch"
    },
    "abschnitte": [
      {
        "titel": "Schulbildung",
        "eintraege": [
          {
            "von": "09/2023",
            "bis": "07/2026",
            "titel": "Allgemeine Hochschulreife (Note 2,1)",
            "organisation": "Goethe-Gymnasium",
            "ort": "Berlin",
            "details": ["Leistungskurse: Mathematik, Englisch"]
          }
        ]
      }
    ],
    "ort": "Berlin",
    "datum": "24.07.2026"
  },
  "anschreiben": {
    "absender": { "name": "Max Mustermann", "zeilen": ["Musterstraße 1", "10115 Berlin", "+49 170 1234567"] },
    "empfaenger": { "zeilen": ["Lidl Dienstleistung GmbH", "Frau Müller", "Musterallee 5", "10117 Berlin"] },
    "ort": "Berlin",
    "datum": "24.07.2026",
    "betreff": "Bewerbung um einen Ausbildungsplatz als Kaufmann im Einzelhandel ab September 2027",
    "anrede": "Sehr geehrte Frau Müller,",
    "absaetze": ["Absatz 1 ...", "Absatz 2 ...", "Absatz 3 ..."],
    "gruss": "Mit freundlichen Grüßen",
    "unterschrift": "Max Mustermann"
  }
}

WICHTIG:
- "abschnitte" ist ein Array von Objekten, niemals ein String.
- "details" und "absaetze" sind immer Arrays von Strings (leeres Array wenn nichts).
- Für "Kenntnisse", "Sprachen" und "Hobbys": ein Eintrag pro Punkt, jeweils mit "titel" (z. B. "Deutsch") und optional "details" (z. B. ["Niveau B2"]). "von"/"bis" bleiben dort leer.
- Lasse ein Feld weg oder setze es auf "", wenn keine Angabe vorliegt — erfinde nichts.`;

function buildUserPrompt(c: CandidateInput): string {
  const lines: string[] = [];
  const add = (label: string, val?: string) => {
    if (val && val.trim()) lines.push(`${label}: ${val.trim()}`);
  };
  add("Vollständiger Name", c.fullName);
  add("Adresse", c.address);
  add("Telefon", c.phone);
  add("E-Mail", c.email);
  add("Geburtsdatum", c.birthDate);
  add("Geburtsort", c.birthPlace);
  add("Staatsangehörigkeit", c.nationality);
  add("Angestrebte Ausbildung", c.ausbildungTitle);
  add("Firma", c.company);
  add("Firmenadresse", c.companyAddress);
  add("Ansprechpartner", c.contactPerson);
  add("Ausbildungsbeginn", c.startDate);
  add("Schulbildung / Noten", c.education);
  add("Praktika / Berufserfahrung", c.experience);
  add("Kenntnisse", c.skills);
  add("Sprachen", c.languages);
  add("Hobbys", c.hobbies);
  add("Motivation (Stichpunkte)", c.motivation);

  return `Erstelle aus diesen Angaben (a) einen tabellarischen Lebenslauf und (b) ein Anschreiben.

ANGABEN:
${lines.join("\n")}

${PII_PROMPT_NOTE}

${SCHEMA_RULES}`;
}

export interface ChatMessage {
  role: string;
  content: string;
}

/**
 * Exactly what goes on the wire, exported so a test can assert on it. The
 * pseudonymization guarantee is only meaningful at this boundary: checking the
 * redactor in isolation proves nothing about what the prompt actually carries.
 */
export function buildGenerateMessages(c: CandidateInput): {
  messages: ChatMessage[];
  map: PiiMap;
} {
  const { redacted, map } = redactCandidate(c);
  return {
    map,
    messages: [
      { role: "system", content: SYSTEM_RULES },
      { role: "user", content: buildUserPrompt(redacted) },
    ],
  };
}

export async function generateGermanDocs(
  c: CandidateInput,
  signal?: AbortSignal,
): Promise<GeneratedDocs> {
  // The model is given tokens, never the applicant's identity.
  const { messages, map } = buildGenerateMessages(c);

  const docs = await callModels(messages, signal);

  // Order matters: restore first, because applyKnownFacts and applyPlaceAndDate
  // both read personal fields (the latter derives Ort from the address, which is
  // still a token until now).
  return applyPlaceAndDate(applyKnownFacts(restoreDocs(docs, map), c));
}

// Reformat an existing CV/cover letter (any language/format) into proper German
// Ausbildung documents. Optionally target a specific Ausbildung/company.
//
// PII caveat: an upload is unstructured, so only contact details (email,
// phone) can be tokenized with enough precision to be safe — see redactFreeText.
// The applicant's *name* inside a pasted CV cannot be found reliably without
// NER and is therefore still sent to the model. The form path above has no such
// gap; prefer it where the choice exists.
export async function reformatToGerman(
  existingText: string,
  target?: { ausbildungTitle?: string; company?: string; contactPerson?: string },
  signal?: AbortSignal,
): Promise<GeneratedDocs> {
  const t: string[] = [];
  if (target?.ausbildungTitle) t.push(`Angestrebte Ausbildung: ${target.ausbildungTitle}`);
  if (target?.company) t.push(`Firma: ${target.company}`);
  if (target?.contactPerson) t.push(`Ansprechpartner: ${target.contactPerson}`);

  // Truncate first, then redact, so a token can never be cut in half.
  const { redacted, map } = redactFreeText(existingText.slice(0, 12000));

  const prompt = `Hier ist ein bestehender Lebenslauf / eine bestehende Bewerbung (evtl. in einer anderen Sprache oder einem anderen Format).
Wandle die Informationen in einen korrekten deutschen tabellarischen Lebenslauf UND ein passendes Anschreiben nach deutschen Standards um.
Übersetze bei Bedarf ins Deutsche. Behalte nur echte Fakten aus dem Original — erfinde nichts. Fehlende Pflichtangaben als [Platzhalter] markieren.
${t.length ? "\nZIEL:\n" + t.join("\n") + "\n" : ""}
BESTEHENDE UNTERLAGEN:
"""
${redacted}
"""

${PII_PROMPT_NOTE}

${SCHEMA_RULES}`;

  const docs = await callModels(
    [
      { role: "system", content: SYSTEM_RULES },
      { role: "user", content: prompt },
    ],
    signal,
  );

  return applyPlaceAndDate(restoreDocs(docs, map));
}

// A single free model gets this long before we give up and try the next one.
// Free-tier models occasionally hang open indefinitely; without this the whole
// request rides until the platform kills it and the user just sees a 504.
//
// Sizing measured against the live free tier with a full structured-CV prompt:
// response headers land in 1–3s but the body takes 37s (nemotron-3-super) to
// 68s (gpt-oss-20b), because the model is still generating while OpenRouter
// holds the connection open with whitespace padding. An earlier 25s ceiling
// aborted every real generation mid-body. Keep this above ~70s.
const PER_MODEL_TIMEOUT_MS = 75_000;
// Total wall-clock budget for the fallback chain. Must stay comfortably under
// the route's `maxDuration` so we can still return a real error message.
const TOTAL_BUDGET_MS = 150_000;
const DEFAULT_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Shared OpenRouter caller: tries free models in order, falls through on
// rate-limit/timeout/error, parses the JSON {lebenslauf, anschreiben} response.
// `signal` is the caller's request signal — if the browser disconnects we stop
// burning quota on a response nobody will read.
async function callModels(
  messages: { role: string; content: string }[],
  signal?: AbortSignal,
): Promise<GeneratedDocs> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not configured");

  // Read per call, not at module scope: an override set after import (tests, or
  // a self-hosted OpenAI-compatible gateway) must still take effect.
  const apiUrl = process.env.OPENROUTER_BASE_URL ?? DEFAULT_API_URL;

  // Order is by measured reliability on the structured-CV prompt (2026-07-27,
  // one sample each — treat as a starting point, not gospel):
  //   ultra-550b   25s, valid            <- fastest AND most reliable
  //   super-120b   34-51s, ~1 in 3 comes back with the Anschreiben nested in
  //                the Lebenslauf or the JSON truncated mid-object
  //   laguna-xs    63s, valid
  //   gemma-4-31b  429s constantly
  //   gpt-oss-20b  429s constantly, 68-119s when it does answer
  // Breadth matters more than order: the chain fails as a whole only when every
  // entry fails, and free endpoints rate-limit independently of each other.
  const models = (process.env.OPENROUTER_MODELS ??
    "nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3-super-120b-a12b:free,poolside/laguna-xs-2.1:free,google/gemma-4-31b-it:free,openai/gpt-oss-20b:free")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastErr = "";

  // Every attempt is recorded, not just the last one: when the whole chain
  // fails, "gpt-oss timed out" alone hides whether the models before it were
  // rate-limited, malformed, or never tried. The elapsed time is what tells
  // those apart in the logs.
  const attempts: string[] = [];
  const started = Date.now();
  const fail = (msg: string) => {
    lastErr = msg;
    attempts.push(`${msg} (+${((Date.now() - started) / 1000).toFixed(1)}s)`);
    console.warn("CV model attempt failed:", attempts[attempts.length - 1]);
  };

  for (const model of models) {
    // Never start an attempt we have no time to finish.
    const remaining = deadline - Date.now();
    if (remaining < 5_000) {
      fail(`${model} not attempted: time budget exhausted`);
      break;
    }

    const timeout = AbortSignal.timeout(Math.min(PER_MODEL_TIMEOUT_MS, remaining));
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.6,
          // Structured JSON carries far more overhead than the prose it
          // replaced; 4096 truncated mid-object and lost the whole response.
          max_tokens: 8192,
          response_format: { type: "json_object" },
        }),
        signal: attemptSignal,
      });
    } catch (e) {
      // The caller going away is fatal — don't fall through to the next model.
      if (signal?.aborted) throw new Error("client disconnected");
      fail(
        e instanceof Error && e.name === "TimeoutError"
          ? `${model} timed out`
          : `${model} network error: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }

    if (res.status === 429) {
      fail(`${model} rate-limited`);
      continue; // try next free model
    }
    if (!res.ok) {
      fail(`${model} error ${res.status}: ${(await res.text()).slice(0, 200)}`);
      continue;
    }

    // The body is read under the same signal as the request: OpenRouter returns
    // headers almost immediately and then holds the connection open — padding it
    // with whitespace — while the model generates. So the real wait happens
    // here, and an abort during this read is a timeout, not a parse failure.
    let text: string | undefined;
    try {
      const data = await res.json();
      text = data?.choices?.[0]?.message?.content;
    } catch (e) {
      if (signal?.aborted) throw new Error("client disconnected");
      const timedOut =
        e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      fail(
        timedOut
          ? `${model} timed out while streaming the response`
          : `${model} response body was not JSON`,
      );
      continue;
    }
    if (!text) {
      fail(`${model} returned no content`);
      continue;
    }

    // Some models wrap JSON in ```json fences — strip them defensively.
    let s = text.trim();
    if (s.startsWith("```")) {
      s = s.replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
    }

    let raw: unknown;
    try {
      raw = JSON.parse(s);
    } catch {
      fail(`${model} returned malformed JSON`);
      continue;
    }

    try {
      // Coerces the ragged shapes free models produce; throws only when the
      // result is too thin to show, in which case the next model gets a turn.
      // Still tokenized here — the caller restores PII and applies known facts.
      return normalizeDocs(raw);
    } catch (e) {
      fail(
        e instanceof ShapeError
          ? `${model} bad shape: ${e.message}`
          : `${model} normalization failed`,
      );
    }
  }

  throw new Error(
    `All models failed. Last: ${lastErr}. Attempts: ${attempts.join(" | ")}`,
  );
}
