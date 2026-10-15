# Usability test 2026-10-15: Malerei Huber GmbH

A persona test of the packed app (0.4.0-rc.88-g89a9e3e, arm64 dmg) on a fresh Mac VM, driven with
the verify skill's desktop surface (`.claude/skills/verify/vm.sh`). The persona: Sandra Huber does
the office of a painting firm with two employees in Wil SG; not technical, makes mistakes. Her
files are made up (`.claude/skills/verify/persona-files.mjs`). Screenshots stay local in
`.verify/evidence/persona-2026-10-15/` (the numbers in the Shot column).

Covered: download, install, first start, setup, dropping the statement and receipts, a receipt's
detail, the AI sidebar. Not yet: Kontoauszüge, Buchungen, MWST, Rechnungen, Abschluss, Änderungen
(they need Claude Code in the VM to have read receipts).

Severity: blocker (she stops), high (she is stuck or misled), medium (friction), low (polish),
good (keep).

| # | Area | Severity | Finding | Shot |
|---|------|----------|---------|------|
| 1 | install | blocker | Unsigned app: macOS says it "can't be opened", only "OK" or "Show in Finder"; nothing tells the owner what to do next. | 02 |
| 2 | install | high | The way through is System Settings → Privacy & Security → scroll → "Open Anyway" → "Are you sure" → admin password ("may cause harm to your Mac"). Three scary warnings; a careful owner stops here. | 03–07 |
| 3 | install | medium | Double-clicking the app inside the dmg runs it from the disk image; nothing says "move me to Applications". After eject/restart the app is gone. | 08 |
| 4 | start | low | Start screen in English on an English Mac; fine, but the Swiss owner looks for DE (top right, small). | 08 |
| 5 | start | medium | "Open existing books: Pick the folder that holds belege.workspace.yaml" is developer language. | 08 |
| 6 | install | high | After moving the app to Applications (as one should), macOS blocks it again: the whole warning/Open Anyway/password round repeats. | 12 |
| 7 | setup | low | The setup form's "Language of the app: DE" is preselected while the page itself is English; clicking DE at the top did not switch (notification overlay ate the click, needs a retest). | 10 |
| 8 | setup | medium | No preset for trades (Handwerk/Malerei/Bau): only Consulting, Webshop, Freelancer. A painter with material + labour guesses "Consulting". | 10 |
| 9 | setup | low | Quitting mid-setup loses everything typed (no draft). | 12 |
| 10 | setup | high | Saldosteuersatz is not supported. Most small trades businesses (painters too) use it, often half-yearly. The note says "if you switch to the effective method at the ESTV, set up the books again", which an owner won't do for an app. Effectively: the app is not for her. | 16b |
| 11 | setup | low | Jargon in good explanations: vereinnahmt/vereinbart, Durchlaufkonto (1093), Eigenverbrauch Code K81-B. The explanations help; the codes and account numbers frighten. | 15 |
| 12 | setup | high | "Buchhaltung anlegen" with an error far up the form (UID) does nothing visible: no scroll to the error, no summary next to the button. The owner clicks again and again. | 22 |
| 13 | setup | low | The IBAN error colours the whole bank row (also the correct "Raiffeisen" and "CHF") orange. | 20 |
| 14 | setup | good | IBAN and UID check digits are validated with clear messages. | 20 |
| 15 | first run | high | After setup the app lands on "Belege Q4 2026": empty, and the right half stays blank. No "first steps" (1. load the bank statement, 2. drop the receipts, 3. check). The owner wants to do Q3 and doesn't see how. | 25 |
| 16 | first run | medium | On a 13" window the list header wraps ("Q4 / 2026", "noch / leer"); the sidebar icons have no labels. | 25 |
| 17 | drop | medium | The drop overlay still says "übernommen wird erst mit «Hinzufügen»"; files are taken immediately now. Stale text. | 24 |
| 18 | drop | high | Photos and PDFs hung at "liest 1 …" forever in the first app session (POST /api/drop/…/files never answered); after an app restart the same file went through. Not yet reproduced. | 31 |
| 19 | drop | medium | CSV bank export: "unbekannt · nicht gespeichert · bitte als PDF oder Foto". Wrong advice: it should say "Kontoauszug als camt.053 (XML) im E-Banking herunterladen". The CSV row also appeared twice for one pick. | 30 |
| 21 | drop | medium | Statement taken: "eingelesen" but no summary (how many payments, which months, balance ok?). Tab says Bankdaten 1, Kontoauszüge 0 for a Kontoauszug. | 36 |
| 22 | receipts | high | Without Claude installed a receipt stays "ohne Datum", no amount, no vendor, and nothing tells the owner that reading needs Claude, or how to get it. | 33 |
| 23 | receipts | blocker | Without Claude a clear text PDF (date, total, CHE-…MWST all in its text) shows "Datum fehlt · Betrag fehlt · keine CH-MWST". The last claim is false and would make her lose input tax. A plain-text parse (date, Total CHF, CHE-###.###.### MWST) needs no model. | 39 |
| 24 | drop | medium | All 6 PDFs: "wartet auf dich" with no reason on the row; she has to open each one to learn it lacks a date. | 37 |
| 25 | drop | medium | Photos stay "in Arbeit" for minutes (no Claude), never an end state or a hint. The holiday photo is "Foto eines Belegs". | 38 |
| 26 | drop | medium | A .docx is labelled "ZIP · Struktur · beschädigt, nicht lesbar"; a real .docx is a ZIP and would be unpacked into XML files. Word/Excel files need their own "kein Beleg: als PDF speichern" answer. "Struktur" tag is jargon. | 38 |
| 27 | drop | good | Duplicates (same bytes, also "(1)" copies) are caught: "schon da · schon in den Büchern oder im Eingang", with "trotzdem übernehmen". Every row has Rückgängig and "Beleg öffnen →". | 37 |
| 28 | receipts | high | All 10 receipts hide behind a grey line "10 ohne Datum, zählen erst mit Datum · zeigen"; the list looks empty right after she added them. | 40 |
| 29 | ai | blocker | The sidebar needs Claude Code: "installieren und einmal im Terminal mit „claude" anmelden". Terminal + developer tool + subscription: the owner stops here. Reading receipts needs the same. | 42 |
| 30 | ai | blocker | By design the sidebar never changes the books (src/assistant/claude.ts:36-42): "Fragen" says "switch to Ändern"; "Ändern" only drafts rules/settings into data/draft/ for saving under Änderungen. "This invoice is wrong, change it to …" cannot be fulfilled. | 42 |
| 31 | ai | medium | Opening the sidebar squeezes the receipt detail into a one-word-wide column; the top bar overlaps the detail. Fragen/Ändern toggle is a choice the owner shouldn't have to make. | 41 |
| 32 | layout | low | A horizontal scrollbar under the list on a 1024-pt-wide window. | 33 |
