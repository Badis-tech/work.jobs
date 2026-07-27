// Pseudonymization of applicant PII before it leaves the server.
//
// The generator runs on OpenRouter's `:free` endpoints, and free endpoints are
// free partly because their data policy permits prompt logging and training.
// A Bewerbung is about the most identifying document a person owns — name, home
// address, phone, birth date, nationality — and none of it is needed to *write*
// German prose. So we replace it with sentinel tokens on the way out and put the
// real values back on the way in. The model shapes the document; it never sees
// who the document is about.
//
// Token format is `{{PII_NAME}}`, deliberately unlike the `[Adresse]` style
// SYSTEM_RULES tells the model to emit for *missing* data. Single brackets are
// ambiguous — `[Adresse]` coming back could mean either "redacted" or "the
// applicant never gave one", and those need opposite handling downstream.

export type PiiMap = Record<string, string>;

/** Identity fields redacted from the candidate form. */
export type PiiField =
  | "NAME"
  | "ADRESSE"
  | "TELEFON"
  | "EMAIL"
  | "GEBURTSDATUM"
  | "GEBURTSORT"
  | "STAATSANGEHOERIGKEIT"
  | "KONTAKT";

export function piiToken(field: string): string {
  return `{{PII_${field}}}`;
}

/**
 * Instruction appended to the prompt so the model treats tokens as opaque.
 * Without it models "helpfully" translate or expand them.
 */
export const PII_PROMPT_NOTE = `WICHTIG — PLATZHALTER: Werte in doppelten geschweiften Klammern (z. B. {{PII_NAME}}, {{PII_ADRESSE}}) sind Platzhalter für echte, geschützte Daten.
Gib sie IMMER unverändert und exakt so zurück, wie sie hier stehen — nicht übersetzen, nicht ausschreiben, nicht raten, nicht weglassen.
Sie stehen für vorhandene Angaben: behandle sie NICHT als fehlend.
ERFINDE KEINE NEUEN Platzhalter dieser Art. Verwende ausschließlich die oben aufgeführten. Alle übrigen Angaben (z. B. Firmenname und Firmenadresse) schreibst du normal aus.`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tolerant matcher for one token. Models reformat whitespace, change case, and
 * occasionally drop the braces entirely, so accept all of that rather than
 * leaking a raw `PII_TELEFON` into a finished PDF.
 */
function tokenPattern(field: string): RegExp {
  const f = escapeRegExp(field);
  return new RegExp(
    `\\{\\{\\s*PII[_\\s-]*${f}\\s*\\}\\}|(?<![\\p{L}\\p{N}_])PII[_\\s-]*${f}(?![\\p{L}\\p{N}_])`,
    "giu",
  );
}

/** Word-ish boundaries that work for umlauts, which `\b` does not. */
function literalPattern(literal: string): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(literal)}(?![\\p{L}\\p{N}])`,
    "giu",
  );
}

/** Honorifics kept in the clear: the model needs them to pick the salutation. */
const HONORIFIC = /^((?:(?:Frau|Herr|Herrn|Dr\.?|Prof\.?|Dipl\.-?\w*)\s+)+)/i;

// --- outbound: real values -> tokens --------------------------------------

interface Redactor {
  map: PiiMap;
  /** Replace a whole field value with its token. */
  field: (field: PiiField, value?: string) => string | undefined;
  /** Scrub any redacted value that also appears inside free text. */
  scrub: (text?: string) => string | undefined;
}

function createRedactor(): Redactor {
  const map: PiiMap = {};
  // Literal -> token, applied to free text. Longest first so that a value
  // containing another (an address containing the birth city) wins.
  const literals: { literal: string; token: string }[] = [];

  const remember = (literal: string, token: string) => {
    const v = literal.trim();
    // Two characters is not identifying and matches far too much German text.
    if (v.length < 3) return;
    if (literals.some((l) => l.literal.toLowerCase() === v.toLowerCase())) return;
    literals.push({ literal: v, token });
  };

  return {
    map,
    field(field, value) {
      const v = value?.trim();
      if (!v) return undefined;
      const token = piiToken(field);
      map[token] = v;
      remember(v, token);
      // Names arrive whole but appear in prose in parts ("Ich, Youssef, ...").
      if (field === "NAME") {
        for (const part of v.split(/\s+/)) remember(part, token);
      }
      return token;
    },
    scrub(text) {
      if (!text) return text;
      let out = text;
      for (const { literal, token } of [...literals].sort(
        (a, b) => b.literal.length - a.literal.length,
      )) {
        out = out.replace(literalPattern(literal), token);
      }
      return out;
    },
  };
}

export interface RedactedCandidate<T> {
  redacted: T;
  map: PiiMap;
}

/**
 * Strip identity fields out of the candidate form. Everything the model needs
 * to actually write — the Ausbildung, the company, schooling, motivation — is
 * passed through untouched, minus any identity value quoted inside it.
 *
 * The employer's address is deliberately NOT redacted: it is business contact
 * data, and the letter's address block has to be literally correct. The contact
 * person's surname IS redacted, but their honorific is not, so the model can
 * still choose "Sehr geehrte Frau" over "Sehr geehrter Herr".
 */
export function redactCandidate<
  T extends {
    fullName: string;
    address?: string;
    phone?: string;
    email?: string;
    birthDate?: string;
    birthPlace?: string;
    nationality?: string;
    contactPerson?: string;
    education?: string;
    experience?: string;
    skills?: string;
    languages?: string;
    hobbies?: string;
    motivation?: string;
  },
>(c: T): RedactedCandidate<T> {
  const r = createRedactor();

  const fullName = r.field("NAME", c.fullName) ?? c.fullName;
  const address = r.field("ADRESSE", c.address);
  const phone = r.field("TELEFON", c.phone);
  const email = r.field("EMAIL", c.email);
  const birthDate = r.field("GEBURTSDATUM", c.birthDate);
  const birthPlace = r.field("GEBURTSORT", c.birthPlace);
  const nationality = r.field("STAATSANGEHOERIGKEIT", c.nationality);

  let contactPerson = c.contactPerson?.trim() || undefined;
  if (contactPerson) {
    const honorific = contactPerson.match(HONORIFIC)?.[1] ?? "";
    const rest = contactPerson.slice(honorific.length).trim();
    const token = rest ? r.field("KONTAKT", rest) : undefined;
    contactPerson = token ? `${honorific}${token}`.trim() : contactPerson;
  }

  return {
    map: r.map,
    redacted: {
      ...c,
      fullName,
      address,
      phone,
      email,
      birthDate,
      birthPlace,
      nationality,
      contactPerson,
      // Free text the applicant wrote themselves routinely repeats their own
      // name and town; scrub those occurrences too or the redaction is theatre.
      education: r.scrub(c.education),
      experience: r.scrub(c.experience),
      skills: r.scrub(c.skills),
      languages: r.scrub(c.languages),
      hobbies: r.scrub(c.hobbies),
      motivation: r.scrub(c.motivation),
    },
  };
}

// An uploaded CV is unstructured, so only high-precision patterns are safe: a
// false positive silently corrupts the document, which is worse than a miss.
// Names in free text need real NER and are NOT covered here — see the note in
// reformatToGerman.
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu;
// Only an explicit `+` prefix or an explicit label. A bare digit run cannot be
// told apart from "09/2023 - 07/2026" or a postal code.
const INTL_PHONE_RE = /\+\d[\d\s/().-]{7,}\d/g;
const LABELLED_PHONE_RE =
  /(?<=(?:tel|telefon|mobil|handy|phone|mobile)\.?\s*:?\s*)[+\d][\d\s/().-]{6,}\d/gi;

/**
 * Best-effort redaction for the "reformat my existing CV" path. Returns the
 * text with contact details tokenized, plus the map needed to restore them.
 */
export function redactFreeText(text: string): { redacted: string; map: PiiMap } {
  const map: PiiMap = {};
  let n = 0;
  const take = (kind: string, value: string): string => {
    const existing = Object.entries(map).find(([, v]) => v === value);
    if (existing) return existing[0];
    const token = piiToken(`${kind}_${++n}`);
    map[token] = value;
    return token;
  };

  const redacted = text
    .replace(EMAIL_RE, (m) => take("EMAIL", m))
    .replace(INTL_PHONE_RE, (m) => take("TELEFON", m.trim()))
    .replace(LABELLED_PHONE_RE, (m) => take("TELEFON", m.trim()));

  return { redacted, map };
}

// --- inbound: tokens -> real values ---------------------------------------

/** Put every real value back. Unknown tokens are left alone for `stripTokens`. */
export function restoreText(s: string, map: PiiMap): string {
  let out = s;
  for (const [token, value] of Object.entries(map)) {
    const field = token.slice("{{PII_".length, -"}}".length);
    out = out.replace(tokenPattern(field), value);
  }
  return out;
}

/**
 * Remove any token the model invented or mangled beyond recognition, so a
 * finished document can never display scaffolding. Runs after restoreText.
 */
export function stripTokens(s: string): string {
  return s.replace(/\{\{\s*PII[_\s-][^}]*\}\}/giu, "").replace(/ {2,}/g, " ").trim();
}

/** Deep-map every string in a JSON-shaped value, preserving its structure. */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn);
    return out as T;
  }
  return value;
}

/** Restore every token across a whole generated document set. */
export function restoreDocs<T>(docs: T, map: PiiMap): T {
  return mapStrings(docs, (s) => stripTokens(restoreText(s, map)));
}
