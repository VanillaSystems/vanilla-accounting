/**
 * Änderungen (screen 7). List: sync line (synchron / n nicht synchronisiert / Synchronisieren) and
 * Verlauf (history). Detail, by state of the page:
 *   no proposal  → RawChanges: Bücher · aus Läufen (each run with grouped counts, link to the run),
 *                  direkt bearbeitet, Wie die App arbeitet · Dateien (+a −d), «Speichern vorbereiten»
 *   preparing    → the same, with "Die KI ordnet und beschreibt …"
 *   ready/stale  → Bereit zum Speichern: PreparedSave cards (tag, message, why, figures pill, held pill,
 *                  Diff/Ansehen, «n offene ansehen» → the run's open items), the talk, composer + chips,
 *                  Speichern / Speichern und synchronisieren (disabled while stale), stale banner with
 *                  «Vorschlag aktualisieren»
 *   /changes/<commit> → a save: who, when, sync pill, files with diffs or grouped counts, Rückgängig…
 *                  (locked: the lock banner and «Korrektur starten…» = the correction workflow's button)
 * DiffDialog.tsx: per file diff, «Ganze Datei»; the dialog anchoring rule of intake.md (fixed top, grows down).
 *
 * The talk here is NOT the sidebar: it is the saving command `talk` (one model call that returns a
 * new proposal), because what it may change is the proposal, not files. "Den Treibstoffzuschlag
 * noch nicht" (rewrite a file) is answered with «Im KI-Fenster ändern» opening the sidebar with
 * the file as context (unit 8), so file edits have exactly one way in.
 *
 *   const view = useChanges();                    // ChangesView, refetched when the snapshot's rev moves (one clock)
 *   await savingCommand({ kind: 'save', sync: true });
 */
import type { Area } from '../index.js';
import type { ChangesRoute } from '../../shell/route.js';

export const changes: Area<ChangesRoute> = {
  id: 'changes',
  label: () => { throw new Error('not implemented'); },     // "Änderungen"
  dock: { key: 'v', icon: null, tip: () => { throw new Error('not implemented'); }, badge: () => { throw new Error('not implemented'); } },
  List: () => { throw new Error('not implemented'); },
  Detail: () => { throw new Error('not implemented'); },
  periodless: true,
  title: () => { throw new Error('not implemented'); },
};
