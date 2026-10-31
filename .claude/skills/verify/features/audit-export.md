# Static audit export

`npm run build:audit` writes the app built in audit mode plus every file it reads into one folder (src/audit/build.ts, the reads in src/audit/sources.ts). No sandbox API runs: a plain static file server serves the folder, and the UI must never ask for `/api/*`. **Driven end to end on 2026-10-09; again from a sandbox clone on 2026-10-21.**

## Sub-features

- Belege (search, receipt PDF), Kontoauszüge (statement PDF with its balance check), Buchungen, MWST with the `0535 Korrekturabrechnung` row of a filed quarter (`#/vat/0535?period=2026-Q1`, detail `Korrekturabrechnung (effektive Methode)`) and Bilanz & ER read from the export's files. Rechnungen, Abschluss (`Der Jahresabschluss braucht den lokalen Server`), Geschäftspartner and Wissen (`Im Prüfexport nicht enthalten: diese Seite liest die App.`), Automatisierung and Änderungen (`Nur in der App mit laufendem Server.`) say they are not in the export.
- The audit bar `[data-testid=audit-bar]` reads `Prüfmodus · nur Lesen — Änderungen sind deaktiviert · Stand vom <date> · Buchhaltungsdaten Schema <n> · App v<version>` (translated); no edit control shows.
- The view lives after `#` (`#/journal/<id>?period=…`; an old `#/<lang>/<period>/<tab>` link redirects), and a pasted `#` link opens its view.
- `manifest.json` and `npm run verify-audit` (tests/audit-export.test.ts covers tampering). The build prints the seal status, missing PDFs and the manifest's sha256, and refuses a non-empty folder without a manifest or a folder inside the workspace.

## How to get to it (user POV)

`npm run build:audit -- <folder> --workspace <books>`, then `npx serve <folder>` and open the printed address. Without `--workspace` it exports the books the app's `.env` names: in verification always pass the sandbox.

## Driving it with browse + sandbox.sh

```bash
OUT=<scratch>/audit/host/sub-path                 # served under a sub-path on purpose; never inside the repo
npm run build:audit -- "$OUT" --workspace "$SB"     # the sandbox clone; prints "seal 2026-Q1: intact …" and the manifest sha256
npm run verify-audit -- "$OUT"
node --import tsx tests/support/static-server.ts <scratch>/audit/host 4791 > <scratch>/audit/requests.log   # run_in_background
U=http://127.0.0.1:4791/sub-path/
$B newtab "$U#/vat/0535?period=2026-Q1" ; $B wait --networkidle
$B js "document.querySelector('[data-testid=audit-bar]').innerText"
$B js "document.querySelector('[data-z=\"0535\"]').innerText"
$B screenshot --viewport "$EVIDENCE/audit-export/NN-step.png"
grep -a -v '^GET /sub-path/' <scratch>/audit/requests.log   # must print nothing
```

## Gotchas

- `goto` to a URL that differs only in its `#` part relies on the app's hashchange reload; wait a second before reading the DOM.
- Headless Chromium shows a PDF iframe blank. Prove the PDF with `$B js "fetch(document.querySelector('iframe').src).then(r => r.status + ' ' + r.headers.get('content-type'))"`.
- The export's origin (another port) has its own localStorage: the language starts as the browser's (English) until set.
- Every call to `/api/` is refused in the export before it is sent (`apiFetch`, src/app/lib/api.ts; issues #66, #67), so the grep prints nothing. tests/audit-export.test.ts walks every area in headless Chrome and fails on any `/api/` request, a console error, or an area that keeps the main thread busy (Änderungen did, until 2026-10-23).
- Delete the export folder and stop the static server when done. Never build an export of real books into the repo.
