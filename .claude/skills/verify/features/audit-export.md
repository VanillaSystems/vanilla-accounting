# Static audit export

`npm run build:audit` writes the app built in audit mode plus every file it reads into one folder (src/audit/build.ts, the reads in src/audit/sources.ts). No sandbox API runs: a plain static file server serves the folder, and the UI must never ask for `/api/*`. **Driven end to end on 2026-10-09.**

## Sub-features

- Every tab reads from the export's files: Belege (search, receipt PDF), Buchungen, MWST with the Korrekturabrechnung (0535) of a filed quarter, Kontoauszug, Kontoauszüge (statement PDF with its balance check).
- The audit bar shows with the snapshot line (date, books schema, app version), translated; the "API running" badge does not show; no edit control shows.
- The view lives after `#` (`#/journal/<id>?period=…`; an old `#/<lang>/<period>/<tab>` link redirects), and a pasted `#` link opens its view.
- `manifest.json` and `npm run verify-audit` (tests/audit-export.test.ts covers tampering).

## How to get to it (user POV)

`npm run build:audit -- <folder> [--workspace demo]`, then `npx serve <folder>` and open the printed address.

## Driving it with browse + sandbox.sh

```bash
OUT=$TMPDIR/audit-verify/host/sub-path            # served under a sub-path on purpose
npm run build:audit -- "$OUT" --workspace demo
node --import tsx tests/support/static-server.ts "$TMPDIR/audit-verify/host" 4791 > "$TMPDIR/audit-verify/requests.log" &
U=http://127.0.0.1:4791/sub-path/
$B newtab "$U" ; $B wait --networkidle
$B js "document.querySelector('[data-testid=audit-snapshot]').innerText"
$B goto "$U#/2026-Q1/vat-report"                    # then click "Korrekturabrechnung (0535)"
$B screenshot --viewport .verify/evidence/static/NN-step.png
grep -v '^GET /sub-path/' "$TMPDIR/audit-verify/requests.log"   # must print nothing
```

## Gotchas

- `goto` to a URL that differs only in its `#` part relies on the app's hashchange reload; wait a second before reading the DOM.
- Headless Chromium shows a PDF iframe blank. Prove the PDF with `$B js "fetch(document.querySelector('iframe').src).then(r => r.status + ' ' + r.headers.get('content-type'))"`.
- The language buttons' `innerText` is upper-case through CSS; find them by `textContent`.
- Delete the export folder and stop the static server when done. Never build an export of real books into the repo.
