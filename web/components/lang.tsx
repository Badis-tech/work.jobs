"use client";

import { createContext, useContext, useEffect, useState } from "react";

// App-wide UI language. One provider at the root backs every client component,
// so a single toggle in the header switches the whole chrome.
export type Lang = "de" | "en";
export type L = { de: string; en: string };

// Storage key kept from the old CV tool so saved language choices survive.
const LANG_KEY = "cv-form-lang";

type Ctx = { lang: Lang; setLang: (l: Lang) => void };
const LangContext = createContext<Ctx>({ lang: "de", setLang: () => {} });

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("de");

  // Read after mount (not in a useState initializer) so server and first client
  // render agree on the "de" default and hydration stays clean.
  useEffect(() => {
    const saved = window.localStorage.getItem(LANG_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of a persisted preference on mount
    if (saved === "de" || saved === "en") setLangState(saved);
  }, []);

  function setLang(next: Lang) {
    setLangState(next);
    window.localStorage.setItem(LANG_KEY, next);
  }

  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

export function useUiLang() {
  const { lang, setLang } = useContext(LangContext);
  const t = (v: L) => v[lang];
  return { lang, setLang, t };
}

// EN / DE segmented pill. Reads the shared language directly.
export function LangToggle() {
  const { lang, setLang } = useUiLang();
  return (
    <div className="flex shrink-0 rounded-lg border border-zinc-300 p-0.5 text-xs font-semibold dark:border-zinc-700">
      {(["de", "en"] as Lang[]).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`rounded-md px-2 py-1 uppercase transition-colors ${
            lang === l
              ? "bg-brand text-white"
              : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
