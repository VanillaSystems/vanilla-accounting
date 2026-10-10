/**
 * Per-viewer preferences, kept in this browser (docs/urls.md: never in a link): theme, zoom,
 * language, and small remembered values. Every storage access may throw (private window).
 */
import { useEffect, useState } from 'react';
import { DEFAULT_LANGUAGE, setLanguage, supportedLanguage } from '../i18n/index.js';
import { useWorkspace } from '../hooks/use-workspace.js';

export function stored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function store(key: string, value: string | null): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

export type Theme = 'system' | 'light' | 'dark';
const darkOS = () => matchMedia('(prefers-color-scheme: dark)');

/** data-theme on <html> for the new CSS; the `dark` class for the old Tailwind components until phase 10. */
function applyTheme(dark: boolean) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', dark);
}

/**
 * The theme preference and whether the page is dark now. System follows the OS live; light and
 * dark are fixed. index.html applies the stored one before the first paint.
 */
export function useTheme(): [Theme, (t: Theme) => void, boolean] {
  const [theme, setTheme] = useState<Theme>(() => {
    const s = stored('theme');
    return s === 'light' || s === 'dark' ? s : 'system';
  });
  const [osDark, setOsDark] = useState(() => darkOS().matches);
  useEffect(() => {
    const mq = darkOS();
    const follow = () => setOsDark(mq.matches);
    mq.addEventListener('change', follow);
    return () => mq.removeEventListener('change', follow);
  }, []);
  const dark = theme === 'dark' || (theme === 'system' && osDark);
  useEffect(() => applyTheme(dark), [dark]);
  useEffect(() => store('theme', theme), [theme]);
  return [theme, setTheme, dark];
}

export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6] as const;

/** The whole page scales (text, rows, PDFs): CSS zoom on <html>, and --z for the heights that must undo it. */
export function useZoom(): [number, (step: -1 | 0 | 1) => void] {
  const [zoom, setZoom] = useState(() => {
    const saved = Number(stored('zoom')) || 1;
    // Before the redesign the zoom was kept in percent.
    const z = saved > 3 ? saved / 100 : saved;
    return ZOOM_STEPS.reduce((a, b) => (Math.abs(b - z) < Math.abs(a - z) ? b : a));
  });
  useEffect(() => {
    const root = document.documentElement;
    root.style.zoom = zoom === 1 ? '' : String(zoom);
    root.style.setProperty('--z', String(zoom));
    store('zoom', String(zoom));
    dispatchEvent(new Event('resize'));
  }, [zoom]);
  const step = (d: -1 | 0 | 1) => setZoom((z) => {
    if (d === 0) return 1;
    const i = ZOOM_STEPS.findIndex((s) => s >= z - 0.001);
    return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + d))];
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const d = e.key === '+' || e.key === '=' ? 1 : e.key === '-' ? -1 : e.key === '0' ? 0 : null;
      if (d === null) return;
      e.preventDefault();
      step(d);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);
  return [zoom, step];
}

/** A value kept in localStorage under `key`; works (unsaved) when storage is unavailable. */
export function usePersistedFlag(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    const saved = stored(key);
    return saved === null ? fallback : saved !== 'false';
  });
  return [value, (v) => { setValue(v); store(key, String(v)); }];
}

/**
 * The UI language: the one picked in the top bar (localStorage), else the workspace's
 * company.language, else the browser's, else German. Links carry no language (docs/urls.md rule 3).
 */
export function useLanguage(): [string, (code: string) => void] {
  const [lang, setLang] = useState(() => supportedLanguage(stored('language')));
  const workspace = useWorkspace();
  const resolved = lang
    ?? supportedLanguage(workspace?.company.language)
    ?? navigator.languages.map(supportedLanguage).find(Boolean)
    ?? DEFAULT_LANGUAGE;
  setLanguage(resolved);
  return [resolved, (code) => { setLang(code); store('language', code); }];
}
