# Vanilla Accounting verification map

This directory is the maintained source for verifying the user-facing behavior of Vanilla Accounting. Read this index first, then use the matching feature file as the recipe. `S`, `B`, `UI`, `API`, `SB`, and `EVIDENCE` are defined in [../SKILL.md](../SKILL.md).

## Baseline preconditions

- Start a fresh sandbox with `$S up <run>`, then `source $TMPDIR/belege-verify/<run>/env`.
- `$S doctor <run>` passes on every line, including "real workspace books untouched since up".
- The recipes read the period lock from the env that `up` writes: `CT` is the clone's `config.closedThrough`, `CLOSED_Q` and `CLOSED_FROM` are the last filed quarter and its first day, `OPEN_Q` and `OPEN_FROM` the open quarter after it. Entries dated on or before `$CT` are locked; later ones are open. An expected text that shows `$CT` carries its value. The worked examples are the demo's: `CT=2026-03-31`, closed `2026-Q1`, open `2026-Q2`.
- The browser actions run in your own `browse` tab: `$B newtab "$UI/..."`. Set the language once per origin: `$B js "localStorage.setItem('language','de'); location.reload()"` (headless Chromium is English, the recipes' labels are German).
- No model calls in the sandbox: the API's `claude` is a shim that exits 1. Any button that calls an LLM fails with an alert. That is expected, so don't count it as a regression. `$S stub <run>` answers with the test stub when a recipe needs an answer.

## Driving conventions

- Navigate by URL (the paths of docs/urls.md, e.g. `/journal/<id>?period=$OPEN_Q`; old `/<lang>/<period>/<tab>?receipt=&tx=` links redirect there) to reach a state, then act through the UI.
- Prefer the `data-*` handles the feature files name (`data-id`, `data-testid`, `data-act`, `data-partner`, …), ARIA roles and names from `$B snapshot -i`, `data-tip` attributes (tooltips), and placeholders over positions.
- Choose fixture records from the sandbox index with `jq` at run time. IDs change when data is reclassified, so never hard-code one from an old run.
- One mutation per proof. Run `$S diff` right after it, so the diff shows only that mutation.

## Proof and skip reporting

- UI proof is a before and after screenshot plus a DOM readback (`$B js` or `$B text`) of the changed element.
- Mutation proof is the `$S diff` output, saved as `index-diff.txt`. It must list exactly the intended change.
- Refusal proof is the `$B dialog` text plus a `$S diff` that shows no change for that record.
- CLI proof is the command, its stdout, and its exit code, run with `cd "$SB"`.
- Report an LLM-backed or camera-backed path as skipped, with the reason. Do not report it as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with browse + sandbox.sh`, and `Gotchas`.

## Features

Maintenance pass of 2026-10-31: every file below was read against the source of origin/0.4.0 (7fac48b7) and driven live in a demo sandbox, except `desktop-install` (needs the dmg and the VM; not started this pass). `desktop-setup` and `desktop-drop` were driven through `desktopServer` in a browser instead of the packed app (desktop-setup.md, Gotchas). Product bugs found are named in the Gotchas of their files.

- [Journal entries (Buchungen) and MWST-Codes](./journal-entries.md) covers the rebuilt Buchungen (grid, filters, `?vat=`, detail, edit, new entry, correction, delete and re-classify with undo, the filed-quarter refusals) and the VAT code card, histogram and catalogue. **Driven end to end on 2026-10-11 (redesign phase 4).**
- [Bank statements (Kontoauszüge)](./bank.md) covers the new Kontoauszüge area: statements by account or month, missing months, the balance check against the bank and the books, the payment's line on the PDF, links to receipt and entry, `/payments/<ref>`, `kein Beleg nötig` and the payment's note with undo, and the statement import (`POST /api/statements`) with its closed-quarter refusal. **Driven end to end on 2026-10-11.**
- [Receipts (Belege)](./receipts.md) covers the new Belege area: groups, filters, search, the paper, linking with the ranked dialog, private outlay and releasing it, edit, kind, undo, delete, preview, download and intake. **Driven end to end on 2026-10-11.**
- [MWST report](./vat-report.md) covers the new MWST area: the Ziffern of a return, the Ziffer detail with its sum or entries, filed quarters with their differences, the Korrekturabrechnung (0535) with its correction cases, and the `vat-report` / `vat-xml` CLIs. **Driven on 2026-10-11.**
- [Bilanz & ER](./reports.md) covers Erfolgsrechnung, Bilanz, Saldobilanz, Eigene Berichte (saved into `knowledge/reports/`), all accounts, the account search, the gap and its causes, and the account ledger. **Driven on 2026-10-11.**
- [Export](./export.md) covers the export dialog (presets, own presets, period, parts, formats, checksums), the ZIP from `POST /api/export`, audit mode, and the ledger's download menu. **Driven on 2026-10-11.**
- [Abschluss and Firma](./close-and-company.md) covers the year-end in seven steps (checks, entries with the receivables of open invoices, close, opening, profit allocation, handover) and the Firma sections with their edits of the manifest and the chart. **Driven on 2026-10-11.**
- [Rechnungen](./invoices.md) covers the invoice list by state, customers, the sent log, a draft edited on its A4 sheet, issue with the Art. 26 gaps, send, credit note, cancellation, reminders, comments, and Firma › Rechnungslayout. **Driven end to end on 2026-10-11 (redesign phase 9).**
- [Geschäftspartner](./partners.md) covers the partner list and page (notes edit and save into `knowledge/<role>/<id>.md`, linked entries, receipts and payments), «Als Regel vorschlagen» with its rule card, the «führt die App aus» mark and «Notiz geändert: Regel anpassen?».
- [Wissen](./knowledge.md) covers Lücken, Von der App, the company's topic pages with their edit, and «Neue Seite».
- [Automatisierung](./automation.md) covers the overview («Leitstand»), Läufe, a workflow's graph with its scroll frame and step selection, the Prozesskarte, the queue and the tasks.
- [Einrichtung](./setup.md) covers the setup conversation from Firma: the topic rail, answer buttons, cards, and the VAT card's «Übernehmen» / «Rückgängig» through `PATCH /api/workspace` (accepted only on books whose open year has no entries).
- [KI (AI sidebar)](./ai-sidebar.md) covers ⌘J, sending (error turn under the claude shim, canned answer with the stub), attachments and folder drops, the dictation button's presence, and clickable links.
- [Dateien hinzufügen](./drop.md) covers files dropped on the window in the browser: receipts, statements, refusals, duplicates, the unknown-account question, undo.
- [Static audit export](./audit-export.md) covers `npm run build:audit` served by a plain static server: every tab, search, PDFs, the snapshot line, no `/api/*` request. **Driven on 2026-10-09.**

- [Desktop: installation and first start](./desktop-install.md) covers the dmg, the Gatekeeper path and the start screen on a fresh VM (`vm.sh`). **Driven on 2026-10-15.**
- [Desktop: set up new books](./desktop-setup.md) covers the setup form, its UID/IBAN checks, unsupported answers and the written manifest. **Driven on 2026-10-15.**
- [Desktop: drop files](./desktop-drop.md) covers Dateien hinzufügen in the packed app: take, statement, refuse, duplicate, undo. **Partly driven on 2026-10-15 (CSV refused; upload hang seen once); not reachable on 2026-10-21 (the packed app did not open new books).**

The desktop files use `V`, `A`, `CDP` and `EVIDENCE` from the SKILL.md section "The packed Mac app on a fresh Mac", and their contract names the harness `vm.sh + app.mjs`.

## Not mapped yet

Driven on 2026-10-31 but without a feature file of their own:

- MWST abrechnen (`vat-filing` run): MWST › «Abrechnung erstellen» → Aufgaben «Abrechnung <q> prüfen» → «Freigegeben» (the period is held: writes 403) → «Eingereicht» → «Ja, eingereicht» → `closedThrough` moves, `filings/` gets the XML and `seal-<q>.json` (`src/workflows/filing.ts`, `GET /api/filing/<q>`).
- Batch actions on a selection (⌘-click rows, `src/app/selection/BatchPanel.tsx`, `POST /api/batch`): «Konto ändern …», Vorschau names what is left out, «N ausführen», the toast undoes the batch.
- Fragen («Frage stellen» on a payment, receipt or entry; Aufgaben «Deine offenen Fragen»; `src/app/questions/`, `/api/questions`).

Not driven yet: Dimensionen (Firma › Dimensionen, `tags` on entries and rules), Firma › Quellen with a mailbox (needs an IMAP server), the scan page's camera.

Without a feature file (Änderungen, the plain save without AI, and Firma › Regeln with «Neue Regel» were driven on 2026-10-31; `POST /api/upload` by curl):

- Änderungen (`/changes`, `src/app/areas/changes/changes.tsx`): what changed in rules and settings, saving and history.
- Firma › Regeln and Firma › Quellen (`src/app/areas/company/RulesSection.tsx`, `src/app/areas/company/SourcesSection.tsx`): the rule list with «Neue Regel» and the rule card, and where receipts come from.

- Scan PWA (`/scan`), which needs a camera. Its upload endpoint is `POST /api/upload` (`Content-Type: application/pdf`) and writes to `$SB/beleg-import/`. The iOS app (`ios/`) uses the same endpoint.
