// Shapes observed coming back from the free models. Each case here cost a real
// failed generation to find, so they are worth keeping.

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeDocs, ShapeError } from "./cv-types.ts";

const goodAnschreiben = {
  absender: { name: "Max Mustermann", zeilen: ["Musterstraße 1"] },
  empfaenger: { zeilen: ["Lidl GmbH"] },
  betreff: "Bewerbung um einen Ausbildungsplatz",
  anrede: "Sehr geehrte Frau Müller,",
  absaetze: ["Absatz eins.", "Absatz zwei."],
  gruss: "Mit freundlichen Grüßen",
  unterschrift: "Max Mustermann",
};

const goodLebenslauf = {
  persoenlicheDaten: { name: "Max Mustermann" },
  abschnitte: [
    { titel: "Schulbildung", eintraege: [{ titel: "Abitur", details: [] }] },
  ],
};

test("the normal shape passes through", () => {
  const docs = normalizeDocs({
    lebenslauf: goodLebenslauf,
    anschreiben: goodAnschreiben,
  });
  assert.equal(docs.anschreiben.absaetze.length, 2);
  assert.equal(docs.lebenslauf.abschnitte.length, 1);
});

test("anschreiben nested inside lebenslauf is recovered", () => {
  // nemotron-3-super closes the lebenslauf object one brace too late, so the
  // top-level key is missing entirely. The content is fine; only nesting is wrong.
  const docs = normalizeDocs({
    lebenslauf: { ...goodLebenslauf, anschreiben: goodAnschreiben },
  });
  assert.equal(docs.anschreiben.absaetze.length, 2);
  assert.equal(docs.anschreiben.anrede, "Sehr geehrte Frau Müller,");
  assert.equal(docs.lebenslauf.persoenlicheDaten.name, "Max Mustermann");
});

test("stray scalars among the sections are dropped, not fatal", () => {
  // Same response: "ort", "", "datum", "" appeared as array elements.
  const docs = normalizeDocs({
    lebenslauf: {
      ...goodLebenslauf,
      abschnitte: [...goodLebenslauf.abschnitte, "ort", "", "datum", ""],
    },
    anschreiben: goodAnschreiben,
  });
  assert.equal(docs.lebenslauf.abschnitte.length, 1);
});

test("a salutation repeated in the first paragraph is removed", () => {
  const docs = normalizeDocs({
    lebenslauf: goodLebenslauf,
    anschreiben: {
      ...goodAnschreiben,
      absaetze: [
        "Sehr geehrte Frau Müller, ich bewerbe mich um einen Ausbildungsplatz.",
        "Absatz zwei.",
      ],
    },
  });
  assert.equal(
    docs.anschreiben.absaetze[0],
    "Ich bewerbe mich um einen Ausbildungsplatz.",
  );
  assert.equal(docs.anschreiben.anrede, "Sehr geehrte Frau Müller,");
});

test("a paragraph that is only a salutation is dropped entirely", () => {
  const docs = normalizeDocs({
    lebenslauf: goodLebenslauf,
    anschreiben: {
      ...goodAnschreiben,
      absaetze: ["Sehr geehrte Damen und Herren,", "Der eigentliche Text."],
    },
  });
  assert.deepEqual(docs.anschreiben.absaetze, ["Der eigentliche Text."]);
});

test("a paragraph that merely mentions a greeting is left alone", () => {
  const docs = normalizeDocs({
    lebenslauf: goodLebenslauf,
    anschreiben: {
      ...goodAnschreiben,
      absaetze: ["Ich grüße sehr geehrte Gäste im Praktikum.", "Zwei."],
    },
  });
  assert.equal(docs.anschreiben.absaetze[0], "Ich grüße sehr geehrte Gäste im Praktikum.");
});

test("a genuinely empty response is still rejected", () => {
  // The fallback must not turn "unusable" into "silently blank".
  assert.throws(
    () => normalizeDocs({ lebenslauf: goodLebenslauf, anschreiben: {} }),
    ShapeError,
  );
  assert.throws(() => normalizeDocs({ anschreiben: goodAnschreiben }), ShapeError);
  assert.throws(() => normalizeDocs("not an object"), ShapeError);
});
