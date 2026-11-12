# Getting started

This guide takes you from the download to your first VAT return, in the Mac app. It is for the
person who keeps the books of a small Swiss company: you need no terminal and no accounting
training. The words in «guillemets» are the words on the screen, in German as the app shows them
(the app also speaks French, Italian and English).

Vanilla Accounting keeps the books of a GmbH, an AG or an Einzelfirma that

- is registered for VAT on the effective method (a return every quarter) or on the
  Saldosteuersatz (a return every half year), on vereinnahmte or vereinbarte Entgelte, or
- is not registered for VAT at all.

Read [Limits](#limits) before you start. To run the app from its source code, or to work with
commands, see [From the source](from-source.md).

## 1. Install the app

1. Download the `.dmg` from the
   [Releases page](../../../releases): `arm64` for a
   Mac with Apple silicon (M1 and later), `x64` for an Intel Mac.
2. Open the `.dmg` and drag **Vanilla Accounting** into Applications.
3. Start it. The app is not signed with an Apple Developer ID yet, so macOS refuses it the first
   time. Open it once and click **Done**, then go to System Settings › Privacy & Security and
   click **Open Anyway** next to "Vanilla Accounting was blocked".

You install nothing else: no Node.js, no Homebrew. macOS may ask whether the app may access the
folder your books are in (Documents, for example). Allow it, or the app cannot read and write the
books.

## 2. The first screen

At its first start the app has no books yet. The first screen leads to one of three things:

- **New books** for your company: the app asks about the company and creates the folder
  (step 3).
- **Books you already have:** you choose their folder and the app opens it.
- **The demo:** a made-up company with receipts, statements and invoices. You work in a copy, so
  try anything.

The app also offers to set up the AI (step 4). You can do that now or later.

At the next start the app opens the books you used last. The menu File has «Neue Buchhaltung…»
and «Buchhaltung öffnen…» for other books.

## 3. Set up your books

The app asks about your company in a conversation. With an AI you can answer in your own words
and ask back when a question is unclear («was heisst das?»). Without one you answer with buttons
and fields. Either way the answers end in one summary you can change line by line before the app
creates the books.

What it asks:

- **Who the company is:** its name as in the commercial register, the owner or managing
  director, and the UID (CHE-123.456.789; it is on your commercial register extract and on
  [uid.admin.ch](https://www.uid.admin.ch)).
- **Its VAT setup:** whether it is registered for VAT, on which method (effective or
  Saldosteuersatz), whether it reports on vereinbarte or vereinnahmte Entgelte, and how often it
  files. All of this is on your last VAT return and on the ESTV's letters. If you are not sure,
  ask your Treuhänder before you answer: the setup holds for the whole year, and the app refuses
  a change once the year has bookings.
- **How it works:** what it sells, whether it has customers abroad, imports goods, has
  employees, and whether the owner pays business costs privately. These answers pick the
  accounts of your chart and how the app books.
- **Its bank accounts:** one per bank and currency, with the IBAN. The IBAN is how a statement
  finds its account.
- **Where the books are kept:** a folder on your Mac. Everything is in that folder: the books,
  the receipts, the statements, the filed returns. Nothing is stored anywhere else, so that
  folder is what you back up.

After the books are created the app asks a few more things that depend on your answers, for
example about a move from another program. You can put them off. What you put off stays reachable
under **Firma** (`G F`): the VAT setup in «MWST», the bank accounts in «Geldkonten», the opening
balances in «Eröffnung».

**If the company existed before this year,** the books need its opening balances of 1 January:
the balance sheet of 31 December from your previous program or your Treuhänder. Enter them in
Firma › «Eröffnung». For a bank account, the first statement you read in offers its starting
balance as the opening balance. Without the opening, the app's bank balance differs from the
bank's, and the app says so on the statement.

## 4. The AI

**What it is for.** The AI reads your receipts (the date, the amount, the VAT), finds the payment
each one belongs to, and proposes how to book each payment. It reads a bank statement you only
have as a PDF or on paper. It answers in the «KI» column at the side (`⌘J`), where you can ask
for a report or say a wish in your own words («buch Swisscom immer auf Telefon»).

**What works without it.** Everything else: statements in the bank's camt.053 format, the
journal, invoices, the VAT return, the reports, the year-end. Where the AI would have done
something, the app says so and offers the way by hand, for example «Von Hand erfassen» for a
receipt and «Von Hand buchen» for a payment.

**What it costs.** The app itself is free. The AI runs on your own subscription with its maker:

- **Claude Code**, with Claude Pro or higher from Anthropic, about USD 20 a month, or
- **Codex**, with ChatGPT Plus or higher from OpenAI, about USD 20 a month.

One of the two is enough. «Erweitert: mit API-Schlüssel» is a third way for people who already
pay Anthropic or OpenAI per call; the «KI» column does not work with a key alone.

**How the app sets it up.** Each program has a card that shows where you are.

1. Click «Claude Code installieren» (or «Codex installieren»). The app opens the Terminal with
   the official installer command of the maker written out. Nothing runs until you press Enter
   there.
2. Press Enter in the Terminal and wait until it is done. The app notices by itself; you do not
   restart it.
3. Click «Anmelden». Your browser opens the maker's page. Sign in with your account there (or
   create one and choose the subscription). The app never sees your password or your login.
4. The app makes one short test call. The card then says «bereit».

If the account has no subscription that includes the program, the card shows what the program
answered and what it needs.

**It can wait.** «Ohne KI weiter» goes on with buttons and fields, and the app does not ask
again. Set the AI up whenever you want under Firma › «KI».

## 5. Read in your first bank statement

Start with the bank. The statement lists every payment, so the app can tell you which receipts
are missing.

Open **Kontoauszüge** (`G K`) and drag the file onto the page, or click «Auszug» (`N`). The app
takes:

- **camt.053**, an XML file from your e-banking. This is the best way: it needs no AI and brings
  every payment with the bank's opening and closing balance. In the e-banking, look for the
  account statement or the account export and choose camt.053. Some banks call it ISO 20022,
  XML or «elektronischer Kontoauszug», and some switch it on only when you ask. Choose camt.053,
  not camt.054 or camt.052: those are notifications, and the app skips them. At Wise, download
  one statement per currency.
- **A PDF of the statement, of any bank,** when you have no camt.053. The AI reads the payments
  and the balances, and the app checks that they add up to the cent, page by page. The row shows
  the payments as a table marked «aus PDF gelesen», where you can correct a line. «Einlesen»
  imports the statement once it adds up. The AI reads at most 20 pages of one statement and says
  so when a statement is longer.
- **A scan or a photo of a paper statement.** Drop it the same way. If the app takes it for a
  receipt, «Ist ein Kontoauszug» on that receipt turns it into a statement.
- **Without an AI and without camt.053:** fill the same table by hand, or drop the bank's CSV
  export. The app asks once which column holds what and remembers it for that account.

A statement of an account the books do not know names the IBAN and offers «Bankkonto
hinzufügen». The same statement dropped twice is read once.

Kontoauszüge then shows each account month by month: the bank's opening and closing balance,
whether the payments add up to them («Salden stimmen»), the books' balance beside the bank's,
and a month without a statement as «fehlt». The page shows one period at a time. A statement of
an earlier quarter is listed under that quarter: choose the period in the bar at the top edge of
the window.

## 6. Add your first receipts

Open **Belege** (`G B`). With no receipt yet it shows «So kommen Belege in die App», three ways
you can use together:

- **«Hierher ziehen»:** drag PDFs and photos (JPG, PNG, HEIC) onto the page, from the Finder or
  from a mail, several at once or a whole folder. «Dateien wählen» opens the file dialog. This
  works on every page of the app; a statement among the files is recognised as one.
- **«Mit dem Handy»:** «Handy koppeln» shows a code for your phone's camera. The phone then
  sends photos of till slips straight into the app while both are on the same Wi-Fi. Firma ›
  «Handy» switches the phone's access on and off.
- **«Automatisierung»:** the app fetches invoices from a mailbox. In the Mac app this is not
  finished, see [Limits](#limits). Until then, drag the invoices out of your mail program.

Add every invoice, every till slip and every customs bill. A receipt is what lets you deduct the
VAT you paid: without a receipt that shows Swiss VAT, the app claims no input tax.

## 7. What the app does by itself, and what it asks you

After every drop the app works through what arrived. A window lists each file and what became
of it, and a line at the bottom left says what the app is doing. With an AI it

1. reads each receipt: the date, the amount, the Swiss VAT and the VAT number;
2. links each receipt to its payment and gives the file a clear name;
3. books each payment: the accounts, the VAT code and, for a foreign currency, the ESTV's
   exchange rate of the day.

It sets aside what is no receipt (terms and conditions, a newsletter, a second copy).

A payment that needs a receipt is not booked until the receipt is there. It waits, and the app
books it the moment you add the receipt. Money you received, the bank's own fees and transfers
between your accounts need none.

**«Braucht dich»** is the group at the top of Belege with what only you can decide:

- a receipt without a payment: «Zahlung verknüpfen» (`L`) links one, or books it as paid
  privately or in cash;
- a payment without a receipt: add the receipt, or say on the payment that it «Braucht keinen
  Beleg»;
- a question in plain words with a proposed answer, for example «… hat CHF … am
  … bezahlt, ohne Rechnung in den Büchern. War das ein Verkauf mit MWST?». One click answers it
  and books the payment.

The dock shows how many points wait «für dich»; a click leads to them. They are also listed as
«Aufgaben» in **Automatisierung** (`G W`). Two weeks before a return is due, a payment still
without its receipt becomes a task «Beleg fehlt» with three ways on: «Beleg zuordnen», «Mit
anderem Nachweis» and «Ohne Vorsteuer buchen».

**Check the result** in **Buchungen** (`G U`). Change an account or a VAT code in place when the
app got it wrong. After a correction the app offers «Ins Wissen übernehmen?», so the next
payment of that business is booked your way. A wish works too: write «buch Swisscom immer auf
Telefon» in the «KI» column, look at the card that shows which payments the rule would match,
and click «Behalten». Firma › «Regeln» lists every rule, and «Neue Regel» there makes one without
the AI.

### Find your way in the app

A page is a list on the left and the selected item on the right; drag the divider to resize it.
The areas sit in the dock at the bottom edge of the window. Click one, or press `G` and then its
letter:

| Key | Area | What is there |
|---|---|---|
| `G B` | Belege | The receipts, and first what needs you |
| `G I` | Rechnungen | Invoices you write, customers, what was sent |
| `G K` | Kontoauszüge | The bank statements and their payments |
| `G U` | Buchungen | The journal |
| `G M` | MWST | The VAT return of a period, with the bookings behind each figure |
| `G R` | Bilanz & ER | Erfolgsrechnung, Bilanz, Saldobilanz, each account's ledger, your own reports |
| `G A` | Abschluss | The year-end |
| `G W` | Automatisierung | What the app does by itself, its runs, and the tasks that wait for you |
| `G P` | Geschäftspartner | Suppliers, customers and authorities: notes, rules, bookings |
| `G E` | Wissen | How your company works, as the app has learned it |
| `G V` | Änderungen | What changed in rules and settings, and saving it |
| `G F` | Firma | The company's profile, VAT setup, bank accounts, chart of accounts, invoice layout, the AI |

A bar at the top edge, which shows when you move the mouse there, holds the search, the period,
the export, zoom, light or dark, and the language. A list shows the open period unless you
choose another one there.

| Key | Does |
|---|---|
| `⌘K` | Find a receipt, booking, invoice, account, area or action |
| `⌘J` | Open or close the «KI» column |
| `↑` `↓` or `J` `K` | Move through the list; `Esc` goes back from the detail to the list |
| `N` | Add: a receipt, a statement, a booking, an invoice, depending on the area |
| `/` | Search the list |
| `⌘Z` | Undo the last change (the message says what it was) |
| `⇧E` | Export: reports, the journal, receipts, a package for your Treuhänder |
| `T` | Light or dark |
| `⌘+` `⌘−` `⌘0` | Zoom |
| `?` | Show or hide the key help at the bottom |

## 8. File the VAT return

A return is prepared once its period has ended. Open **MWST** (`G M`). It shows one period: what
is to pay on top, the figures (Ziffern) of the ESTV form below, and for each figure the bookings
behind it. A quarter that has ended and is not filed shows as «… nicht eingereicht · fällig …»;
click it to open it. A period still running says «läuft noch bis …».

1. **Check the figures.** The turnover (Ziffer 200) should match your sales of the period.
   Every input tax (Ziffern 400 and 405) needs a receipt with Swiss VAT. Open a figure that
   surprises you and look at its bookings.
2. Click **«Abrechnung erstellen»**. The app starts «MWST abrechnen» and stops at a task for
   you, «Abrechnung … prüfen». Open it («Aufgabe öffnen»; it is also under «Aufgaben» in
   Automatisierung). It says what is to pay and lists every figure by name, and what is still
   open in the period: payments without a booking, receipts without a payment.
3. Click **«Freigegeben»** when the figures are right. The button is not there while a VAT
   question of the period is unanswered: answer it first. From this click on the period is
   held: nothing in it changes until you have filed, or until you click «Zurück» to go on
   working in it.
4. The next task, «Abrechnung … einreichen», offers the file for the ESTV as a download («…
   laden»). Log in to the ESTV's ePortal, open «MWST abrechnen» for the period and upload the
   file. Compare the figures the portal shows with the app's. If they differ, do not submit.
5. Submit the return at the ESTV and pay the amount. Both are due 60 days after the period
   ends.
6. Back in the app, click **«Eingereicht»** and confirm with «Ja, eingereicht». The app keeps
   the filed return, closes the period and seals it.

From then on that period never changes: the app shows it with a lock and refuses every edit in
it. When you find a mistake later, you correct it in the open period: a filed booking offers
«Korrektur in … erfassen», and MWST shows the difference on the Korrekturabrechnung (ESTV form
0535) of the filed period.

The last period of the year is filed the same way, but the year-end closes and seals it, so the
year-end bookings can still be dated 31 December ([year-end.md](year-end.md)).

On the Saldosteuersatz the return needs the ESTV's activity code of each rate (five characters,
on the ESTV's letter that approved the rate). Enter it in Firma › «MWST»; «Freigegeben» appears
once it is there. A company that is not registered files nothing: MWST shows the year's turnover
against the limit for registration.

[The quarter, step by step](quarter-workflow.md) goes through a whole quarter in more detail.

## 9. Write invoices

Open **Firma** (`G F`) first:

- «Firma»: the company's address. An invoice needs it.
- «Rechnungslayout»: the first time, «Rechnungen einrichten» asks which bank account your
  customers pay to, on which account the revenue is booked, and the payment term in days. After
  that the section sets the logo, colour, font and texts of the invoice. «Zahlungskonten» there
  names, per currency, the account whose IBAN is printed on the invoice.
- «E-Mail-Versand»: your mailbox's outgoing server, to send invoices from the app. The password
  goes into the Mac's keychain, never into the books. Without it you download the PDF and send
  it yourself.

Then open **Rechnungen** (`G I`) and press `N` («Neue Rechnung»). You fill in the draft on the
A4 sheet itself. «Ausstellen» checks what the law requires on an invoice (MWSTG Art. 26), gives
it its number and stores the PDF; an issued invoice is never changed, a mistake takes a credit
note or a cancellation. «Senden» sends it by e-mail or downloads the PDF, and records it.

An invoice in Swiss francs or euros to a Swiss account carries the Swiss QR-bill. When a
statement shows a payment with the invoice's reference, the app books it from the invoice by
itself and marks the invoice «Bezahlt». On vereinnahmte Entgelte the sale is booked when the
money arrives. On vereinbarte Entgelte the invoice is booked on its date, and the payment only
settles it.

## 10. Update the app

Download the new `.dmg` from the
[Releases page](../../../releases) and replace the
app in Applications. Until the app is signed, macOS asks again as in step 1. Your books stay
where they are. If a version changed the format of the books, the app brings them to the new
format when it opens them.

[CHANGELOG.md](../CHANGELOG.md) lists what each version changed. An entry marked **⚠ figures**
changes a figure of an open period, and one marked **⚠ action** needs a step from you.

## Your own reports

A report the app has no page for («all expenses this quarter by account», «what came in EUR
this year») is one you describe, and the app computes. There are two ways to make one:

- **Ask the AI** in the «KI» column (`⌘J`) in your own words. It writes what the report shows,
  never a figure: the app runs it on the books and shows a card with the first rows and every
  total, «PDF», «CSV» and «Bericht speichern». When the AI's words state a figure the app did
  not compute, the app withdraws those words; the card stays.
- **Without the AI:** Bilanz & ER › Eigene Berichte › «Neuer Bericht». Pick the period, then one
  or more sections. Each section reads bookings, payments, receipts or invoices, with filters
  (accounts or ranges such as `6000-6999`, VAT codes, a text or the other party, who booked it,
  with or without a receipt, currencies), a grouping (month, quarter, account, other party, VAT
  code) and the columns. «Vorschau» runs it.

A comment under the report holds no figure of its own. Placeholders such as `{total}`,
`{count}`, `{period}` or `{section1.total}` are filled from the books. With an account filter, a
booking counts on the account's normal side, so a refund counts against an expense. Amounts in
different currencies are summed apart. A booking's amount is as booked, VAT included; its net
is the amount without the VAT, which is what Bilanz and Erfolgsrechnung show for the account,
and the report says on which account the VAT stands there.

Eigene Berichte lists a saved report and runs it each time it is opened, for its own period or,
with one click, for the period of the page. «Bearbeiten» opens it in the form, and «Löschen»
has «Rückgängig». The PDF has the title, the period, the filters in words, the group and section
totals, the comment and the VAT note. The CSV is the plain table.

## Limits

What holds today. Where something is missing and has an issue, the issue is linked.

- **Checked by you.** The app is free and comes without warranty. Check every return before you
  file it, or have your Treuhänder check it.
- **VAT.** The effective method by quarter, the Saldosteuersatz by half year, on vereinnahmte
  or vereinbarte Entgelte, or books without VAT. No monthly returns and no fiscal year other
  than the calendar year
  ([#9](../../../issues/9)). The method, the basis
  and the period hold for whole years: the app refuses a change while the open year has
  bookings.
- **Saldosteuersatz.** The return is form 0553 as the app models it: the approved rates (one or
  two) on the gross turnover, and Bezugsteuer. Not modelled: the credits of the forms 1050 and
  1055 (Ziffern 470 and 471) and Ziffer 415. The numbers of the rate rows (323, 333) come from
  a code list and were not checked against the paper form: compare the first return with the
  ESTV's form.
- **Vereinbarte Entgelte.** An invoice you write in the app is taxed on its date. A supplier's
  bill counts on its date once its payment is booked: the app keeps no list of unpaid supplier
  bills with due dates
  ([#93](../../../issues/93)). Documents dated
  before the books: [#170](../../../issues/170).
- **Banks.** Any Swiss bank's camt.053, and a PDF, scan or photo of any bank's statement (read
  by the AI, at most 20 pages each) or its CSV export (at most 5000 rows). Real camt.053 files
  were tested from Raiffeisen and Wise: for another bank, check the first statement's payments
  and closing balance. Not handled yet: a company credit card whose statement is not read in
  ([#94](../../../issues/94)), payments from
  PayPal, Twint or another account the app does not import
  ([#95](../../../issues/95)), and the cash box
  ([#91](../../../issues/91)): book those by hand.
- **Webshops and card terminals.** A payment provider's payouts, sales and fees go over a
  clearing account, the sales from the provider's CSV export. The app ships the columns of
  Shopify's exports; another provider needs its columns written into your books' knowledge
  ([processes/README.md](../processes/README.md), «A payment provider»). Reading a shop through
  its API: [#222](../../../issues/222).
- **Receipts by mail.** The Mac app keeps a mailbox and its password (Firma › «Quellen») and
  checks the connection, but does not fetch mail by itself yet. Until then, drag invoices from
  your mail program into Belege. Run from the source, the app fetches them
  ([mail-setup.md](mail-setup.md)).
- **Receipts from the phone.** The iPhone app is not in the App Store yet. The pairing code
  opens the scan page in the phone's browser, on the same Wi-Fi as the Mac.
- **Moving from another program.** You enter the opening balances by hand; the app does not
  import another program's books. From the source, a Banana export of the accounts can be read
  ([from-source.md](from-source.md)). Learning how the company books from its previous books:
  [#198](../../../issues/198).
- **Payroll.** The app books salary and the AHV, BVG and UVG payments. It does not calculate
  payroll, the Lohnausweis or the AHV statement: those stay with your payroll provider or
  Treuhänder. Money an employee advanced:
  [#92](../../../issues/92).
- **Invoices.** Invoices, credit notes, reminders and cancellations, sent through your own
  mailbox. On vereinnahmte Entgelte, invoices still open on 31 December are booked as
  receivables at the year-end and reversed on 1 January.
- **Year-end.** Abschluss checks the year, books the exchange difference, guides the year-end
  bookings, closes the year and opens the next one ([year-end.md](year-end.md)). For an
  Einzelfirma the AHV on the profit and the tax return are not covered. Your Treuhänder still
  signs off the annual accounts.
- **The Mac app** is not signed yet (step 1) and does not update itself (step 10). There is no
  Windows or Linux app.
