# Deviations of the built UI from the mockups (15.10.2026)

Compared side by side, page by page, at 1440 × 900, light, German, on a copy of the company's real
books (branch `0.4.0-runs`):

- the bookkeeping mockup (the company workspace's `planning/ui-mockup/index.html`, state 10.10.2026),
  opened at the same path as the app (`#/<path>` there, `/<path>` here);
- the Automatisierung mockup (`docs/0.4.0/mockups/workflows.html`), screen by screen.

The tool is `.verify/audit.mjs` (pages) and `.verify/audit-wf.mjs` (Automatisierung screens); both
write the two screenshots per page and a side-by-side report. Data differences (the books moved on
since 10.10., the mockup's invented invoices) are no deviations. Later decisions of the owner win
over the mockup and are marked **decided**.

Status: **open**, **fixed** (with the commit), **decided** (stays as built), **to compare** (not
compared yet).

## Every page

| # | Mockup | Built | Status |
|---|---|---|---|
| S1 | The open top bar floats over free space; the list heading and its add button («+ Beleg», «+ Auszug», «+ Buchung», «+ Rechnung») stay visible | as the mockup | fixed |
| S2 | Dock at the bottom edge (both mockups) | Activity bar down the left edge (try of 15.10., f2e8660), with the bolt button for Automatisierung above it | decided (owner to confirm) |
| S3 | Period picker, ⌘K palette, export dialog, AI sidebar, status corner | not compared yet | to compare |

## Belege

| # | Mockup | Built | Status |
|---|---|---|---|
| B1 | Each row: a short title, the vendor and 2–4 words («Vendor · Brillengläser Rimless Drill»); a receipt without a description still gets one | as the mockup: `Receipt.title`, named by the inbox's read step; older receipts get theirs from `npm run titles` | fixed |
| B2 | Detail head: the vendor as title, the short title as subtitle | as the mockup (from the title; the description stays under Angaben) | fixed |
| B3 | Filter row: alle · zugeordnet · offen · ohne Datum, search | Also «Eingang verarbeiten» (Automatisierung, later) | decided |

## Rechnungen

| # | Mockup | Built | Status |
|---|---|---|---|
| R1 | List, detail with the A4 sheet, Kunden, Versand | The real books hold no invoices: compare on the demo | to compare |

## Kontoauszüge, Buchungen, MWST, MWST-Codes, Bilanz & ER

No deviation beyond S1: the lists, details, figures and links match.

## Abschluss

| # | Mockup | Built | Status |
|---|---|---|---|
| A1 | Each check in a person's words, one short line under it | Some checks name commands («npm run seal …», «npm run doctor findet nichts zu beheben») and long lists of accounts | open |

## Firma

| # | Mockup | Built | Status |
|---|---|---|---|
| F1 | Rechnungslayout: the editor (language, font, colour, logo, place, size, window, elements) beside a live A4 preview | Without an `invoicing` block in `belege.workspace.yaml`, only a sentence about the missing block | open |
| F2 | — | E-Mail-Versand and Quellen in the list (later units) | decided |

## Automatisierung

| # | Mockup | Built | Status |
|---|---|---|---|
| W1 | Screen 1: the area opens on a workflow list | The latest runs as a table (owner, 15.10.) | decided |
| W2 | Screen 2 Prozesskarte: four numbered phases, each with what it does and how often, its open count; each workflow card with STARTET BEI (its triggers), MELDET (its events), its state («läuft», «2 steckt») and the event arrows between phases | Four columns of plain cards: name and cadence, the arrows as a crossed-out line | open |
| W3 | List column: each workflow with its trigger chips (Zeitplan, Von aussen, Ereignis, Knopf) and its open count | Each workflow with its cadence, «noch nicht ausführbar» | open |
| W4 | Screen 9 Warteschlange: Läuft (each run with its step and a bar), In der Schlange (numbered, why it waits, ×), Geparkt (waiting for a person or an event), Fertig, «Pausieren» at the top right | Running, queued, stuck and recently done as plain lists of run ids | open |
| W5 | Screen 8 Dateien ablegen: «Hinzufügen» | Taken at once, «Rückgängig» (owner, 15.10.) | decided |
| W6 | Screens 3 (a stuck run), 4 (triggers in the areas), 5 (a task), 6 (changing a workflow) | not compared yet: need a stuck run and a waiting task | to compare |

## Änderungen (Screen 7)

| # | Mockup | Built | Status |
|---|---|---|---|
| C1 | Left: the sync state («synchron · zuletzt heute 11:40») and Verlauf, each save with who and when | as the mockup | fixed |
| C2 | Right: «Seit dem letzten Speichern», BÜCHER · AUS LÄUFEN (each run with its number of entries) and WIE DIE APP ARBEITET · DATEIEN (each file with who changed it and +/−) | as the mockup; the books wait for the person's save (owner, 15.10.: runs no longer save themselves) | fixed |
| C3 | «Speichern vorbereiten» right under the two groups | as the mockup | fixed |
| C4 | — | In the Q2 replay (a git worktree), isomorphic-git reads a HEAD the git CLI does not: 37 files untouched since the baseline show as «neu» | open (replay setup) |
