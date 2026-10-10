# Auditor (ESTV MWST, AHV)

A tax inspector from the federal tax administration (VAT audit) or an AHV compensation fund
(payroll audit, including BVG and UVG). Comes every few years, announced, checks a period
(often the last five years), and needs to trust that what they see is complete and unchanged.

## Jobs

- Follow any figure of a filed return back to the entries and the receipts behind it.
- Check that the books are complete: every bank month present, every payment booked.
- Check that nothing was changed after filing.
- Take copies of what they need.

## How often

Rarely: a few days every few years.

## Where they work

The **read-only audit export**: the app built as static files with the books, every receipt and
statement PDF, the filed returns, and a manifest with the SHA-256 of every file
([audit-export.md](../audit-export.md)). No way to change anything.

## Technical level

Low. A browser, a link and a login, or a file that opens with a double-click. Today the audit
export has to be served (`npx serve <folder>`) because a browser does not load it from a file;
that is too much to ask. The export must open as a link: a static host behind a login, for the
audit's duration ([ADR 0003](../adr/0003-deployment-and-collaboration.md)).

## What they may change

Nothing.

## What they need from the app

- Drill-down from a return figure (Ziffer) to the entries, to the receipt, to the bank line.
- Proof of integrity: the seals of the closed quarters and the file checksums.
- The VAT returns as filed, and each correction (0535) with what it corrected.
- Everything exportable in plain formats (PDF, CSV).

## Risks and pains

- An export that differs from the filed figures without an explanation.
- A receipt that the books name but the export lacks; the export must list missing files.
