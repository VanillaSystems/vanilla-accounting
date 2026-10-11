/**
 * The workspace's changes as the API announces them (GET /api/events, src/server/events.ts). A
 * dropped stream is opened again after 1 s, 2 s, 4 s … up to 30 s; changes made meanwhile were
 * missed, so `onReopen` reads everything again. The static export has no server and no events.
 */
import type { WorkspaceChange } from '../../types/api-error.js';

export function listen(onChange: (change: WorkspaceChange) => void, onReopen: () => void): () => void {
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  let opened = false;

  function open(): void {
    source = new EventSource('/api/events');
    source.onopen = () => {
      if (opened) onReopen();
      opened = true;
      delay = 1000;
    };
    source.onmessage = (e: MessageEvent<string>) => onChange(JSON.parse(e.data) as WorkspaceChange);
    source.onerror = () => {
      source?.close();
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 30_000);
    };
  }

  open();
  return () => { clearTimeout(retry); source?.close(); };
}
