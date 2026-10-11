# Rechnungen (invoices)

Rechnungen (`/invoices…`, rebuilt in redesign phase 9) is the invoicing UI over `src/invoices/` (ADR 0010, ADR 0012) and its API (`/api/invoices`, `/api/customers`, `/invoices/<number>.pdf`, `/invoices/sent/<id>.pdf`). The sheet on screen is laid out by the PDF's own renderer (`src/invoices/sheet.ts`): blocks measured in the page, `paginate`, `assembleSheets`. Firma › Rechnungslayout (`/company/invoice-layout`) edits the manifest's `invoicing` block through `PATCH /api/workspace` and `POST /api/workspace/logo`. Records live in `$SB/invoices.json` and `$SB/invoices/`, not in `books.json`.

## Sub-features

- `invoice-list`: `.row.inv[data-id=<number>|draft-<id>]` in groups Überfällig, Offen, Entwürfe, Bezahlt, Gutschriften, Storniert; filters `[data-status=open|overdue|draft|paid]` (`?status=`); the `Offen` total in CHF and the overdue notice; the views `[data-view=list|customers|sent]`. Issued invoices show in the period of their date (a link opens that period), drafts in every period.
- `invoice-detail`: head, facts (number, date, due, QR reference, VAT), status (paid, open, overdue with the last reminder, cancelled, credit note with its invoice, payment proposals with `Zahlung bestätigen`), actions `[data-act=send|remind|copy|credit|cancel|preview|issue|delete|remsend]`, `a.dl` (the issued PDF, D), the sheet `.ivsheet`, margin sections (Rechnung/Gestaltung, Mahnung, Kunde, Gesendet, Kommentare, Verlauf).
- `draft-edit`: on `.ivsheet.editing` every field carries `data-ed`: `date`, `dueDate`, `intro`, `closing`, `customer` (select, `+` opens the customer form), `exemption` (with a 0 % line), `l:<k>:text|quantity|unit|price|vatRate`; buttons `[data-ia=addline|rmline]`. A field saves when it is left (`PATCH /api/invoices/<id>`); a bad date or number is refused with a toast and the field shows its old value. The margin sets language and currency.
- `issue`: `Ausstellen` gives the number, prints and stores the PDF; the Art. 26 gaps show above the actions and in the refusal toast (`invoice.missing.*`).
- `send`: `Senden`/`Erneut senden` downloads the issued PDF and records it as sent to `download` (no e-mail yet).
- `credit`, `cancel`, `reminder`: the dialogs `.idlg.icredit` (whole or part, reason, refund or offset when more than open) and the cancel dialog (reason, date, notice PDF; a paid invoice offers a credit note instead); `N. Mahnung` writes the reminder on the sheet (texts editable, fee in the margin), `N. Mahnung senden` prints and records it.
- `customers`: `.row.cust[data-id]`, the detail with `Kunde bearbeiten`, `Neue Rechnung` (`/invoices/new?customer=<id>`), the customer's invoices; the form `.cdlg` per country (postcode name and shape, state, number first, VAT number kind, language from country and Swiss postcode).
- `sent`: `.row.sentrow[data-id]` by month; the detail shows the stored PDF (pdf.js, whole pages) with its SHA-256 and a link to its invoice.
- `invoice-layout`: font, colour swatches, logo upload/remove, logo place and size, envelope window, elements, the window frame (this browser only), and the default texts per language edited on a sample sheet (`{days}` stays a placeholder; `zurücksetzen` with undo).

## How to get to it (user POV)

- Dock `Rechnungen` (`G I`); `N` opens "Für welchen Kunden?" (in Kunden: the customer form); ⌘K finds invoices and customers.
- From a draft's margin `Firma › Rechnungslayout →`; from Abschluss' checks to the open invoices.

## Driving it with browse + sandbox.sh

- The demo's open quarter is 2026-Q2 and its invoices are dated Q3: open `$UI/invoices?period=2026`.
- **Edit a draft.** Click a `.row[data-id^="draft-"]`, click `[data-ed="l:0:quantity"]`, `document.execCommand('selectAll')`, type, press Tab: `curl $API/api/invoices` shows the new quantity, and the caret sits in `l:0:unit`. `[data-ia=addline]` puts the caret into the new line's text.
- **Issue and download.** `[data-act=issue]`: the URL becomes `/invoices/2026-00N`. `curl "$UI$(… a.dl href)"` and `shasum -a 256` equal `$SB/invoices/2026-00N.pdf` and its `pdf.sha256` in `invoices.json`.
- **Credit, cancel, reminder.** `[data-act=credit]`, `Teilbetrag`, an amount, `[data-act=credit-ok]`: a credit-note draft opens; `[data-act=issue]` issues it in the same sequence. `[data-act=cancel]` on an open invoice, a reason, `[data-act=cancel-ok]`: the stamp shows, Versand lists the notice. `[data-act=remind]` on the overdue one, a fee, `[data-act=remsend]`: Versand lists the reminder PDF.
- **Layout.** `/company/invoice-layout`, click a swatch, pick `Helvetica`: `$SB/belege.workspace.yaml` shows them under `invoicing.layout`; any draft shows the new colour and font.
- **Refusal.** A draft without lines, `Ausstellen`: the toast says "Für eine MWST-konforme Rechnung fehlt: mindestens eine Position."
- `$S diff` stays `no changes` for all of this: invoices are not in `books.json` (only a confirmed payment books an entry).

## Gotchas

- Text typed into a contenteditable field saves only when the field is left (Tab, Enter, a click elsewhere); `browse type` alone does not save.
- Times of sent documents show in the browser's time zone; `sentAt` is UTC.
- The static audit export has no invoicing API: the area says so.

## Sending by e-mail (release C)

- Firma › E-Mail-Versand (`/company/mail`) writes `outgoingMail` into the manifest; the password comes from `VANILLA_SMTP_PASSWORD` in the environment of `up` (`VANILLA_SMTP_PASSWORD=… $S up <run>`). A local SMTP server (smtp-server from node_modules, `allowInsecureAuth`, no STARTTLS) on 127.0.0.1 with security `none` captures the messages.
- Senden (`[data-act=send]`), the reminder's send (`[data-act=remsend]`) and Stornieren with "Kunde informieren" open the dialog: `input[name=to|subject]`, `textarea[name=body]`, `[data-act=mail]` sends, `[data-act=download]` saves the PDF as before. Check the captured attachment's SHA-256 against the stored PDF and the sent log's `channel`, `to`, `messageId`.
