/**
 * What runs on its own while the books are open, under `npm start` and in the desktop app alike:
 * files arriving in the inbox (the phone, a drop, the Finder) start their runs, looked for at once
 * (what waited since the last start) and then every few seconds; and the workflows' minute clock
 * for their schedule triggers. Imported once the books API is loaded: it follows the open
 * workspace, so books opened later are served by the same timers.
 */
import { READONLY } from './api.js';
import { engine, outsideArrivals } from './routes/automation.js';

export function startBackground({ inboxEveryMs = 5_000 } = {}): () => void {
  const timers: NodeJS.Timeout[] = [];
  if (!READONLY) {
    const arrivals = () => void outsideArrivals().catch((e) => console.error(`inbox: ${(e as Error).message}`));
    arrivals();
    timers.push(setInterval(arrivals, inboxEveryMs).unref());
  }
  // Aligned to the full minute.
  timers.push(setTimeout(() => {
    void engine().tick();
    timers.push(setInterval(() => void engine().tick(), 60_000).unref());
  }, 60_000 - (Date.now() % 60_000)).unref());
  return () => { for (const t of timers) clearTimeout(t); };
}
