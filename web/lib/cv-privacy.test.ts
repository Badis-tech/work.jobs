// Run with `npm test`. These are the guarantees the pseudonymization makes, and
// a regression here silently ships applicant PII to a third-party model that is
// allowed to log and train on it — so this file is the reason to keep a test
// runner in a project that otherwise has none.

import test from "node:test";
import assert from "node:assert/strict";

import {
  redactCandidate,
  redactFreeText,
  restoreDocs,
  restoreText,
  stripTokens,
} from "./cv-privacy.ts";

const candidate = {
  fullName: "Youssef Ben Ali",
  address: "Musterstraße 12, 10115 Berlin",
  phone: "+49 170 1234567",
  email: "youssef@example.com",
  birthDate: "15.03.2007",
  birthPlace: "Tunis",
  nationality: "tunesisch",
  contactPerson: "Frau Müller",
  ausbildungTitle: "Kaufmann im Einzelhandel",
  company: "Lidl Dienstleistung GmbH",
  education: "Goethe-Gymnasium Berlin, Abitur 2026",
  motivation:
    "Ich, Youssef, arbeite gern im Team. Erreichbar unter youssef@example.com.",
};

test("identity fields are replaced by tokens", () => {
  const { redacted } = redactCandidate(candidate);
  assert.equal(redacted.fullName, "{{PII_NAME}}");
  assert.equal(redacted.address, "{{PII_ADRESSE}}");
  assert.equal(redacted.phone, "{{PII_TELEFON}}");
  assert.equal(redacted.email, "{{PII_EMAIL}}");
  assert.equal(redacted.birthDate, "{{PII_GEBURTSDATUM}}");
  assert.equal(redacted.nationality, "{{PII_STAATSANGEHOERIGKEIT}}");
});

test("no identity value survives anywhere in the outgoing prompt", () => {
  const { redacted } = redactCandidate(candidate);
  const wire = JSON.stringify(redacted);
  for (const leak of [
    "Youssef",
    "Ben Ali",
    "Musterstraße",
    "10115",
    "1234567",
    "youssef@example.com",
    "15.03.2007",
    "Müller",
  ]) {
    assert.ok(!wire.includes(leak), `leaked ${leak} in ${wire}`);
  }
});

test("free text keeps its meaning while losing the name", () => {
  const { redacted } = redactCandidate(candidate);
  assert.equal(
    redacted.motivation,
    "Ich, {{PII_NAME}}, arbeite gern im Team. Erreichbar unter {{PII_EMAIL}}.",
  );
  // The school and city are not identity fields — the model needs them to write.
  assert.ok(redacted.education?.includes("Goethe-Gymnasium"));
});

test("the salutation honorific stays readable, the surname does not", () => {
  // Otherwise the model cannot choose "Sehr geehrte Frau" over "Sehr geehrter Herr".
  const { redacted } = redactCandidate(candidate);
  assert.equal(redacted.contactPerson, "Frau {{PII_KONTAKT}}");
});

test("short values are not scrubbed out of unrelated words", () => {
  const { redacted } = redactCandidate({
    ...candidate,
    birthPlace: "Ulm",
    motivation: "Ich bin ein Teamplayer und wohne in Ulmen.",
  });
  assert.ok(redacted.motivation?.includes("Ulmen"));
});

test("round trip restores every value and preserves structure", () => {
  const { redacted, map } = redactCandidate(candidate);
  const docs = {
    lebenslauf: {
      persoenlicheDaten: {
        name: redacted.fullName,
        adresse: redacted.address,
        telefon: redacted.phone,
      },
      abschnitte: [
        { titel: "Schulbildung", eintraege: [{ titel: "Abitur", details: [] }] },
      ],
    },
    anschreiben: {
      anrede: `Sehr geehrte ${redacted.contactPerson},`,
      absaetze: [`Mein Name ist ${redacted.fullName}.`],
      unterschrift: redacted.fullName,
    },
  };

  const out = restoreDocs(docs, map);
  assert.equal(out.lebenslauf.persoenlicheDaten.name, "Youssef Ben Ali");
  assert.equal(
    out.lebenslauf.persoenlicheDaten.adresse,
    "Musterstraße 12, 10115 Berlin",
  );
  assert.equal(out.anschreiben.anrede, "Sehr geehrte Frau Müller,");
  assert.equal(out.anschreiben.absaetze[0], "Mein Name ist Youssef Ben Ali.");
  assert.equal(out.lebenslauf.abschnitte[0].titel, "Schulbildung");
});

test("tokens the model mangled still restore", () => {
  const { map } = redactCandidate(candidate);
  assert.equal(restoreText("{{ pii_name }}", map), "Youssef Ben Ali");
  assert.equal(restoreText("{{PII NAME}}", map), "Youssef Ben Ali");
  assert.equal(restoreText("PII_NAME", map), "Youssef Ben Ali");
});

test("unrecognized scaffolding never reaches the page", () => {
  assert.equal(stripTokens("Hallo {{PII_UNBEKANNT}} Welt"), "Hallo Welt");
});

test("uploaded CVs lose contact details but keep date ranges", () => {
  // The two things a naive phone regex destroys: a date range and a postal code.
  const cv = `Lebenslauf
09/2023 - 07/2026 Goethe-Gymnasium, 10115 Berlin
Telefon: 0170 1234567
E-Mail: max@example.com
Mobil +49 171 9876543`;
  const { redacted, map } = redactFreeText(cv);

  assert.ok(!redacted.includes("max@example.com"));
  assert.ok(!redacted.includes("0170 1234567"));
  assert.ok(!redacted.includes("+49 171 9876543"));
  assert.ok(redacted.includes("09/2023 - 07/2026"), redacted);
  assert.ok(redacted.includes("10115 Berlin"), redacted);

  assert.equal(restoreText(redacted, map), cv);
});
