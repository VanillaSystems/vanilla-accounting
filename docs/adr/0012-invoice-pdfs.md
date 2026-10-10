# ADR 0012: Invoice PDFs are printed from the HTML sheet by Chromium

Status: accepted (2026-10-11). Built in phase 8 of the redesign (`src/invoices/`).

## Problem

ADR 0010 asks for one A4 renderer that serves the screen, editing in place and the PDF, for invoices
that run over several pages and end with a Swiss QR-bill, and for the PDF of every sent document to be
stored byte-exact with its checksum. The app runs locally, without hosting or recurring costs, first
as a Claude plugin with Node, later in an Electron shell. Two ways to make the PDF were tried on the
same two-page invoice: printing the HTML sheet with headless Chromium, and drawing the invoice again
with a PDF library (PDFKit).

## Decision

### The HTML sheet is the PDF

The invoice is rendered once, as HTML sheets of 210 x 297 mm with print CSS (`@page { size: A4;
margin: 0 }`), by `src/invoices/sheet.ts`. The module has no Node import, so the UI uses it as it is.

- `sheetBlocks` turns an invoice into blocks in reading order: the title, the intro, the table header,
  each table row, the totals, the notes, the closing text.
- Whoever holds a page measures each block at its printed width: the browser in the UI, Chromium for
  the PDF (`MEASURE_SCRIPT`).
- `paginate` places the blocks on sheets. Page 2 and later carry a page header and repeat the table
  header. A table header never ends a page alone. The QR-bill takes the bottom 105 mm of the last
  sheet, or a sheet of its own when the content leaves no room.
- `assembleSheets` writes the sheets. The same sheets are shown on screen, edited in place, and
  printed.

### Chromium prints it

- **In Node (plugin, CLI, API):** puppeteer-core drives a Chromium-based browser already on the
  machine: Google Chrome, Microsoft Edge, Brave or Chromium, found at their standard paths, or the
  program `CHROME_PATH` names (`src/invoices/pdf.ts`). Without one, issuing refuses with a message
  that names what to install (HTTP 503, `invoiceRefusal: noBrowser`). The app never ships a browser.
  A one-time download of chrome-headless-shell is left for later.
- **In the Electron shell:** `webContents.printToPDF` on a hidden window, once the shell exists.
- One browser process stays up while the API runs; the server closes it on SIGINT and SIGTERM. A PDF
  takes about 0.2 to 0.3 s.

### The QR-bill comes from swissqrbill

The payment part is the SVG output of `swissqrbill` (MIT), placed at the bottom of the last sheet. The
sheet draws the horizontal cut line with scissors above it; the library draws the vertical one. An
invoice paid to a QR-IBAN carries a QR reference (QRR), one paid to a plain IBAN a creditor reference
(SCOR), both made from the invoice number (`src/invoices/reference.ts`). An account outside
Switzerland and Liechtenstein cannot carry a QR-bill: the invoice prints its IBAN and reference
instead.

### Fonts are files of the app

The sheet uses fonts the app ships through its npm dependencies, not system fonts, inlined as
`@font-face` rules (`src/invoices/fonts.ts`): Inter (OFL) for the text, and Arimo (Apache 2.0) for
the QR-bill. Arimo is metrically compatible with Arial and is declared as Liberation Sans, which the
QR-bill standard allows. A sheet breaks into the same pages on every machine with the same Chromium.

### A sent PDF is stored, never rendered again

Issuing prints the PDF once. Its creation and modification dates are set to the issue time, digit for
digit, so every offset in the file stays right. The bytes are written to `invoices/<number>.pdf`, and
their SHA-256 is recorded on the invoice. A reminder or a cancellation notice is printed when it is
sent, to `invoices/sent/<document id>.pdf`. Every sending is recorded with its file, checksum, time
and recipient. A resend is the same file. Reading a document back checks it against its checksum.
The same invoice printed twice by the same browser gives the same bytes. A newer Chromium may give
other bytes, which does not matter, because a sent document is only ever read back from its stored
file.

## Consequences

- Printing needs a Chromium-based browser in the plugin and CLI forms; the tests that print skip
  without one and say why.
- About 40 to 75 KB per invoice with the Latin font subsets and the vector QR code.
- One renderer to maintain: every look setting (logo, font, colour, window position, texts) exists
  once.
- A golden test can compare PDFs byte for byte only for a pinned browser build. Across builds the
  tests compare page counts, checksums of stored files and the reference instead. The demo
  generator prints the demo's invoices, so its files are the same only on the same machine and
  browser.

## Rejected

- **A PDF library (PDFKit with swissqrbill's PDFKit output):** fast (under 10 ms) and small (14 KB),
  but a second layout of the same sheet. In the prototype it already broke the first page after 27
  rows where the HTML broke after 20, and its standard fonts are not embedded, so the look depends on
  the viewer. Every layout option would be built twice.
- **Shipping a browser with the plugin (full puppeteer):** a 150 to 350 MB download for something
  most Macs and every Windows machine already have.
- **playwright-core instead of puppeteer-core:** it worked equally, but was slower per PDF on the same
  Chrome in the prototype, for no gain.
- **The browser's print dialog only:** the user gets a PDF, but the app does not hold the exact bytes
  that were sent.
- **A hosted PDF service:** recurring cost and the books leave the machine.
