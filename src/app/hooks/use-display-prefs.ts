import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

/** Light, dark or the system's choice, kept in localStorage and applied as the `dark` class on <html>. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) ?? 'system');

  function setTheme(t: Theme) {
    setThemeState(t);
    localStorage.setItem('theme', t);
    const isDark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', isDark);
  }

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const handler = () => document.documentElement.classList.toggle('dark', mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  return [theme, setTheme];
}

/** The page zoom in percent, kept in localStorage and applied as the root font size. */
export function useZoom() {
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem('zoom');
    return saved ? parseInt(saved) : 100;
  });

  useEffect(() => {
    document.documentElement.style.fontSize = `${zoom}%`;
    localStorage.setItem('zoom', String(zoom));
  }, [zoom]);

  return [zoom, setZoom] as const;
}

/** A boolean kept in localStorage under `key`; works (unsaved) when storage is unavailable. */
export function usePersistedFlag(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? fallback : saved !== 'false';
    } catch { return fallback; }
  });

  function set(v: boolean) {
    setValue(v);
    try { localStorage.setItem(key, String(v)); } catch { /* storage unavailable */ }
  }

  return [value, set];
}
