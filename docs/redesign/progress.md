# Redesign: progress

The run of the redesign plan (private workspace `planning/implementation-plan.md`) on branch
`redesign`. This file is the run's memory: what is done, what is next, and every default chosen
with its reason. Architecture: [architecture.md](architecture.md).

Checks at every commit: `npx tsc --noEmit`, `npm test`, `npm run test:books`, `npm run check-public`.
Browser proof: `.claude/skills/verify/` sandbox on `demo`, evidence in `.verify/evidence/`.

## Phases

- [x] 0. Setup: branch, docs read, checks green, API inventory, architecture, this file.
- [x] 1. Shell: tokens, fonts, theme, zoom, dock, top bar, list/detail with divider, keys, ⌘K, toast with undo, URL sync, add button with N.
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
| 2026-10-11 | Until its phase, each area shows the old tab(s) through one adapter (`src/app/areas/legacy.tsx` + `legacy-tabs.tsx`, the old App.tsx minus header, tab bar and URL state), full width under the new heading. An area with several old tabs lists them as heading tabs. | The app stays usable at every commit; the old tabs have their own list/detail split. Deleted in phase 10. |
| 2026-10-11 | The old tabs' selection keys (je=, account=, ziffer=, view=codes&code=) are held in memory by `lib/location.ts`, seeded from the route and written back as route changes; the old link helpers (`entryHref`, `txHref`, …) build the new paths. | One parser for the URL; old components keep working unchanged. |
| 2026-10-11 | Bank area's old tabs: Kontoauszüge, Transaktionen, Kontenabgleich; reports: Erfolgsrechnung, Bilanz, Saldobilanz, Kontoauszug; `/payments/<ref>` shows the payment in Transaktionen; an old `account-ledger?account=` link opens `/reports/trial/<account>`. | Every old view stays reachable from the dock. |
| 2026-10-11 | Absent `?period=` means the open quarter: the quarter after `closedThrough` (`openQuarter`, periods.ts), today's quarter when nothing is filed. A link with the open period leaves it out. | urls.md: "left out when it is the open period"; the mockup's OPEN_PERIOD. Old links without a period meant "all" and now open the open quarter. |
| 2026-10-11 | urls.md's range spelling `2026-07-01_2026-09-30` is written; `..` (periods.ts, old links) is read too. | URL per urls.md, CLI tokens unchanged. |
| 2026-10-11 | Zoom is CSS zoom on `<html>` with `--z`, as in the mockup (not on `<main>`): steps 80–160 %, stored per viewer; an old percent value is converted. | The mockup's CSS (`main { height: calc(100vh / var(--z)) }`, menu positions divided by the zoom) assumes the root; the top bar and dock scale too (shot 19). |
| 2026-10-11 | Theme keeps the `dark` class for the old Tailwind components beside `data-theme`; stored under `theme`, applied before the first paint by index.html. | Old tabs follow the theme until phase 10. |
| 2026-10-11 | Language: top bar menu (de, fr, it, en), stored per viewer; an old `/fr/…` link does not change it. | urls.md rule 3. |
| 2026-10-11 | Fonts: Hanken Grotesk, Instrument Sans, Geist Mono via @fontsource; Figtree, Roboto Condensed, JetBrains Mono and the unused Radix packages removed; Tailwind's `font-mono` is Geist Mono. | One type system; old tabs read in the new fonts. |
| 2026-10-11 | The key legend shows as in the mockup (quiet, bottom right); `?` hides and shows it (remembered). | Architecture names `?` for the legend; the mockup always shows it. |
| 2026-10-11 | ⇧E (export) not bound yet. | The export dialog is phase 6. |
| 2026-10-11 | The theme toast from the top bar's ◐ carries an undo (⌘Z). | The only undoable action in phase 1; proves the toast's undo end to end. |
| 2026-10-11 | Add button and N on Belege, and a drop on any page: PDFs go to the inbox through `POST /api/upload` (same-second files no longer overwrite each other), toast; other files are named as skipped. | A real intake now; phase 2 builds reading and matching on top. |
| 2026-10-11 | Firma is a real list/detail area now (sections of urls.md, J/K, Enter, Esc, divider); Darstellung works (theme, language, zoom), the other sections say "im Bau". Rechnungen says so too. | The shell's list/detail, divider and row keys need one real area to work on; the brief's placeholder for company. |
| 2026-10-11 | Tab title "<object> · <area>" without the product name. | urls.md rule 6's example. |
| 2026-10-11 | The audit bar is a fixed amber strip over the page top. | `main` is exactly one screen high (mockup CSS); a bar in the flow would push it off. |
| 2026-10-11 | Express serves a built app (`dist/`, or `APP_DIST`) with the same app-path rule as Vite (`src/server/app-paths.ts`); the sandbox's Vite config imports it. | One rule for "file or app path" in three places. |

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
- 2026-10-11 phase 1: shell. route.ts (one parser, old links redirect, 5 tests), app paths in Vite/sandbox/Express,
  tokens.css + shell.css from the mockup, self-hosted fonts, theme/zoom/language, dock, top bar, list/detail with
  divider, keyboard model, ⌘K palette, toast with undo, period picker restyled as the mockup's, drop zone + intake,
  add button with N, tab titles; every old tab inside its area through the legacy adapter; Firma list/detail with
  Darstellung. Evidence and mockup comparison: .verify/evidence/redesign/phase-1/NOTES.md. Differs from the mockup:
  old tab bodies (phases 2–9), theme toast has an undo, no ⇧E yet, Firma sections other than Darstellung pending.
  Commits: route.ts, app paths, upload, then the shell. Left: bank badge (needs
  the statement check, phase 3), objects in ⌘K for the other areas as they are built.
