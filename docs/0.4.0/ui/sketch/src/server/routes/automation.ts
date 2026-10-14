/**
 * The automation over HTTP. Thin: parse, call, answer. Four routes, all under /api, loopback only.
 *
 *   GET  /api/automation?since=<rev>      snapshot, or { unchanged: true } when rev has not moved (a cheap poll, no held connection)
 *   GET  /api/automation/runs?workflow=&before=&entry=   run summaries (Läufe tab; entry → the run that booked it)
 *   GET  /api/automation/runs/:id         one run with its step records (screen 3)
 *   POST /api/automation                  { command: AutomationCommand } → CommandResult (READONLY: 403, as every write)
 *
 * Replaces in unit 9 GET/POST /api/intake and its in-memory job: the inbox becomes the
 * outside trigger of receipt-intake / bank-import, and IntakeLine reads the snapshot.
 *
 * Wiring (src/server/books.ts, at boot, after WS):
 *   export const SAVING = openSaving(WS, …); export const AUTOMATION = openAutomation(WS, { ask, sources: SAVING.sources, notify });
 * One instance each per server process; the routes import them, nothing else constructs one.
 */
import { Router } from 'express';

export const router = Router();

// TODO router.get('/api/automation', (req, res) => { const s = AUTOMATION.snapshot(); res.json(req.query.since && +req.query.since === s.rev ? { unchanged: true } : s) })
// rev = one counter the server bumps on any run write, a declaration-folder hash change (checked on each read), and a git index/HEAD change of the repository (so a Claude Code edit wakes Änderungen).
// TODO router.get('/api/automation/runs', …) parse workflow/before/entry/limit
// TODO router.get('/api/automation/runs/:id', …) 404 when unknown
// TODO router.post('/api/automation', …) parseCommand(req.body) (boundary: reject unknown kinds/ids) → AUTOMATION.command
