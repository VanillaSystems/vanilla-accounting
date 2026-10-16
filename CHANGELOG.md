# Changelog

What changed in each version of Vanilla Accounting. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers follow
[Semantic Versioning](https://semver.org/) as [`docs/releasing.md`](docs/releasing.md) applies
it to this project. `npm run update` prints the sections between your old version and the new one.

Two markers flag an entry you must read before you update:

- **⚠ figures**: the change alters a computed figure (a VAT Ziffer, a balance, a return) of an
  open period. A filed quarter's figures never change. After the update, `npm run test:books`
  shows the difference; check it, then accept it with `npm run test:books:update`.
- **⚠ action**: you must do something by hand, as the entry says.

## [Unreleased]

### Added

- Two more kinds of Swiss firm keep their books here. A firm **not registered for VAT** (the freelancer preset, or «nein» at setup) books every purchase and sale gross: no VAT codes anywhere, no return, no VAT questions; the MWST page says so and shows the calendar year's turnover against the CHF 100'000 registration threshold. A firm on the **Saldosteuersatz** (net tax rate method) names its one or two approved rates at setup (`--net-rate 4.5:Schreinerei`, or in the desktop form), books its sales gross with F1 (F2 for the second rate), its purchases without input tax, Bezugsteuer in 383; its returns are half years (`2026-H1`), the MWST page shows form 0553's figures, the filing workflow writes the eCH-0217 return with each rate's activity code (Firma › MWST), closes and seals by half year, and a correction carries `corrects: "2026-H1"`. The setup is one block of belege.workspace.yaml (`company.vat`) that Firma › MWST shows and changes; registration, method, period and rate hold for whole years, so a change is refused while the open year has entries. Demo books of each kind: `demo-coiffeur` and `demo-schreinerei`. The effective method's figures are unchanged. Persona requests «Coiffeur Salon Bella» and «Schreinerei mit Saldosteuersatz».

- Questions between the accountant and the owner, without e-mail. «Frage stellen» on a payment, a receipt or a booking: who asks, to whom, the question, and whether the answer is «privat» or «geschäftlich». The other person finds it under Automatisierung › Aufgaben («Fragen an dich»), counted on the dock's badge and in the status corner, and answers with one click or a few words; the asker sees it «beantwortet» under «Deine offenen Fragen» until «Erledigt». «privat» books the payment on the owner's account without VAT code and is kept as a precedent (`knowledge/rules/booking.guide.yaml`, step `private`), so the next such question about the same counterparty is answered and booked at once; «Zurücknehmen» takes both back. The questions travel with the books folder: `transactional-data/<year>/questions.jsonl`, one line per event, appended only. The KI sidebar can put such a question too (change `question`). A precedent answers only when it names one counterparty for certain: the receipt's VAT number, else its vendor, else a bank text that is not generic («Karte 5412 Einkauf», «TWINT» never answer for anyone). Persona finding treuhaender-25, -37.
- A customer payment without an invoice is asked about once. For books registered for VAT, the booking step asks the owner about each incoming payment it booked as revenue without VAT and with no receipt or invoice: «mit MWST (8.1 %)», «ohne MWST (Ausland)» or «keine MWST darauf (kein Umsatz: Darlehen, Rückzahlung …)». The app proposes one: the normal rate for francs from a Swiss or Liechtenstein IBAN, the export code for a foreign currency or IBAN. The answer books the payment so (a filed quarter, a payment with a receipt or an invoice are never changed) and is kept as a rule for that payer, keyed by its IBAN or its name (Firma › Regeln), so its next payment is booked without a question; a payer the bank names only by «Gutschrift» is asked again. The warning stays until the question is answered. The bank import now keeps the other party's IBAN of a payment in an open period. Decision 2 of the overnight log of 15.10.2026.
- **⚠ action** (books set up before this version): add the line `vanilla-accounting/transactional-data/*/questions.jsonl merge=union` to the `.gitattributes` at your repository's root, so questions asked in two clones merge without a conflict. `npm run init` writes it for new books.
- The KI sidebar knows the whole app and does what its areas do. It carries a map of every area, every Firma section and the export dialog, by the names you see, and no longer says the app writes no invoices or has no payment term. From the sidebar it now writes an invoice draft (for a customer, or a new one), sets the payment term and the invoice texts per language (Firma › Rechnungslayout, at once; the term also for every customer who had the old one), adds or renames an account of the chart (before the bookings that need it, in the same answer), sets a receipt aside as a duplicate or no receipt (its links go, its payment is booked again), packs an export preset such as the Treuhänder-Paket for download, and books again what is open through the inbox run. Each shows as a card with «Zeigen» and, where it can be taken back, «Rückgängig». Wishes test w07, w12, w13, w15, w16, w18.
- Firma › Rechnungslayout has «Zahlungsfrist in Tagen» after setup too; a new term also goes to every customer who had the old one.
- A rule's card shows what the rule would do before you keep it: the payments of this year it matches, the newest five with the booking it would make and their booking today, a changed rule as it was and as it would be, and the other rules that meet the same payments. A rule that recognises payments only by single words («Werbung»), without a business, payer or amount, is kept only with «Trotzdem behalten». Wishes test wishes3-2, -4.
- A rule can book a private share: `then: { account, vat, private: 50 }` books half on the owner's account without VAT and the rest with its VAT code. After you split a payment so (by hand or in the KI sidebar), «Immer so?» drafts that rule for the business or the payer. Wishes test wishes3-6.
- Firma › Regeln counts how often an ask rule asked («1× gefragt»). Wishes test wishes3-12.
- A rule can book a card terminal's payout as what it is («bei SumUp immer so»): `then: { account: "3400", vat: V81, fees: { account: "6840", vat: I0 } }` books the gross sales at the rule's code, a refund at its minus and the provider's fees apart, in the figures Claude reads from the payout report linked to the payment; the accounts and codes are the rule's, whatever the reading proposed. Without a report the whole payout is booked as sales until the report is linked; with a report and no Claude the payment waits. The KI sidebar drafts such a wish as this rule, not in sentences it cannot keep. Finding corner-39.
- A booking says who decided it. Buchungen › Herkunft names the rule that booked it (with the way to Firma › Regeln), the app's own check that set a sale's code, the model that booked it, or a person and the day she changed it; «Warum» quotes the rule's line, the app's words or Claude's, each as its own, and after a change by hand it says what was changed («MWST V0 → V81»). Bookings carry this as `by` from now on; older ones read as before. «Rückgängig» after a change by hand puts back who decided and why. Overnight log item 25, corner-5.

### Fixed
- The KI sidebar knows what waits under Automatisierung › Aufgaben. Each message tells it the open questions with their text and buttons as their cards show them, the workflows' tasks with the rule that held each payment, and the payments without a booking; when nothing waits, it says so. It no longer claims a question is missing that is open, nor tells you to answer one with buttons that do not exist («Verkauf im Inland»): a sale question has «mit MWST (8.1 %)», «ohne MWST (Ausland)» and «keine MWST darauf», and a correction of the sale's VAT code answers it. Persona round 4, w08, w25, x08.
- A question the KI sidebar would ask again about a payment that has one open already is not asked twice: its card shows the open one («Schon offen unter Aufgaben: …»). The sidebar can ask about a sale with the sale's own buttons; any other buttons are refused in plain words. Persona round 4, w08.
- When the app refuses an answer's change, the sidebar keeps the rest of the answer (a readiness check, what it found, what it explained) and corrects only what it said about that change. Persona round 4, w08.
- The sidebar shows bold, lists and paragraphs of an answer instead of raw `**…**`. It quotes the invoice texts with the payment term filled in, never «{days}». Firma › Regeln and «Immer so?» name a payer by name («Zahler Familie Keller»), not by its key. Persona round 4, w16, w17, r4w-8.
- Money moved between the company's own accounts (a cash withdrawal `1000 / 1020`, a transfer between banks) is booked without a VAT code, whatever the model or a rule proposed; code decides it from the chart (the bank accounts and the accounts on their line). Only new bookings: what is booked stays. The export dialog counts «Eingereichte MWST-Abrechnungen» by the returns filed in the books, not every quarter before the lock, and the «Prüfung ESTV / AHV» package now has the journal as PDF (`Daten/Buchungen.pdf`). Persona findings r4w-9, r4t-9.
- A drafted rule whose payments are booked today on two or more other accounts, or on the owner's private account, warns on its card («Zu breit? Diese Zahlungen sind heute anders gebucht, auf 2451, 6641, 6200 …»), lists those payments, and is kept only with «Trotzdem behalten»; «Speichern» refuses it unconfirmed. Before, «alles wo Karte 5412 steht ist Material» offered a plain «Behalten» although it would have booked a cash withdrawal, a private purchase and a restaurant as material: the check only reacted to single words. Persona finding x02.
- «Was war falsch?» on a filed purchase corrects its input tax where it must. **Konto** onto the owner's private account (2451) books the correction with the private-use code at the purchase's rate (`2451 / 6200 K81-B`): private spending claims no input tax, and the quarter's Korrekturabrechnung takes it back at Ziffer 415. The form fills in the code and says so («2451 ist privat: dort gibt es keine Vorsteuer …»); onto any other account bank and VAT stay as before. **MWST-Code** on a purchase booked without input tax (I0) whose linked receipt shows Swiss VAT now claims it (`6000 / 6000 I81`, Ziffer 405) and says how much, instead of a `-I0` booking with no effect. Persona findings r4t-7, r4c-37.
- An account that neither the Bilanz nor the Erfolgsrechnung shows (a closing class such as 9xxx, by the jurisdiction's chart) is refused everywhere: as a new account in Firma › Kontenplan (the form says so before you send it) and from the KI sidebar, as the account of a booking typed by hand, changed or booked on a payment, and in a rule. The refusal says what to do: «Nimm eine Nummer der Klassen 1–8, für eine Ausgabe zum Beispiel 6xxx». Before, «leg 9999 als Diverses an und buch sie dort» left the Bilanz with a difference nobody could find. An undo still puts back what was booked. Persona finding x07.
- Kontoauszüge with several statements in one month (15.10., 31.10., …): each statement opens by its own link (`/bank/1020-2026-10-15`, a statement of a whole month keeps `/bank/1020-2026-10`) with its own days, balances and payments; a payment's link (Aufgaben › «Zahlung ohne Buchung», Buchungen, Belege) opens the statement that holds it, and the payment in it. Statements that cover a month end to end no longer show it as missing. An old month link opens the month's first statement. In a narrow window the list shows short dates that no longer run into the statement's name, and the big balance moves under the title instead of being cut off. Persona finding r4t-1.
- Kontoauszüge: a long payment note wraps inside the payment's bar, at full width and narrow, and no longer runs under the payment list and its «Alle N zeigen» link.
- The app's own refusals read in plain words in all four languages, in the KI sidebar's «Nicht geändert: …» line and in the forms: what is missing and where to fill it in. «address braucht postcode, town und country» now reads «Für eine MWST-konforme Rechnung fehlt: die Adresse des Kunden mit Postleitzahl, Ort und Land. Beim Kunden unter Rechnungen › Kunden ergänzen.»; likewise a line's VAT rate, invoicing not set up, an unknown customer, a booking of 0, without an account, text or a known VAT code, an account number that is not four digits or has no name, and a receipt, booking or payment that is gone.
- Änderungen lists the bookings changed or made by hand since the last save («Bücher · von Hand»), beside the runs; each opens the booking, and «Rückgängig» puts it back as the last save holds it (a booking made since is taken out). A filed quarter is never touched. Finding corner-5.
- The KI sidebar never says it did what the app refused. When the app does not apply an answer's changes («Rechnungen sind noch nicht eingerichtet», an address without postcode), the answer's text is replaced by a short one from the model saying what is not done and why; the conversation remembers it. Wishes test 3, finding wishes3-5.
- The KI sidebar's conversation goes on across pages and a reload; «Mit KI …» adds its object to the open conversation. A new one starts with «Neu». Finding wishes3-9.
- The KI sidebar tells you to keep a rule with «Behalten» on its card, no longer «Speichern» under Änderungen; it names places as the app shows them, without web addresses or inner names, and the export card names the file instead of its path. Findings wishes3-8, wishes3-13.
- Invoices have a greeting line of their own, «Anrede» in Firma › Rechnungslayout (none by default), above the text before the table. «schreib Grüezi» sets it and keeps the text; the sidebar card shows a text before → after. Finding wishes3-10.
- A booking whose accounts, VAT code or amount you or the KI sidebar change no longer shows the classifier's old reason. Finding wishes3-11.
- A customer or supplier rule fires when the bank names the business only in the counterparty field («Bauer Michael», text «Rechnung 2026-033 …») or only by its IBAN (`match.iban`); the bank import keeps the counterparty name even when its text repeats it. Wishes test wishes3-1, -17.
- Removing or switching off an ask rule closes its open «Frag: …» questions, and the card says how many wait; «Übernehmen» books the accepted proposal and replaces a booking the app made meanwhile. The card after «Ja, entfernen» says «Entfernt.». A rule booking that fell to the zero code without a receipt says so in its reason. Wishes test wishes3-7, -11, -12.
- Money from customers is booked with its output tax. A customer payment without an invoice is no longer booked V0 (Ziffer 220, exports) «for want of a receipt»: the classifier books the app's proposal in code (francs from a Swiss or Liechtenstein account, or with no account named: 8.1 %; foreign money or a foreign IBAN: the export code) and the question to the owner says how it is booked until she answers. A client in Vaduz is domestic. An invoice that names its place of supply abroad («Leistungsort Deutschland: nicht der schweizerischen MWST unterstellt») is booked V0-E (Ziffer 221), not as an export. A card-terminal payout (SumUp and the like) is a domestic sale: its gross sales at 8.1 %, the fees apart. Books not registered for VAT book sales without a code. A correction of such a sale, by hand or by a wish, answers the app's question with the code set and keeps it as a rule for the payer, so «Neu klassifizieren» › «Trotzdem neu buchen» books it as corrected. Filed quarters and the golden master figures are unchanged. Persona test findings corner-2, 4, 13, 37, 38, 40.
- A correction of a filed booking starts with what was wrong: «MWST-Code» takes back only the tax (the expense account against itself, the code turned, the bank stays), «Konto» moves the amount to the right account, «Ganze Buchung» is the storno. A booking typed without its payment that would move a bank account says so and books only on a second ↵. The correction's page and the MWST page now both say: declared on the 0535 of the filed quarter. Persona round 3, corner-29 and 32.
- Kontoauszüge no longer says «Salden stimmen» while a booking moves a bank account without a statement line: it lists those bookings. It counts the payments of the open period without a booking, Aufgaben lists them, and a statement's payments can be filtered to the unbooked ones. Corner-9.
- The KI sidebar can book a correction on the same account on both sides (6510/6510 -I81), and an account given as a number; a side left empty is refused with the way that works. Corner-30.
- Von Hand buchen: the robot button is «Automatisch buchen», the form's own button «Von Hand buchen»; the VAT field has its label and the code's name, warns when a rate code would deduct input tax without a receipt, and fits beside the sidebar. Corner-7 and 8.
- A supplier's credit note keeps a negative total, and the refund on the bank is linked to it by code (amount, direction, its number in the payment's text) in the run that brings the statement. Corner-34 and 35.
- The Bilanz says when a bank account has no opening balance in the first year of the books, with the amount the statements imply and «Eröffnung erfassen». Corner-25.
- After a quarter is filed, receipts get in again. Every run of the inbox reads the bank statements again and rewrote every filed payment (it stripped the bank's reference, counterparty and batch parts a payment imported while its quarter was open carries), so the write door refused the whole run: «Periode geschlossen bis …: transactions … changed», no receipt was read, and Belege showed «wird gelesen …» for good. A filed payment now stays exactly as the books hold it, whatever the statement says today. A receipt whose only payment lies in a filed quarter is archived without a link and says so, with a link to that payment, where «Korrektur in <offenes Quartal> erfassen» is. A file whose run stopped shows «nicht gelesen» in Belege with the reason, «Lauf öffnen» and «Nochmals versuchen». Persona finding corner-33.
- A booking that contradicts its receipts says so. A booking you made by hand is never rebooked by itself; when a receipt with Swiss VAT is linked to a payment booked M0 or I0, or a booking claims M81 or I81 while no linked receipt shows the tax, the booking's page and its row say so and offer «Nach Beleg buchen» or «Ohne Beleg buchen», one click, with «Rückgängig». Persona findings corner-15, corner-23.
- The KI sidebar's VAT code follows the account: a booking moved to material or goods takes M, to operating costs or an investment I, with its rate, and the card says so. Wishes test w02.
- The KI sidebar never takes back a change an earlier answer of the conversation made (that change's «Rückgängig» does), never links a receipt you set aside as a duplicate, and never books on an account the chart lacks. «buch alles neu» books through the inbox run instead of relinking by hand. Wishes test w03, w06, w12.

- Belege › Angaben: the Swiss VAT choice «keine / ja» is one Tab stop; ←/→ choose, Space or Enter take the focused one (Space no longer opens the quick view), and Tab goes on to the next field. Persona finding treuhaender-6.
- The export prints the journal as PDF (per month: date, ref, text, Soll, Haben, MWST code, amount, CHF), and the Treuhänder-Paket holds it beside the Banana file and the CSV. The receipts of a period are also those of its payments and entries: an invoice dated in September and paid in October is in the Q4 package (cash basis), also one still in the inbox. Persona findings treuhaender-39, -40.
- Buchungen filters by who booked an entry: «Claude», «von Hand», «Rechnung», «Jahresabschluss», each with its count, beside «Ohne Beleg» and «Korrekturen» and the code filter; the period picker sets the dates (any range). To review what the AI booked as a list. Persona finding treuhaender-43.
- Abschluss › Abschlussbuchungen ticks a step when an entry of 31.12. books on its accounts, wherever it was booked (Buchungen, not only the step's own «Erfassen»), and names it («erfasst · in Buchungen: M2026-006», a link). What a person marked («Nicht nötig») still wins; a step without given accounts stays hers to mark. Persona finding treuhaender-29.
- Accruals and reversals without typing them twice: a new entry in Buchungen on a transitory account (1300, 1301, 2300, 2301) or a provision (2330) offers «Am 01.01.2027 zurückbuchen» (ticked for the transitory accounts), and books the reversal on 1 January of the next year in the same step, both undone together. Every entry has «Gegenbuchung» (Soll and Haben swapped, the VAT code turned, today in the open period) and «Kopieren»; an accrual booked earlier offers its reversal, or links to it once booked. Persona finding treuhaender-27.
- An entry booked in Buchungen › N for a payment's amount no longer leaves the payment «nicht gebucht» for a later run to book twice. The N form has a «Zahlung» field: search the open payments by date, amount or text, pick one, and the entry books it (its date, the bank on its side and its amount filled in, the lines must add up to it, as in «Von Hand buchen»). An unbooked payment whose amount a booking typed without a payment makes (on its bank account, within ten days) offers it: «Ist diese: M2026-001 verknüpfen» moves its entries to the payment's ref and date, with «Rückgängig». API: `POST /api/transactions/:ref/attach` with `ref`. Persona finding treuhaender-22.
- Firma › Eröffnung takes the opening balances of the books' first year by hand, for a firm whose earlier books were kept elsewhere: an account (number or name) and its balance on 1.1. as the last balance sheet shows it, ↵ sets it, × takes it out, each with «Rückgängig». Retained earnings (2970) carries the difference, so the year opens balanced. Any balance-sheet account in the base currency; not an income-statement account, not 2970 itself, not a foreign-currency account (its native balance comes from `npm run import-opening`); never a year with a filed quarter, nor a year an earlier year of the books opens. The Bilanz's difference note names its real causes (an account outside both statements such as 9100 Eröffnungsbilanz, an opening that does not balance, entries on one side only, an account missing from the chart), each with «Zeigen», instead of always counting entries without a counter account. API: `PUT /api/opening-balances/:year/:account` now takes any such account. Persona findings treuhaender-10, -23, -30.
- A bank payment can be booked by hand, without the AI, right where it shows: Kontoauszüge (the chosen payment), the task «Bewegung von Hand buchen» and a receipt's payment section carry a form with Soll, Haben (the bank already on its side), MWST (a code, or a rate such as «8.1» that becomes the code of the accounts), amount and text, on the payment's date. It opens with what rules decide: the account of the same vendor's last booking and the receipt's VAT rate. A payment splits into several lines (a Skonto, a second rate, a private share) and books only when they add up to it; ↵ books, Tab goes from field to field. The entries are a person's (`origin: manual`) with the receipts linked now, so later runs keep them. The task's «Gebucht» completes only once the payment holds a booking; without one it leads to the form, and the workflow puts the task back. API: `POST /api/transactions/:ref/entries` with `lines`. Account fields keep Tab in order (their list was a tab stop). Persona findings treuhaender-8, -9.
- Rechnungen: every choice on the invoice sheet is saved: unit, MWST rate, customer and the reason for 0 %. Before, the select showed the new value and nothing was stored, so an invoice could be issued with a rate the screen did not show. Persona findings invoices-6, invoices-17.
- A customer payment without the QR reference whose text names an open invoice («Garage Rechnung 2026-005») and pays what it owes is booked from that invoice with its VAT (V81), like a payment with the reference, instead of V0 until someone clicks «Zahlung bestätigen». The refund of a credit note («Gutschrift 2026-004», the amount it pays back) is matched to the credit note and booked with the minus code (-V81): the return lowers the turnover and the tax by it instead of declaring it as an export in Ziffer 220. A refund to the customer without the number is proposed on the credit note to confirm. A booking the classifier made for such a payment is replaced; a booking made by hand stays and is reported. Payments without any invoice keep the zero code. Persona findings invoices-20, invoices-24, invoices-29.
- «Ausstellen» with something missing names what is missing next to the button, each item a link to where it is fixed (Firma, the customer, the field on the sheet); the pay-to account is named in words, «Firma › Rechnungslayout › Rechnungen einrichten», not by a config key. Persona findings invoices-2, invoices-3, invoices-5.
- Rechnungen: an invoice still open from an earlier quarter stays in the current quarter's list and «Offen» total; the list and the invoice show «Bezahlt» right after a statement is dropped, without a reload; «PDF herunterladen» in the Mac app records the invoice as sent only when the Save dialog saved it; a reminder for an invoice never sent says so and offers to send the invoice first; a new line has no unit; a credit note's part line reads quantity 1 with a negative price, not «−1 pauschal», and its title «Gutschrift 2026-004 zu Rechnung 2026-001»; number fields select their content on focus; the sheet leaves out empty parts of the company's address; a draft dated before the last issued invoice says so. Persona findings invoices-4, 7, 11, 13, 15, 16, 19, 22, 26.
- Receipts from the phone in the Mac app: Firma › Handy switches on the phone's access (off until then) and shows a QR code. The iPhone app «Belege» pairs by scanning it, and the camera opens the scan page paired. The Mac then takes the phone's uploads on the local network, only on the paths for receipts and only with the code's token; the books stay reachable from this computer only. «Neuen Code erstellen» locks out every phone paired so far. Under `npm start`, `VANILLA_PHONE_TOKEN` in `.env` requires the token from the network. Persona findings phone-1, phone-2.

### Fixed
- The Mac app reads what arrives in the inbox by itself, from the phone or the Finder, and at start what waited, as `npm start` did; the workflows' schedules run in it too. Persona findings phone-5, phone-20.
- A phone's file with the bytes of one already there no longer stays in the inbox for ever: it is removed, and the run says «doppelt, nicht übernommen». Persona finding phone-7.
- A till receipt without a printed date takes the day the phone took it, and its detail says so, instead of the day of the run. A receipt dated "" by an older answer of the model shows under «Braucht dich» instead of in no quarter, and no file is named with zeros for its date. Persona findings phone-11, phone-13.
- A large photo or scan from the phone is made smaller before it is kept (a 9 MB scan to a fraction, still readable). Persona finding phone-15.
- Without a model (no Claude Code on this Mac), a link made or taken back by hand no longer leaves its payment silently unbooked. The run it starts books what a company rule decides; every other payment left without a booking becomes a task in Automatisierung › Aufgaben, «Zahlung ohne Buchung · von Hand buchen», with the payment's booking form, and a later link or unlink of an unbooked payment starts a run too. Persona finding corner-17.
- «Rückgängig» after deleting a receipt restores exactly: its entries come back as they were (same ids, same accounts and codes) instead of being booked again by the model; a booking you made by hand meanwhile stays. Persona finding corner-22.

- A wish «frag mich, wenn jemand mehr als 500 Franken bar abhebt» is now carried out: a rule can ask. The next matching payment is not booked; Automatisierung › Aufgaben shows «Frag: <the question>» with the booking the app would make, «Übernehmen» books it, «Selbst buchen» leaves it to you. Before, such a rule was stored as a sentence and the next 800 withdrawal was booked without asking. A rule that books («Swisscom → Konto 6510 Telefon») is now carried out by the app itself on the next matching payment, without the model, and the booking says which rule booked it. Persona finding wishes-1.
- A rule the AI drafts shows in the sidebar in one plain line with «Behalten» and «Verwerfen»: one click keeps it, without «Speichern vorbereiten» and without file names. Removing a rule is confirmed with «Ja, entfernen». A rule the app cannot carry out is refused when it is kept, with the reason. Persona findings wishes-9, wishes-10.
- Firma › Regeln (also from Automatisierung) lists every rule of the company in plain words, where it came from and how many payments it booked, with «Ausschalten» and «Löschen», each with «Rückgängig». Persona finding wishes-11.

- A camt.053 of an account the books lack: the drop row names the bank the statement gives (Acct/Svcr/FinInstnId/Nm) and asks «Gehört dieses Konto der Firma?». «Ja, Bankkonto hinzufügen» opens Firma › Bankkonten with the bank's short name, the next free bank account of the chart, the bank's name as label, IBAN and currency filled in, and a hint in an owner's words; «Nein, privat» sets the statement aside with a plain note, nothing read. Persona finding regression-17.
- The receipt detail shows the supplier's VAT number beside «✓ MWST-Nr.». Persona finding regression-6/20.
- «Rückgängig» after Belege › Löschen books the payment with the receipt again at once: the restore removes the entry booked without it in the same write and starts the run that books it, also when the delete's own run is still booking. Before, the payment kept `I0` without the receipt until some later run. Each deletion now waits in its own folder (data/trash/<id>/<deletion>/), so a file dropped and deleted again comes back with the latest «Rückgängig», and the toast of an earlier deletion says plainly that the receipt was deleted again since. Persona findings regression-14, regression-15.
- «Neu klassifizieren» no longer replaces a booking you set yourself without asking. When a payment holds a booking you made or changed by hand, or through a wish in the KI sidebar, it first shows what you set and that Claude would book the payment anew; «Meine behalten» (↵) is the default. The API refuses such a re-classify unless the request says `overwrite: true`. Persona test misreads-10/11/19.
- The classifier never books an entry without an account, nor entries that do not add up to what the bank paid. A side the model leaves empty is the bank's only when the entries then add up (a Skonto line on a payment out is the bank's debit); otherwise nothing is booked and the payment stays as it was, with the reason. The classify prompt and the booking guide say how Skonto is booked under the effective method: what the bank paid, with the receipt's code. Persona test misreads-14.
- Belege warns where an amount does not fit. In «Zahlung verknüpfen» the chosen payment says by how much its amount differs («Betrag weicht um … ab») before it is linked, the toast says it after, and the linked receipt keeps the warning; a payment up to 5 % less is noted as Skonto («2 % weniger · Skonto?»), not warned. A receipt whose Swiss VAT belongs to more than its amount (an amount typed over the invoice total) shows «MWST passt nicht zum Betrag». Fields saved one after another (each field left saves) are named together in one toast, «Gespeichert · Betrag, Datum», whose «Rückgängig» takes them all back. Usability findings misreads-22/23.
- Matching a dropped receipt sees the newest payments: a receipt whose file name has no date was shown only the books' 20 oldest payments, so none of four October receipts found its payment, not even the one whose payment text named the invoice number. The model is now shown the open payments (no receipt yet, not filed) ranked by an invoice number of the receipt in the payment text, the amount (also the total of its VAT block or its text), the vendor and the date, newest first when nothing is known. Usability finding misreads-4.
- A receipt linked to a payment by hand («Zahlung verknüpfen», the AI sidebar) books the payment again at once with what the receipt shows: an invoice with 8.1 % MWST no longer stays booked M0 without its input tax. «Lösen» and an undo do the same the other way: the booking claims no input tax without its receipt. Only the automatic booking is made again; a booking changed by hand and the filed quarters stay as they are. Usability finding misreads-8/21.
- The same receipt added twice is caught by its facts, not only by its bytes: a renamed copy, a second download, a photo of a PDF already in the books, the invoice and the payment receipt of one purchase. The drop dialog asks «möglicher Doppelbeleg von …» with «ist dasselbe» or «verschieden»; one that came in another way (a photo, mail) is not linked to a payment, and Belege asks the same. A copy gets no link and no input tax; an answer «verschieden» is not asked again.
- What is clearly no receipt by its words (a newsletter, terms and conditions, a price list or brochure, a shipping notice) goes to quarantine with what it is, from the drop and from mail collection, with «doch ein Beleg» in the dialog. An order confirmation or a delivery note is kept as a supporting document beside its invoice. The words are in the jurisdiction module (modules/ch/documents.yaml), in German, French, Italian and English.
- Firma › Quellen offers to skip a mail sender whose attachments were nearly all no receipt, with one click that keeps the mailbox switched on.
- Dropping a camt.053 of a bank account the books do not know no longer ends in a developer message: the row names the IBAN and currency in the viewer's language and offers «Bankkonto hinzufügen», which opens Firma › Bankkonten with both filled in. A refused CSV shows no kind «unbekannt», the parts of a row's line are separated by « · », and a duplicate statement no longer offers «trotzdem übernehmen».
- The receipt form saves when a field is left with Tab, as its hint says. Dates are accepted as `28.6.26` or `28.6.2026`; a wrong date or amount no longer keeps the valid fields from saving, and the earlier «Gespeichert» goes when an error shows.
- A camt.053 alone is a statement: its opening and closing balance (OPBD, CLBD) are recorded as the account's statement balances and the days between them as its period, so Kontoauszüge no longer shows the months it covers as «fehlt» and checks the balance against its closing balance. Beside the PDF statements of every month it touches it adds no row; a PDF's balance of a day wins over the camt's. The bank folder is read again on the next statement import or `npm run extract`. The Treuhänder-Paket now carries the camt as the period's statement. Usability finding quarter-close-2/3/15.
- In a booking's MWST field a rate can be typed («8.1», «8,1 %»): on a revenue account it becomes the sale code, on a material account the input-tax code for material, on an operating or investment account the one for operating costs, with a minus for a refund; the form says which code it became. The journal entry form also saves when a field is left with Tab. Usability finding quarter-close-8.
- Abschluss no longer asks books that never filed to file the quarters before their first payment: a firm starting its books with the Q3 statement sees Q1 and Q2 as «vor Beginn der Bücher». Usability finding quarter-close-20.
- «Abrechnung erstellen» in MWST: the review task says what is to pay and lists every Ziffer with an amount by name; the filing task says where the XML lies (data/filing/) and offers it as a download. The run shows the same instead of raw data. Usability finding quarter-close-19.
- The export toast says «wird gespeichert» instead of «gespeichert»: the browser or its Save dialog finishes the file after the page hands it over. Usability finding quarter-close-18.
- Booking texts name the customer, employee or supplier again instead of «Kunde» or «Mitarbeiter»: when a camt.053 payment's remittance text leaves the other party out, the payment now keeps the bank's name for it (`counterparty`, open periods only), and classify gives it to the model with the rule to write the real name. Usability finding quarter-close-10.
- At a high zoom or in a small window the top bar drops its company name and shortcut hints and the shortcut legend hides, so nothing is clipped or covered. The theme button's first click leaves «System» for the look the system does not have, so it changes the page.

### Added

- An invoice can name the date or period of the supply («Leistung 01.09.2026 – 15.09.2026»), typed on the sheet and printed on the PDF, as Art. 26 Abs. 2 lit. d MWSTG asks when it differs from the invoice date. Persona finding invoices-9.
- A receipt's VAT can be corrected by hand, without the AI: Belege › a receipt › Angaben asks «Schweizer MWST auf dem Beleg: keine / ja» and, for ja, the rate (the jurisdiction's, one line in the common case, «weiterer Satz» for more), the VAT amount (filled in from the amount: amount × rate / (100 + rate), to the cent) and the MWST number. What the owner sets is marked «von Hand» and the AI never reads it again, also not with `extract-vat --force`, «Neu lesen (KI)» or the next inbox run; facts set through the AI sidebar count as hers too. A payment the app booked with the old facts is booked again with the new ones (the inbox run, with Claude); a booking made or changed by hand and a filed quarter stay as they are. Undo in the toast puts back what the AI had read.
- Every booking the classifier makes says why on the booking page (Herkunft › Warum): the receipt it saw with the VAT facts that set the code, or that it was booked without a receipt, and the model's reason in one sentence (a new optional `reason` on the entry). It stays after «Neu klassifizieren». Persona test misreads-24.
- Customer payments booked without VAT because no invoice was linked are shown where you look: MWST names them for the period («2 Zahlungen von Kunden ohne Rechnung sind ohne MWST gebucht»), the statement's line in Automatisierung marks the run as to check, and the payment in Kontoauszüge offers «Rechnung hochladen» (the payment is then booked again with the invoice's VAT) or «keine MWST darauf» (the payment's existing «braucht keinen Beleg» mark). What gets booked does not change: without an invoice a sale is still booked at the zero code. Usability finding (Malerei Huber, invoices 2026-028 and 2026-030).
- Books that start with a bank's first camt.053 take its opening balance in one click: when the books have no opening for that account, the statement's line in Automatisierung says what the bank showed before the statement and offers «Als Eröffnungssaldo übernehmen» (undo in the toast). It becomes the account's opening of that year, retained earnings (2970) on the other side, and the balance check agrees. Not for a year with a closed period, nor for a foreign-currency account.

- A fourth starting point in «Neue Buchhaltung anlegen» and `npm run init -- --preset trades`: «Handwerk, Bau (GmbH)» (services and material, staff, private use of car and phone, effective method, quarterly, vereinnahmt), so a trades business no longer has to guess «Beratung».

- The app's icon is the brand's wave in tram blue, in the Dock and as the browser tab's icon.
- Every build says which it is and how old: `0.4.0-rc.56+g36b66d6`, built or committed when (the version worked toward, commits since
  the last release, the commit), under Firma's sections, in `npm run doctor`, in the Mac app's dmg
  name, and as `Vanilla-Build:` in every commit the app makes in the books.
- `npm run workflow -- booking <ref>` (or `--open`) books a transaction by a run of
  `workflows/booking/`: each step, its outcome and the model's answer are recorded outside the
  workspace, and `--replay <run-id>` shows what a recorded run would book today without writing.
  `npm run classify` books as before.
- A workspace can change the Swiss rules for itself in `modules/ch/` (an overlay): its own VAT
  codes, the base currency, a half-yearly return for the net tax rate method. Nothing changes for
  a workspace without one.

### Fixed

- The AI sidebar keeps a payment's bookings right. It no longer moves a payment's booking to
  another date (VAT on payments received: the booking carries the payment's date and quarter),
  and it no longer cuts a booking to the business half and stops: it can add the private half
  on the owner's account, without a VAT code, or delete a booking, and an answer that leaves a
  payment's bookings not adding up to the payment changes nothing and says why. «Rückgängig» on
  one half takes back the other. What it looked up is under «Details», closed. A vague wish gets
  a question back, and it no longer points to buttons that do not exist.

- **⚠ figures** Income booked on 7000 (Ertrag Nebenbetrieb), 8100 (betriebsfremder Ertrag) or
  8510 (ausserordentlicher Ertrag) showed as a negative amount in the income statement and the
  trial balance, so the income statement's result was too low by twice that amount. The balance
  sheet and the VAT return were right. After the update, `npm run test:books` shows the changed
  sign of these accounts in the open periods; accept it with `npm run test:books:update`.
- Belege shows a receipt in the period of its payment too: an invoice of 28 June paid on
  3 July is in Q3's list, not only in Q2's.
- «Rückgängig» on a receipt in the drop dialog books its payment again as it would be without
  the receipt; before, the payment was left with no entry at all. The same file dropped again
  in the open dialog is taken again instead of «schon da».
- Deleting a receipt in Belege books its payment again without it; before, the entry kept the
  receipt's input tax (I81) and pointed at a receipt that no longer existed. The file waits in
  the workspace's trash (`data/trash/`, 30 days) and «Rückgängig» in the toast brings receipt,
  links and booking back (`POST /api/receipts/:id/restore`).
- After «Rückgängig» in the drop dialog the Belege list no longer shows the receipt until a reload.

### Changed

- **⚠ action** The books move into a folder of their own and split by fiscal year
  ([ADR 0013](docs/adr/0013-workspace-layout-and-ownership.md)). Your books' folder becomes the
  company's repository; the books lie in its `vanilla-accounting/`: the settings and `knowledge/`
  at the top, `ledger.json`, `master-data/accounts.json`, and per year
  `transactional-data/<year>/` with the books (one record per line), receipts, bank statements,
  filed returns and seals, issued invoices and the expected figures (`golden/` is now
  `expected/`, and `npm run test:books:freeze` is `test:books:init`). Run `npm run update`: it
  moves every file with git, splits `books.json` by year, keeps a copy of it in
  `vanilla-accounting/data/backups/`, and changes no record and no seal; then commit
  (`git add -A`). `VANILLA_WORKSPACE` may keep naming the repository. Until then the app refuses
  to open the books. Afterwards `npm run doctor` lists every file that is not the app's: move
  your own notes, scripts and exports into `own/` or delete them. A closed year's files are never
  written again; a receipt or statement lies in the year of the entry that books it.
- `npm run vat-xml` and `npm run vat-report-html` write into the workspace's `data/` by default.
- A module, a workflow run or the inbox processing can no longer change or delete an entry a
  person booked by hand; only a person can.

- The Mac app has no title bar: the page reaches the window's top edge under the traffic
  lights, and a strip along the top moves the window (a double-click zooms it).

## [0.3.0] - 2026-10-11

The redesign and the Mac app. The app is one window with nine areas, each page with its own
link. It now comes as a Mac app (a `.dmg` for Apple silicon and Intel) that needs no Node.js,
Homebrew or terminal; `npm start` and the CLI work as before. Invoices are written, issued,
printed with a Swiss QR-bill, sent by e-mail through the company's own mailbox and booked when
they are paid. The app processes the inbox itself: a dropped receipt or photo is read, named,
linked and booked without `npm run extract`. Nothing for you to do: `npm run update` installs
it. Two entries carry **⚠ figures** (the demo's Q3 return, and the opening balance of Saldobilanz
and Kontoauszug for a period after 1 January); no filed figure moves. E-mail sending is optional
and reads its password from `VANILLA_SMTP_PASSWORD` in `.env` (in the Mac app, the keychain).

### Changed

- **The redesign.** The app is one window: a list on the left and the selected item on the right
  with a resizable divider (drag, ←/→, double-click resets; kept per area). Nine areas sit in a
  dock at the bottom edge (`G` + letter), and a bar at the top edge holds search, the period, the
  export, zoom, light/dark/system and the language. ⌘K finds receipts, entries, invoices,
  customers, accounts, areas and actions; `N` (or the add button) adds in every area; a toast
  offers Rückgängig (⌘Z); `?` hides the key help. Every page has its own link
  (`/journal/M2026-001`, `/vat/405?period=2026-Q3`, `/reports/balance/1021`; docs/urls.md).
  The language is no part of a link: it is chosen per viewer, and old `/<lang>/<period>/<tab>`
  links and bookmarks redirect. PDFs dropped on the page go to the inbox. A filed quarter shows
  with a lock and every edit in it is refused. The areas:
  - **Belege** (`/receipts/<id>?filter=offen&q=…`): what needs you comes first ("Braucht dich"),
    then month by month; filters `zugeordnet`, `offen`, `ohne Datum` and a search. A receipt shows
    its paper (each PDF page cut to its ink), one line of facts (date, amount, Swiss VAT, VAT
    number), its payment with links to the statement and the entry, and Zahlung, Angaben and Datei
    in the margin. `L` opens Zahlung verknüpfen with the open payments ranked by amount, date and
    currency, and "privat oder bar bezahlt" books a private outlay; an exact fit is offered as a
    suggestion (↵). A receipt paid privately by mistake is released with **Privat bezahlt
    aufheben**, which deletes its private payment (⌘Z pays it again); a private payment that is
    already booked is not deleted, its entry goes first. Link, unlink, edits and "kein Beleg" take
    effect at once and can be undone; a delete asks first. Space previews, D downloads, E edits. A
    receipt paid in a filed quarter is read only. Dropped files show as "wird gelesen" while
    the inbox processing reads them, then the receipt takes their place.
  - **Kontoauszüge** (`/bank/1021-2026-09`, `/bank/1021-2026-09/<ref>`, `/payments/<ref>`): each
    bank account's monthly statements, grouped by account or by month; a month that ended without
    its statement shows as missing, the running month with its payments. A statement shows the
    bank's opening and closing balance, whether its payments add up to them, and the books' balance
    of the account beside the bank's; its PDF with the chosen payment's line marked; its payments,
    each with its receipt, its entry, a folded Wise fee or "kein Beleg" (mark it "braucht keinen",
    ⌘Z undoes); and for a foreign account the ESTV rates its entries were booked at. A payment's
    note is written in the payment bar (Notiz, ↵ saves, Esc cancels, ⌘Z undoes). The add button,
    a drop on the page or a missing month's field read a camt.053 or a statement PDF into
    `bank-statements/<bank>/` and the books, as `npm run extract` would (`POST /api/statements`);
    a statement wholly inside a filed quarter is refused. The dock counts statements that are
    missing or do not add up.
  - **Buchungen** (`/journal/<id>`, `?vat=<code>`): the period's entries month by month as one grid
    of Datum, Text, Soll, Haben, MWST and amount, the entries of one payment joined; filters
    `ohne Beleg` and `Korrekturen`, and a search over text, accounts, code, ref and amount. An entry
    shows its Buchungssatz with the account names, the FX conversion with the ESTV check, its
    payment, receipt and paper (or the statement's excerpt when it has no receipt). Soll, Haben
    (pick by number or name), MWST, amount and text are edited in place; `N` books a new entry by
    hand (`POST /api/journal-entries`); a filed entry offers a correction in the open quarter,
    pre-filled as its reversal with `corrects`. Edit, new entry, delete and Neu klassifizieren can
    be undone. The histogram shows the period's VAT codes by count or CHF.
  - **MWST** (`/vat/<ziffer>`): one return per page, the Ziffern by part of the form with Zu
    bezahlen or Guthaben on top, and for the selected Ziffer its formula or its entries grouped by
    VAT code. An open quarter shows its due date; a filed one its lock, marks every Ziffer that
    differs from the filed return and why, and ends with the Korrekturabrechnung (form 0535,
    `/vat/0535`) with its correction cases and a print button. A return shows only for a quarter,
    half-year or year; for any other range the page offers the quarters it touches.
  - **MWST-Codes** (`/vat/codes/<code>`, **Codes erklärt** in MWST): every VAT code the app shows
    (Buchungen, a payment's entries, the entries behind a Ziffer, the cases of a
    Korrekturabrechnung) explains itself on hover: what it means, its rate, the Ziffern it feeds and
    when to use it. A click opens the catalogue by family with a search, when to use each code and
    when not, an example from the casebook, and the period's entries that use it. A code the app
    does not declare in any Ziffer (VS, F, Z codes, V81-B) shows in amber. The Ziffern come from the
    engine, so the explanation cannot drift from the return (tests/vat-codes.test.ts).
    `docs/vat-codes.md` is the same catalogue as a document; `npm run vat-codes` regenerates it and
    its data from `reference/MWST-codes.txt` and the casebook.
  - **Bilanz & ER** (`/reports/income|balance|trial[/<account>]`): the Erfolgsrechnung, Bilanz or
    Saldobilanz of any period with the selected account's ledger beside it (opening and closing
    balance, its entries). It finds an account by number ("40" finds 4000 to 4099) or name in
    whichever report holds it, shows all accounts of the chart on request, and names the entries
    booked on one side when Aktiven and Passiven differ. The Bilanz states its date ("per
    30.06.2026"). ⌘K finds every account.
  - **Abschluss** (`/close/<step>`): the year-end in seven steps: Q4, the checks computed from the
    books (with the Kursdifferenz, the VAT reconciliation, open invoices and the closing balance
    sheet), the year-end entries with prefilled forms, closing the year (it books the Kursdifferenz
    first), opening the next year, the profit allocation and the handover, whose cards open the
    export dialog (the journal for Banana, the Prüfung ESTV / AHV preset for the year).
  - **Firma** (`/company/<section>`): the profile, VAT setup, bank accounts with their last
    statement balance, the chart of accounts, periods with their seals, the opening balances,
    Rechnungslayout and Darstellung. The profile, a bank account's label and IBAN, a new bank
    account, and an account's name are changed there (`PATCH /api/workspace`,
    `PUT /api/accounts/<number>`): `belege.workspace.yaml` keeps its comments, layout and every
    field the app does not know, and a change its reader refuses is never written.
  - **Rechnungen** (`/invoices`, `?status=`): the invoices of a period by state (Überfällig first,
    then Offen, Entwürfe, Bezahlt, Gutschriften, Storniert), the open total in CHF, the customers
    (`/invoices/customers`) and every document sent (`/invoices/sent`, the stored PDF as it went
    out). An invoice shows on its A4 sheet, laid out by the same renderer as its PDF; a draft is
    edited on the sheet itself (customer, dates, texts, each line's text, quantity, unit, price and
    VAT rate, the reason for 0 %), with Vorschau, Ausstellen (what Art. 26 MWSTG still needs is
    named), Senden (by e-mail, or the PDF downloaded, and the send recorded), copy, credit note
    (whole or part, refund or set off), cancellation with a notice, reminders written on the sheet
    with a fee, comments, and payment proposals to confirm. The customer form takes addresses of
    any country (postcode, state, house number first, VAT number, language). New invoice with `N`
    or `/invoices/new?customer=<id>`. Firma › Rechnungslayout sets font, colour, logo (uploaded,
    `POST /api/workspace/logo`), envelope window and elements, and the texts above and below the
    table per language, edited on a sample sheet (`PATCH /api/workspace` writes the `invoicing`
    block).
- Periods: the period button opens a picker with presets (today, yesterday, last 7/30/90/365
  days, last week/month/quarter/12 months/year, week/month/quarter/year to date), the quarters and
  years of the books (filed ones with a lock), and a two-month calendar with typed start and end
  dates. A month (`2026-09`) and any date range (`2026-07-01_2026-09-30`) work like a quarter.
  Relative presets stay relative in a bookmark: "quarter to date" is always the current quarter.
- Exchange rates: every foreign amount explains itself on hover as "EUR amount × rate = CHF amount ·
  ESTV Devisenkurs Verkauf <date>", and Buchungen spells it out. An entry whose rate is not the
  ESTV sell rate of its payment date (a stale or flat rate) gets a warning naming the right rate;
  `npm run restamp-fx` sets it. Each foreign statement lists the rates its entries used. The audit
  export carries the rate table (`data/fx-rates.json`).
- **No program outside Node (ADR 0006 section 2).** The app reads a PDF's text with pdf.js in
  the three shapes the parsers expect (`src/parsers/pdf-text.ts`: reading order for receipts,
  content-stream order for the Wise transfer references, physical layout for statement closing
  balances), wraps a dropped photo into a PDF with pdf-lib, and does its own git with
  isomorphic-git (the repository `npm run init` makes, the commits of a year close and of the
  opening, the moves of `npm run migrate-workspace`). A scanned PDF without text goes to the
  model's vision as before. `npm run doctor` no longer asks for pdftotext or ImageMagick and
  names git as optional (`npm run update`, `npm run check-closed`). `extractionMethod:
  'pdftotext'` stays the value of a PDF's own text, so existing books load unchanged. Proven
  against the parsed results of every PDF of both demos and of a real workspace
  (`tools/pdf-text/compare.ts` reruns the comparison against an installed pdftotext).
- A Wise transfer reference on a page's last line ends at the page end; before, the page footer
  was glued to it.
- A Swiss UID wrapped after `CHE-` on an invoice is found by the knowledge routing too (the
  intake's check already allowed the break).

### Added

- Invoices (ADR 0010, ADR 0012): customers, invoices and credit notes with VAT per line in CHF or
  EUR and in German, French, Italian or English, numbered when issued (2026-001, never for a
  draft), checked against Art. 26 MWSTG before issue, frozen once issued. A draft is deleted; an
  issued invoice is cancelled (number kept, date and reason, optional notice), and a paid one is
  credited instead. Reminders in levels with an optional fee, in the invoice's language. Internal
  comments. The A4 sheet with the Swiss QR-bill (QR reference with a QR-IBAN, creditor reference
  otherwise) is printed to PDF by the Chrome, Edge, Brave or Chromium on the computer; every sent
  document is stored byte-exact with its SHA-256 and never printed again. Settings: `company.address`
  and an `invoicing` block in `belege.workspace.yaml` (docs/getting-started.md). Data:
  `invoices.json` and `invoices/` in the workspace. Routes under `/api/invoices` and
  `/api/customers`; the PDF as issued at `/invoices/<number>.pdf`.
- Paid invoices booked by their reference: `npm run extract` matches each incoming payment whose
  QR or creditor reference belongs to an issued invoice before anything else books it, marks the
  invoice paid or partly paid, books the revenue from the invoice's lines with their VAT codes
  (V81, V26, V0 for an export, V0-E for a service abroad), and files the invoice PDF as the
  entry's receipt. A payment without the reference is proposed (`GET /api/invoices/payments`) and
  booked when a person confirms it.
- **⚠ figures** (demo only): the demo company Muster Kaffee now writes invoices; two of them are
  paid by QR-bill in Q3, which adds their revenue to the demo's Q3 return. Its bank accounts carry
  valid IBANs, so the camt.053 file names changed.
- Export: one dialog for every export, from the top bar's export chip, ⇧E or ⌘K. Presets
  Treuhänder-Paket (the open quarter: reports as PDF, the journal for Banana and as CSV, payments,
  every original), Prüfung ESTV / AHV and Jahresarchiv (the year, with SHA-256 checksums and the
  filed returns and seals), Excel-Rohdaten (one workbook); save your own preset (kept in your
  browser, also in ⌘K). Choose the period (a quarter, the year, any range), the parts
  (Erfolgsrechnung, Bilanz, Saldobilanz, MWST-Abrechnungen, Kontoblatt, all Kontoblätter, journal,
  payments, receipt list, chart of accounts, the receipts, statements and filed returns as
  originals) and the formats (PDF, CSV, Excel, JSON, Banana). The app builds the files
  (`POST /api/export`): one ZIP with folders, a LIESMICH in your language, and on request
  SHA256SUMS.txt and manifest.json (`shasum -a 256 -c SHA256SUMS.txt` checks them); a single file
  is downloaded as it is. PDFs need Chrome, Edge, Brave or Chromium, as invoices do. The export
  only reads the books and works in audit mode (`npm run start:audit`). A ledger's `Herunterladen`
  (D) gives it as CSV, Excel or PDF in one click. `npm run export` writes the same Banana file;
  it now also lists entries without a bank payment (private outlays, Eigenverbrauch).
- Audit export: `npm run build:audit -- <folder>` writes a read-only copy of the books that
  runs from any static file server, without Node.js or the API. Search, filters, every report
  and the receipt PDFs work in it; the audit bar names the snapshot's date, books schema and app
  version. Its `manifest.json` holds the SHA-256 of every file and the seals of the filed
  quarters, and `npm run verify-audit -- <folder>` checks it later. Real books on a public URL
  publish them: `docs/audit-export.md` says how to hand an export over or host it behind access
  protection. Links into an export keep the path after `#`.
- Year-end close: `npm run year:close -- <year> [--dry-run]` and the Abschluss area (de, fr, it,
  en). A checklist computed from the books: the fourth quarter filed, Q1 to Q3 sealed, every bank
  account matching its statement on 31.12., the statements covering the year, every transaction
  booked, `npm run doctor` clean. It books the exchange difference (Kursdifferenz) of each
  foreign-currency account on 31.12. at the ESTV rate of that day (rerunning replaces it),
  reconciles the VAT accounts with the year's returns, guides the year-end entries (depreciation,
  accruals and deferrals, provisions, tax provision, private use, inventory, social insurance,
  doubtful accounts) as prefilled entries or "not needed", and shows the closing balance sheet
  with the VAT split off by code. Invoices still open on 31.12. are proposed as a receivables
  entry (1100 against the revenue account, no VAT code) to book or mark not needed (ADR 0010).
  "Jahr abschliessen" closes through 31.12., seals the fourth quarter and commits the workspace.
  See docs/year-end.md.
- Opening the next year: `npm run year:open -- <year>` and a step after the close. Opening
  balances from the app's own closed books: balance-sheet accounts carried, the result to 2970,
  foreign accounts at their native balance and the 31.12. rate. It reverses the receivables entry
  of 31.12. on 1.1. (revenue against 1100), so an invoice's revenue counts in the year it is paid,
  with its VAT. Rerunning updates the balances and keeps one reversal. `npm run import-opening`
  stays the way to open from Banana.
- Profit allocation after the shareholders' resolution: reserve and dividend with 35%
  Verrechnungssteuer, as guided entries in the new year.
- `npm run fetch-rates -- --year <year>`: one ESTV rate file per year
  (`reference/estv-daily-rates-<year>.json`); every year's file is read.
- **The app processes the inbox itself.** A dropped or added receipt, a statement upload and a
  scan from the phone start reading, the VAT facts, naming and linking, and booking the new
  payments (`POST /api/intake`, one job at a time); a line at the bottom left says what it does,
  and Belege has **Eingang verarbeiten** (also in ⌘K). A second run changes nothing. Without a
  working `claude` CLI the text is read, statements are imported and invoice payments matched by
  reference; the rest waits and the app says so. `npm run extract`, `extract-vat`, `match` and
  `classify` run the same steps (src/intake/) and wait for each other and for the app.
- **Invoices by e-mail** through the company's own mailbox. Firma › E-Mail-Versand holds the
  SMTP server, port, encryption, user, sender and reply-to (`outgoingMail` in
  belege.workspace.yaml); the password is not in the workspace: `VANILLA_SMTP_PASSWORD` in .env
  (.env.example). Senden, a reminder and a cancellation notice open a dialog with recipient,
  subject and text (defaults per language in Rechnungslayout); the stored PDF goes out byte for
  byte and the sent log records channel, recipient, time and Message-ID. A message the server
  refuses records nothing. PDF herunterladen stays.
- **The Mac app** (docs/desktop.md). `npm run desktop:build` makes a `.dmg` each for Apple
  silicon and Intel; the app needs no Node.js, Homebrew or terminal. It starts on a start screen:
  open existing books, set up new ones with the questions of `npm run init` as a form (it refuses
  what the wizard refuses), or look at a copy of the demo. The last books open at the next start;
  File opens others, sets up new ones, opens the demo and lists the recent ones; the window keeps
  its place. Invoice PDFs are printed by the app's own Chromium, so no browser has to be
  installed. The `claude` CLI is found through the login shell; without it, reading receipts and
  booking suggestions say what to install and everything else works. The SMTP password is saved
  in Firma › E-Mail-Versand into the Mac's keychain (sealed by the system, per books); new books
  are committed to a git repository as `npm run init` does. The release build is fused (no Node
  mode, no NODE_OPTIONS, no inspector, its code checked at start). Signing, notarization and
  updates from GitHub releases are configured and stay off until their variables are set.
- Belege takes photos: JPG, PNG and HEIC (iPhone) from the drop and the add button go into the
  inbox and become PDFs as they are read, turned upright by the photo's orientation. A photo
  put into the inbox from the Finder or the phone starts the processing as a PDF does.
- Without the `claude` CLI, a model feature (Neu lesen, Klassifizieren) answers with what to
  install instead of a failed process, also under `npm start`.
- `npm run release:github`: the GitHub release of the version in `package.json`, with that
  version's changelog section as its text and the Mac app's two `.dmg` files (and the update
  feed's files when built) as downloads, each with its SHA-256. Without `--publish` it shows the
  release and changes nothing; it refuses to publish unless the clean, tagged commit is on
  `origin/main` (docs/releasing.md).

### Removed

- The old tabs and what only they used: Transaktionen (its manual-transaction form; a payment's
  text and note are edited in Kontoauszüge), Kontenabgleich (its checks and rates live in each
  statement), the Jahresabschluss tab and its account combobox, batch rename and the
  manual-transaction batch.
- API routes no screen and no CLI calls: batch rename and rename suggest (`npm run match` names
  the files), a receipt's date suggestion and the Auslage suggestion (Belege reads both from the
  receipt), and the duplicate approval.
- Tailwind and its helpers (clsx, tailwind-merge, class-variance-authority, lucide-react): the
  styles are `tokens.css` and plain CSS per area.
- `src/parsers/pdf.ts` (pdftotext, pdftoppm and tesseract behind `extractText`): nothing called
  it. The OCR fallback is the model's vision, in `npm run extract` and in Belege.

### Fixed

- A short invoice prints on one page with its QR-bill: the sheet that carries the QR-bill has no
  footer (the QR-bill names the account, the header the VAT number), and the text starts at
  88 mm, 7 mm below the envelope window. A two-line invoice at two VAT rates took two pages.
- **⚠ figures** Saldobilanz and Kontoauszug of a period that starts after 1 January (a quarter,
  the last 30 days) open with the balance on the period's first day, not with the 1 January
  opening balance. Only these two views change; VAT figures, returns and `test:books` do not.
- `npm run extract` read a PDF under 1 KB as an iCloud placeholder and dropped it from the books
  (eight demo receipts); a file is skipped now only when it is no PDF yet. The books keep their
  receipt order, so a second run writes the same file.
- A link to an unknown Ziffer, Abschluss step or Firma section keeps its place and says it does
  not exist (urls.md rule 5); Rechnungslayout keeps logo, upload and remove on one row.

## [0.2.0] - 2026-10-09

### Added

- `books.json` and `belege.workspace.yaml` name their format version (`schema`). The app reads
  older files and migrates them in memory; it refuses a file from a newer version and says to
  update. `npm run update` writes the migrated files, with a backup in `data/backups/`.
- Seals of filed quarters: `npm run seal -- <YYYY-Qn> --close` closes a filed quarter and writes
  `filings/<year>/seal-<Qn>.json`, a hash of every entry, transaction and mapping up to its last
  day. Every load checks the seals. Books whose sealed part changed open read-only.
  `npm run doctor` reports the seals.
- `npm run update`: pulls the newest version, installs changed dependencies, migrates the
  workspace, then runs `doctor` and `test:books`. It stops at the first failure with the fix.
- `npm run init` sets up a company's workspace from 14 questions. `npm run doctor` checks the
  tools, the workspace and the mailboxes. A getting-started guide, a mailbox setup guide and a
  step-by-step quarter workflow.
- A second demo company, a one-person consultancy (`demo-consulting/`), with salaries and a
  correction (0535) paid.
- A casebook of 32 invented Swiss booking cases, checked against the VAT engine, which booking
  uses as examples when a company has little history of its own. `npm run mine-cases`.
- Bank statements (camt.053) of any Swiss bank. A statement lands on the bank account of its
  IBAN, else of its folder; nothing falls back silently.
- `npm run gaps`: the open transactions that no supplier, customer or authority file covers.
- Knowledge by role: the app ships supplier, customer and authority files (ESTV,
  Ausgleichskasse, cantonal tax office, BAZG); a workspace adds its own under `knowledge/`.
- Generic booking rules for payroll, social insurance, the VAT payment, the owner's account,
  direct taxes, refunds of sales and services abroad.

### Changed

- **⚠ action** `npm run seal -- <year>-Q4 --close` refuses: the fourth quarter closes with the
  year (`npm run year:close`), so the year-end entries can still be dated 31.12. `--force`
  closes it anyway.
- The app is called Vanilla Accounting. The workspace variable is `VANILLA_WORKSPACE`;
  `BELEGE_WORKSPACE` still works and prints a note.
- **⚠ action**: a workspace's `counterparties/` and `policy/` folders moved to
  `knowledge/{suppliers,customers,authorities,rules}/`. Run `npm run migrate-workspace` once and
  commit the workspace.
- One chart of accounts (Swiss KMU) for new workspaces. Booking works without a prior-year
  export.
- A manifest without `schema` reads as schema 1. Before, it was refused.

### Fixed

- An I-code on an investment account (1500 to 1799) is valid.
- An IMAP fetch closes the connection after a refused login.
- `doctor` treats a missing `beleg-import/` as a note: git does not keep the empty folder.

## [0.1.0] - 2026-10-09

### Added

- The first public version. Bookkeeping for a Swiss GmbH with VAT by the effective method on
  cash basis: camt.053 import (with grouped payments), receipt collection by mail, receipt
  matching and booking with Claude, the ESTV daily rate at the payment date for foreign
  currencies, the VAT Ziffern per quarter, the eCH-0217 XML for the ESTV portal, the
  Korrekturabrechnung (0535) of a filed quarter, and the period lock (`config.closedThrough`).
- A React UI with a local API server, the CLI scripts, a demo workspace, the processes in
  `processes/`, the golden master of the VAT figures, and the leak guard (`npm run check-public`).
