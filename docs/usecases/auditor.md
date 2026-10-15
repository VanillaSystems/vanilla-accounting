# Auditor with a read-only copy: the ESTV and the AHV inspector

An inspector of the federal tax administration (VAT audit) or of the AHV compensation fund
(payroll audit, with BVG and UVG). Comes every few years, announced, checks several years at
once, and must trust that what she sees is complete and unchanged. She changes nothing. She
gets the read-only audit export ([audit-export.md](../audit-export.md)), or a link to it.

Surfaces: the sandbox in read-only mode (`READONLY=1 sandbox.sh up`), on the Huber books with
Q3 sealed and on `demo/`; and `npm run build:audit -- <folder>` from the sandbox's workspace.
No case here has run in a persona test yet.

Format and status: [README.md](README.md).

### AU-01 Open the audit export

**Goal.** «Ich habe einen Link von der Firma bekommen.»

**Happy path.** A link behind a login, or a folder that opens with a double-click; the whole app
to click through, read-only.

**What goes wrong.**

**F1. The export needs `npx serve`.** `fails (docs/personas/auditor.md says so)`
- Noticed: the browser loads nothing from a file.
- By hand: the owner serves it.
- By wish: none.
- Learns: nothing; the export must open as a link or a file.

**F2. The link is public.** `untested`
- Noticed: no login asked.
- By hand: the owner removes it.
- By wish: none.
- Learns: every path behind the login.

**Automation target.** Code: the export and the access. Person: the owner grants it.

**Test.** `build:audit` from the sandbox; open the folder by double-click.

**Status.** fails (auditor persona)

### AU-02 From a return figure to the receipt

**Goal.** «Woher kommt die Vorsteuer in Ziffer 400 im Q3?»

**Happy path.** MWST › Q3 › Ziffer 400 lists the entries; an entry opens its receipt (PDF) and
its bank line in the statement.

**What goes wrong.**

**F1. An entry without its receipt file.** `untested`
- Noticed: the export lists missing files.
- By hand: ask the firm.
- By wish: none.
- Learns: nothing.

**F2. A receipt linked to two payments.** `untested`
- Noticed: OW-11.
- By hand: note it.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: drill-down.

**Test.** READONLY sandbox on the Huber books.

**Status.** untested

### AU-03 The filed return against the books

**Goal.** «Stimmt die eingereichte Abrechnung mit den Büchern?»

**Happy path.** For each filed quarter: what was filed, what the books give now, the
difference, and each correction (0535) with what it corrected.

**What goes wrong.**

**F1. A difference without a correction.** `untested`
- Noticed: the MWST page shows filed versus now.
- By hand: ask.
- By wish: none.
- Learns: nothing.

**F2. The filed XML missing from the export.** `untested`
- Noticed: the export lists it as missing.
- By hand: ask.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the comparison.

**Test.** READONLY sandbox on `demo/` (filed quarters).

**Status.** untested

### AU-04 Nothing changed after filing

**Goal.** «Wurde nach dem Einreichen etwas geändert?»

**Happy path.** The seals of the closed quarters match; the manifest lists the SHA-256 of every
file; a changed sealed entry opens the books read-only and says so.

**What goes wrong.**

**F1. A sealed entry edited by hand in the file.** `untested`
- Noticed: the seal check fails on load.
- By hand: none; she reports it.
- By wish: none.
- Learns: nothing.

**F2. A file swapped after the export.** `untested`
- Noticed: its checksum differs from the manifest.
- By hand: `shasum` against the manifest.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: seals and checksums.

**Test.** Sandbox, edit a sealed entry in `books/*.jsonl`, reload.

**Status.** untested

### AU-05 Complete books

**Goal.** «Sind alle Bankmonate da, jede Zahlung gebucht?»

**Happy path.** Kontoauszüge: every month of every account with «Saldo stimmt»; every payment
booked; a list of gaps.

**What goes wrong.**

**F1. A month missing.** `untested`
- Noticed: «fehlt».
- By hand: ask.
- By wish: none.
- Learns: nothing.

**F2. A quarterly camt shows months as missing.** `fails (quarter-close-2), retest (0170d83)`
- Noticed: «0 Auszüge · 3 fehlen».
- By hand: none.
- By wish: none.
- Learns: OW-07.

**Automation target.** Code: the check.

**Test.** READONLY sandbox on the Huber books.

**Status.** fails (quarter-close-2)

### AU-06 Nothing can be changed

**Goal.** (She clicks everything.)

**Happy path.** The amber audit bar; no edit controls; a write answers «Prüfmodus: Änderungen
sind deaktiviert.»

**What goes wrong.**

**F1. A button that writes is still shown.** `untested`
- Noticed: she clicks it; refused with 403 `readonly`.
- By hand: none.
- By wish: the AI sidebar is absent.
- Learns: nothing.

**F2. A drop onto the window.** `untested`
- Noticed: refused.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: read-only mode.

**Test.** READONLY sandbox; drop a file, try every edit, check `diff` shows nothing.

**Status.** untested

### AU-07 Take copies

**Goal.** «Ich brauche das Journal und die Belege von 2024 bis 2026.»

**Happy path.** Export of copies: journal, ledgers, returns, receipts, as PDF and CSV, several
years.

**What goes wrong.**

**F1. Only one year per export.** `untested`
- Noticed: she asks for five.
- By hand: five exports.
- By wish: none.
- Learns: nothing.

**F2. Receipt file names unreadable.** `untested`
- Noticed: ids instead of names.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: export.

**Test.** READONLY sandbox, Export › «Prüfung ESTV / AHV».

**Status.** untested

### AU-08 Input tax without a receipt

**Goal.** «Zeigen Sie mir alle Vorsteuern ohne Beleg.»

**Happy path.** A filter: entries with an input-tax code and no receipt, or a receipt without
Swiss VAT.

**What goes wrong.**

**F1. I81 left after unlinking.** `fails (misreads-21)`
- Noticed: no warning.
- By hand: the filter «ohne Beleg» plus the VAT filter.
- By wish: none.
- Learns: nothing.

**F2. A receipt with foreign VAT under an I81 entry.** `untested`
- Noticed: the receipt says «keine CH-MWST».
- By hand: note it.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the filter.

**Test.** READONLY sandbox on the Huber books.

**Status.** fails (misreads-21)

### AU-09 Who changed what

**Goal.** «Wer hat diese Buchung gemacht?»

**Happy path.** Each entry names its author (person, «via Claude», the run) and its history.

**What goes wrong.**

**F1. A reclassified entry has no trace.** `fails (misreads-24)`
- Noticed: no run, no author.
- By hand: git history.
- By wish: none.
- Learns: OW-32.

**F2. A hand edit shows no author.** `untested`
- Noticed: «origin manual» only.
- By hand: git.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the history.

**Test.** READONLY sandbox.

**Status.** fails (misreads-24)

### AU-10 Private shares and owner's withdrawals

**Goal.** «Wie werden private Anteile behandelt?»

**Happy path.** All 2451 movements and K81-B entries in one list, each with its reason.

**What goes wrong.**

**F1. Private shares in two shapes.** `fails (sidebar-wishes-19)`
- Noticed: some with I0, some without code.
- By hand: note it.
- By wish: none.
- Learns: one shape.

**F2. No private share on the car.** `untested`
- Noticed: a firm car and no K81-B.
- By hand: note it.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the list.

**Test.** READONLY sandbox on the Huber books.

**Status.** fails (sidebar-wishes-19)

### AU-11 Wages for the AHV audit

**Goal.** «Alle Lohnzahlungen pro Person, und was als Dividende ging.»

**Happy path.** Salary entries per person (from the bank's counterparty), social insurance
entries, dividends with withholding tax; payroll documents are outside the app.

**What goes wrong.**

**F1. Names replaced by «Mitarbeiter».** `fails (quarter-close-10), retest (0170d83)`
- Noticed: she cannot tell people apart.
- By hand: the bank lines.
- By wish: none.
- Learns: names kept.

**F2. Expense refunds booked as salary.** `untested`
- Noticed: IT-14.
- By hand: note.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the list.

**Test.** READONLY sandbox on the Huber books.

**Status.** fails (quarter-close-10)

### AU-12 Foreign currency

**Goal.** «Welcher Kurs wurde verwendet?»

**Happy path.** Each foreign entry names its rate and source («ESTV 02.10.2026»); the year-end
difference on 6960.

**What goes wrong.**

**F1. A flat legacy rate on old entries.** `untested`
- Noticed: the rate source says so.
- By hand: note.
- By wish: none.
- Learns: nothing.

**F2. A rate missing.** `untested`
- Noticed: «Kurs fehlt».
- By hand: note.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: rate and source.

**Test.** READONLY sandbox on `demo/` (Wise EUR).

**Status.** untested

## Extending the automation

The auditor changes nothing and has no AI in the export. What she would ask for becomes a
standard view of the export, built by the vendor, not a rule in the books.

| id | The auditor asks | Becomes | Check | Status |
|---|---|---|---|---|
| AU-X01 | «alle Buchungen mit Vorsteuer ohne Beleg» | a fixed filter in the export | lists exactly the entries with an input-tax code and no receipt | `untested` |
| AU-X02 | «alle Korrekturen und was sie korrigieren» | a corrections view | each correction with its original and quarter | `untested` |
| AU-X03 | «Lohnzahlungen pro Person und Jahr» | a payroll view | sums per person match the bank lines | `untested` |
| AU-X04 | «Bankmonate mit Saldo-Differenz» | a completeness view | every month listed with its state | `untested` |
