# Release: from `npm start` to a Mac app

Asked 2026-10-11: "do everything so it is ready to be released", after the redesign (phases 0–10).
This file is the plan of that run; progress and defaults go into [progress.md](progress.md) under
"Release".

## What "ready to be released" means

A person who is not a developer downloads one file for the Mac, opens it, opens or creates their
books, and every area works: receipts are read, statements imported, entries booked, VAT filed,
invoices written, sent and matched. No terminal, no Homebrew, no `npm`. The developer forms
(`npm start`, the CLI) keep working unchanged.

The release itself stays the owner's: merging `redesign` into `main`, the version tag, publishing
the repository, the Apple Developer ID for signing and notarization, and a GitHub release are
not done by this run. Everything up to them is.

## Tracks

Three tracks run in parallel worktrees and are merged into `redesign`, then one integration pass.

### A. No external programs (ADR 0006 section 2)

The engine calls `pdftotext`, `pdftoppm`, `tesseract` and `git`. A Mac app cannot assume them.

- Replace each runtime use with a library that runs inside Node/Electron: PDF text with pdf.js
  (already a dependency), page images with pdf.js on a canvas or a WASM renderer, OCR by the
  model's vision path (it exists) or a WASM OCR, git with a pure-JavaScript git where the app
  commits (year close, migrate) or skip the commit with a notice when no repository exists.
- The parsers rely on `pdftotext -layout` and `-raw` output. Prove the replacement on every PDF
  of both demos and, read only, on the real workspace's receipts and statements (compare the
  parsed results, not the raw text; never copy their text into the repo). Golden tests stay green.
- CLI-only collection scripts (`src/collect/tutti.ts`, mail collection) may keep their tools;
  the doctor names what is optional.

### B. The Electron app (ADR 0006 form 3)

- Main process starts the Express API in process on a free local port and opens a window on the
  built UI. Single instance, window state kept, a native menu (Edit, View with zoom, Window,
  Help), external links open in the browser.
- The books folder: on first start, choose "Bestehende Buchhaltung öffnen", "Neue Buchhaltung
  anlegen" (the questions of `npm run init`, as a form in the UI, reusing its code) or "Demo
  ansehen" (a copy of the demo in the user's data folder). The choice is remembered; File → Open
  switches.
- Invoice PDFs through Electron's `webContents.printToPDF` (ADR 0012 names it), the same sheet.
  `puppeteer-core` stays for the CLI and `npm start`.
- The `claude` CLI is optional: found on the user's PATH (login shell), else model features say
  what to install and everything else works.
- Packaging with electron-builder: a `.dmg` for Apple silicon and Intel, the app icon, the
  version from `package.json`. Signing and notarization are configured from environment variables
  and skipped without them. Auto-update through GitHub Releases is configured and stays off until
  releases are public.
- Proof: the packaged app started with a PATH that holds only `/usr/bin:/bin` (no Homebrew),
  driven through its window: open the demo, read a dropped receipt, import a statement, issue an
  invoice and print its PDF.

### C. Close the gaps in the app

- **Inbox processing in the app.** Today a dropped receipt waits for `npm run extract`. The app
  runs extract, extract-vat, match and classify itself after an intake and on a button, with
  progress in the shell and the model calls through `src/llm/ask.ts`.
- **Sending invoices by e-mail** (ADR 0010 first version: "through the company's own mailbox").
  SMTP settings per company in Firma (host, port, user, sender), the password in the macOS
  keychain in the app and in `.env` for `npm start`; the sent PDF is the stored one, recorded with
  recipient and time. Proven against a local test SMTP server.
- **Small open items of the final pass:** the rule-5 notice for unknown Ziffer, Abschluss step
  and Firma section links; the logo row wrap in Rechnungslayout.

### D. Release preparation (after A–C are merged)

Version `0.3.0` (MINOR: new behaviour, nothing for the adopter to do; check the ⚠ markers), the
CHANGELOG section, README and getting-started with the download path first, docs/releasing.md
with the desktop build and the signing variables, all gates of docs/releasing.md including
`npm run check-processes` and `npm run build`, and a built `.dmg` proven as in B.
