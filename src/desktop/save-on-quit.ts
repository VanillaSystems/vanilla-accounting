/**
 * A copy whose Freigabe-Datei saves by itself (src/handover/document.ts `auto`) saves once more when
 * its window closes and when the app quits (⌘Q, the Dock's «Beenden», SIGTERM). Quitting waits for
 * that save, at most `ms`, and then quits for sure: a save that hangs never keeps the app alive
 * (review of PR #559: an intercepted close had stopped ⌘Q).
 */

/** The copy's file as the local server says it (GET /api/handover/document). */
interface DocumentNow { auto?: boolean; dirty?: boolean; missing?: boolean; other?: boolean }

/** Saves the copy's changes into its file when the server says the app saves by itself and something is unsaved; anything else does nothing. */
export async function saveIfDirty(base: string, fetcher: typeof fetch = fetch, ms = 30_000): Promise<boolean> {
  const res = await fetcher(`${base}/api/handover/document`, { signal: AbortSignal.timeout(3_000) });
  if (!res.ok) return false;
  const { document: d } = (await res.json()) as { document: DocumentNow | null };
  if (!d?.auto || !d.dirty || d.missing || d.other) return false;
  const saved = await fetcher(`${base}/api/handover/document/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto: true }), signal: AbortSignal.timeout(ms),
  });
  return saved.ok;
}

/** What of Electron's `app` the guard needs: its before-quit event and quit(). */
export interface Quitting {
  on(event: 'before-quit', listener: (e: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

/**
 * Holds the first quit until `save` is done (or `ms` passed), then quits again; that second quit
 * goes through. `quitting()` tells a window's close handler that the quit saves already.
 */
export function saveBeforeQuit(app: Quitting, save: () => Promise<unknown>, ms = 35_000): { quitting(): boolean } {
  let state: 'running' | 'saving' | 'done' = 'running';
  app.on('before-quit', (e) => {
    if (state === 'done') return;
    e.preventDefault();
    if (state === 'saving') return;
    state = 'saving';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
    void Promise.race([save().catch(() => undefined), bounded]).finally(() => {
      clearTimeout(timer);
      state = 'done';
      app.quit();
    });
  });
  return { quitting: () => state !== 'running' };
}
