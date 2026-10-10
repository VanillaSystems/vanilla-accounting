# Redesign: progress

The run of the redesign plan (private workspace `planning/implementation-plan.md`) on branch
`redesign`. This file is the run's memory: what is done, what is next, and every default chosen
with its reason. Architecture: [architecture.md](architecture.md).

Checks at every commit: `npx tsc --noEmit`, `npm test`, `npm run test:books`, `npm run check-public`.
Browser proof: `.claude/skills/verify/` sandbox on `demo`, evidence in `.verify/evidence/`.

## Phases

- [x] 0. Setup: branch, docs read, checks green, API inventory, architecture, this file.
- [ ] 1. Shell: tokens, fonts, theme, zoom, dock, top bar, list/detail with divider, keys, ⌘K, toast with undo, URL sync, add button with N.
- [ ] 2. Belege.
- [ ] 3. Kontoauszüge.
- [ ] 4. Buchungen and MWST-Codes.
- [ ] 5. MWST and Bilanz & ER.
- [ ] 6. Export.
- [ ] 7. Abschluss and Firma.
- [ ] 8. Invoices: data and documents.
- [ ] 9. Invoices: UI.
- [ ] 10. Clean up and final pass.

## Decisions and defaults

| Date | Decision | Why |
|---|---|---|
| 2026-10-11 | `tests/update.test.ts` accepts the spec reporter's `ℹ pass N` besides TAP's `# pass N`. | Node 24 prints the spec format in the nested run; the test failed on main before any redesign change. |
| 2026-10-11 | The language leaves the URL; it is a per-viewer preference. Old `/<lang>/<period>/<tab>` links redirect. | urls.md rule 3: links do not change with the UI language. |
| 2026-10-11 | Plain CSS with the mockup's class names, one file per area; Tailwind only in old components until phase 10. | Plan, architecture decision 1. |
| 2026-10-11 | The UI keeps computing from `books.json` with `src/accounting` functions. | Same code as CLI and golden master; the mockup's `appcalc` proved the figures match. |
| 2026-10-11 | `/receipts/<file>.pdf` is a file, `/receipts/<id>` the app: the server tells them apart by extension. | urls.md paths collide with the data paths the UI already fetches. |

## API inventory against the mockup

Reads: the UI loads `/books.json`, `/api/accounts`, `/api/config`, `/api/vat/filed`,
`/api/fx-rates`, `/api/workspace`, `/api/status`, `/api/year-close/:year`. Writes that exist:
receipts (patch, delete, upload, vision extract, suggest date, rename), transactions (manual,
patch, delete), mappings (add, remove, approve duplicate), journal entries (patch, delete,
classify), year close (revaluation, templates, entries, close, open).

Missing for the mockup, to add in their phase:

- Belege: mark a receipt "kein Beleg nötig" / private outlay kinds (check `ReceiptPatch`), undo of a
  link (remove exists).
- Kontoauszüge: statement import (camt.053 and PDF upload) from the UI; today it is a CLI step.
- Buchungen: new manual entry (route exists only through year-close entries).
- Export: the export bundle (CSV, XLSX, JSON, PDF, ZIP with LIESMICH and SHA-256 sums).
- Firma: write company profile, banks, periods, display and invoice layout to `belege.workspace.yaml`.
- Rechnungen: everything (phase 8).

## Log

- 2026-10-11 phase 0: branch `redesign` from `main` (c73209e). Baseline: tsc ok, `npm test` 295/296
  (update test, fixed), `test:books` 15/15, check-public 0 findings.
