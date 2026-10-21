'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ES } from './translations.es';

export type Lang = 'en' | 'es';

const STORAGE_KEY = 'wegox-lang';

interface I18nContextType {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Translates an English UI string; {name} placeholders are substituted. */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    vars[name] !== undefined ? String(vars[name]) : match,
  );
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');

  // localStorage only exists client-side; read after mount to avoid
  // hydration mismatches (first paint is English, then flips if needed)
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'es' || stored === 'en') setLangState(stored);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && (event.newValue === 'es' || event.newValue === 'en')) {
        setLangState(event.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const template = lang === 'es' ? (ES[key] ?? key) : key;
      return interpolate(template, vars);
    },
    [lang],
  );

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextType {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used within I18nProvider');
  return context;
}

/** Shorthand for components that only need the translate function. */
export function useT() {
  return useI18n().t;
}

export function useNumberFormatter() {
  const { lang } = useI18n();
  return React.useMemo(() => new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-US'), [lang]);
}
