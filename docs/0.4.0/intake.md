# Dropping files

**Status: proposed.** Clickable mockup: screen 8 of [mockups/workflows.html](mockups/workflows.html).
The pipeline behind it is ADR 0008 (one inbox, checked before anything enters the books); this
page adds the dialog and how it hands over to the workflows of 0.4.0.

## The dialog

1. **Drop anywhere.** Files dropped on any area open the dialog **Dateien hinzufügen**. It stays
   open; every further drop, onto the window or the dialog, extends the list. A ZIP is unpacked
   into its files.
2. **Each file is recognized at once**, cheaply first (ADR 0008 §2): *Struktur* (camt.053 by its
   XML namespace, a Wise export, a known bank PDF layout), *Hinweise* (page count, words such as
   «Preisliste»), *KI* only for the rest, marked with the bot icon. Each row shows the kind, how
   it was recognized, and the key facts (supplier, date, amount; account and period for a
   statement).
3. **Each row names the workflow it will start**, as a chip that opens the workflow:
   → *Beleg aufnehmen*, → *Kontoauszug einlesen*. A file that will not be taken says what happens
   instead: → nicht übernommen, → Quarantäne, kein Ablauf, → wartet im Eingang, → wird entpackt.
   Above the buttons, one line sums it up: "Startet Beleg aufnehmen 2 · Kontoauszug einlesen 2 ·
   danach, wenn der Zeitraum vollständig ist: Zuordnen und buchen (von Hand) → Buchen (von
   selbst)". When the files are in, «Oktober zuordnen und buchen…» shows whether the period is
   complete and starts the matching (workflows.md, "Matching is started by a person"). The person learns the workflows' names where
   they start, without a separate explanation. The names come from each `workflow.yaml`, and
   the follow-on chain from the workflows' `on:` and `emits:`, as on the process map.
4. **Each problem has its own small action in the row:**

   | Row | Action |
   |---|---|
   | duplicate by its bytes (the same checksum) | not taken; «trotzdem übernehmen» |
   | possible duplicate by its facts (the same text, or the same total within days and a number only the two carry; src/intake/duplicates.ts) | «möglicher Doppelbeleg von …»: «ist dasselbe» (not taken) or «verschieden» (taken; the pair is remembered on the receipt of the books and not asked again) |
   | order confirmation, delivery note (by its words, modules/ch/documents.yaml) | taken; the read step makes it kind `supporting`, shown beside its invoice, never paid on its own |
   | PDF with a password | a password field; the original is stored, not the decrypted copy |
   | unsure kind | the two likely kinds as buttons |
   | not a receipt by its words (newsletter, terms, price list or brochure, shipping notice; src/intake/document-kind.ts) | quarantine with what it is; «doch ein Beleg» |
   | own photo or scan | made smaller before its id; a received PDF stays byte for byte |
   | statement without camt.053: a PDF, scan or photo of any bank (#217) | the AI reads it into its movements, balances and page carry-overs; code checks they add up to the cent; the row shows the table «aus PDF gelesen», each line correctable, the gap named by page; «Einlesen» once it adds up writes the camt.053 the bank did not give beside the PDF and reads it like any other; a line the books hold is «schon in den Büchern», not added twice. Without AI (named with Firma › KI) the same table is typed by hand, or the PDF kept as the month's statement («Als Monatsauszug behalten»). A PDF whose days a bank's camt.053 covers, in part or whole, is kept as that month's statement, not read; one found covered only by the IBAN and days the read gives imports no movement (a value date read would double a payment) and offers «Als Monatsauszug behalten». A card charge's amount in another currency, where printed, goes into the written camt.053 as its InstdAmt. Kontoauszüge › upload hands a PDF no camt.053 covers to this dialog. A taken receipt, photo or scan: «Ist ein Kontoauszug» |
   | a bank's CSV (#217) | which column holds what, asked once and kept per account (`knowledge/bank-csv.yaml`); then the same table |
   | a statement PDF of an account with a camt.053 or bank CSV (#254) | kept as its statement without a question, in any order and any session; read only when its words do not name the account and days. «Bewegungen aus dem PDF einlesen» («Aktionen» of the PDF, here and under Kontoauszüge) reads it on request; its days the camt.053 or CSV covers add nothing new |
   | a statement PDF of an account without either (#254) | kept as its statement at once; the question whether its movements are read in waits in the books with the table (`statementAsks`), here and under Kontoauszüge, after closing and after a restart; the account's first camt.053 or CSV closes it as kept, takes the movements read before it (same day and amount, the payee deciding between equal amounts, or a few days off with the app's bookings), asks «Ist das dieselbe Zahlung?» of one it holds otherwise (a few Rappen off, in parts, split, a tie, or booked by a person) and books neither until answered, and keeps one it lacks as a movement of its own for the person to keep or remove |

5. **Tabs by category:** Alle, **Bankdaten** (camt.053, Wise exports), **Kontoauszüge** (PDF),
   **Belege** (receipts, invoices, supporting documents), **Unklar** (shown only while a file has
   no kind), **Nicht übernommen** (duplicates, quarantine). Each tab shows its count and a dot
   when something in it needs the person, and says which workflow takes its files next. A file
   whose kind is changed moves to its tab.
6. **Quick edits:** «Ändern» on a row edits its name and kind; × removes it. Nothing is written
   while the dialog is open.
7. **«Hinzufügen»** moves the files into the inbox, which starts the workflows by their
   `outside:` trigger: receipts run through *Beleg aufnehmen*, statements and camt files through
   *Kontoauszug einlesen*. Rows that still need a person wait in the inbox with their question.
8. **The dialog shows the runs' progress**, or closes and lets them run in the background (the
   dock shows them). When they finish: "4 übernommen · Lauf 0314 · Lauf 0315", and a link to
   Änderungen, where the result waits unsaved like any other work ([saving.md](saving.md)).

The dialog is anchored a fixed distance below the top of the window and grows downward with its
list. At its full height the space above and below it is the same, and the list scrolls inside
it. It never re-centres, so switching tabs or adding files does not move
it. Every dialog of the app follows the same rule.

## Processing, progress and alerts

- **Processing starts at once** with «Hinzufügen». Nothing waits in a queue for later.
- **Progress:** each file has its own bar and current step ("2/5 · MWST-Fakten gelesen"); the
  dialog header has an overall bar ("Gesamt 62 % · 3 von 4 Dateien fertig"), weighted by the
  steps of each file's workflow. A file that stopped (waiting) counts as finished for the bar.
- **In the background:** «Im Hintergrund weiter», or leaving the area, keeps the runs going. A
  chip in the title bar shows "Import läuft · 62 %" with a small bar and reopens the dialog.
- **When it ends**, the chip says "Import fertig · 1 braucht dich"; if the person is elsewhere, a
  notification says the same, with «Ansehen».
- **How a file ends** follows the three states of a run ([workflows.md](workflows.md), "When a
  run needs a person"):

  | End | Example | Alert |
  |---|---|---|
  | gebucht | a receipt booked against its bank transaction | none |
  | wartet (by itself) | a receipt before its bank transaction | none; it goes on when the statement arrives |
  | braucht dich | a statement's balance differs by 0.35 | a task, the notification, «Aufgabe öffnen» |
  | steckt | an error in the workflow | red, a notification, and the run goes to whoever maintains the workflow |

- **Nothing is lost.** Each file is one transaction, and runs survive closing the app; they go on
  at the next start.

## ZIP files

- **A ZIP is a container, not a document.** The dialog unpacks it at once; each file inside
  becomes its own row, recognized and sorted into its tab, marked «aus <name>.zip». The ZIP
  itself is not kept; the files inside are stored byte for byte as received.
- **A password-protected ZIP** shows a password field in its row. The password is used only to
  unpack and is never stored. ZipCrypto and AES archives are both read.
- **Limits:** a ZIP inside a ZIP is unpacked too, up to three levels. An archive that would
  unpack beyond a size limit (a zip bomb) is refused with the reason. 7z and RAR are refused
  with "bitte als ZIP".
- A protected PDF inside a ZIP asks for its own password in its own row.

## Errors: every file ends somewhere visible

Nothing is silently dropped, and no file holds up the others. A file that is not taken ends in
exactly one of three places, each with its reason:

| Place | When | What the person can do |
|---|---|---|
| **Waits in the inbox**, as a task | a ZIP or PDF whose password was not given; a kind nobody chose; a fact that is missing | give the password or the answer later; the file then runs as if just dropped |
| **Quarantine** (`data/quarantine/`, outside git) | not a receipt (a photo without amounts, a price list, a catalogue); a duplicate | «doch übernehmen», at any time |
| **Refused**, not stored | an unsupported type (Word, Excel, an app, 7z, RAR); a damaged file that cannot be read; an archive over the size limit | nothing to undo: the original stays where it came from; the reason says what would work ("bitte als ZIP", "bitte als PDF") |

- **A wrong password** keeps the row as it is, with "Passwort falsch"; there is no lockout, and
  the password is never stored.
- **The contents of a ZIP** go through the same recognition as dropped files: a receipt inside is
  taken, a photo inside goes to quarantine, a Word file inside is refused. Each is its own row
  with "aus <name>.zip".

## What stays the same as ADR 0008

The inbox is `beleg-import/`, outside git. The drop zone, the folder, mail collection and the
phone upload all deliver into it; nothing goes from a channel straight into the books. Quarantine
is `data/quarantine/`, outside git, with the reason.

## Duplicates and non-receipts past the drop

The drop judges a PDF by its own text, before anything is written, so the person answers in the
row. A photo has no text until the run's reading, and mail, the Finder and the phone bypass the
dialog, so the same checks run again later:

- **Mail collection** (src/platform/sources/host.ts) puts an attachment whose words say it is no
  receipt into `data/quarantine/` instead of the inbox; its ledger line keeps the sender. When 3
  or more of one sender's attachments, and nearly all of them, were no receipt (quarantined, or
  marked so by a person in Belege), Firma › Quellen offers to skip that address: one click adds it
  to `reach.mail.skip` and, since that only narrows the reach, switches the new version on.
- **The read step** makes an order confirmation or delivery note kind `supporting`, and a text the
  model read off a photo that says it is no receipt kind `noise` (both by rule; a person's kind wins).
- **The matching step** asks the duplicate check with the facts the model read: a possible copy is
  archived but linked to nothing. Belege shows «möglicher Doppelbeleg von …» on it, derived from
  the books every time (`ReceiptView.twin`): «ist dasselbe» makes it kind `duplicate` and removes
  its links and the entries booked with it (POST /api/receipts/:id/twin), «verschieden» stores the
  pair in `distinctFrom` of the receipt in the open period. A receipt of kind `duplicate` never
  reaches the booking's prompt, so it never claims input tax.

## Open

- Whether the dialog may run the model on a large drop before «Hinzufügen» (cost), or only
  recognize by structure and hints and leave the rest to the workflow.
