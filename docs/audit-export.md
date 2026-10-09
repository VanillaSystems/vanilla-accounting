# Audit export

An audit export is a read-only copy of your books that runs without Node.js and without the
API. It is a folder of static files: the app, `books.json`, every receipt and bank statement PDF
the books name, the VAT returns as filed, and a `manifest.json` with the SHA-256 of every file.
Give it to your Treuhänder, to an ESTV or AHV auditor, or keep it as the state of the books on
the day you made it.

Everything that reads works in the export: search, filters, every tab and report, the VAT
return of each quarter with its Korrekturabrechnung (0535), and the receipt PDFs. Nothing can
change. The export has no write handlers, so the edit buttons are hidden and the amber audit bar
names the snapshot: its date, the books schema and the app version.

> **Real books on a public URL publish them.** Anyone with the link can read every receipt,
> every bank line, your salary and your customers. Host an export of real books only behind
> access protection, or hand it over as a file. The demo companies are made up, so their export
> can be hosted openly.

## Make an export

```sh
npm run build:audit -- ../audit-2026-10-09
```

This builds the export of your workspace (the one `npm start` opens) into
`../audit-2026-10-09`. To export another workspace, add `--workspace <dir>`. The demos are
`--workspace demo` and `--workspace demo-consulting`.

The command prints the number of files, the size, the state of each seal, any PDF the books
name but the workspace does not hold, and the SHA-256 of `manifest.json`. Write that hash down.

Choose a folder outside the workspace and outside the app repository, so the copy of your books
is never committed by mistake. The command refuses a folder inside the workspace, and a folder
that holds other files. It replaces an earlier export in the same folder.

| In the export | What it is |
| --- | --- |
| `index.html`, `assets/` | The app, built in audit mode. All paths are relative. |
| `books.json` | Your `books.json`, byte for byte. |
| `data/` | What the API would answer: the status with the snapshot, the chart of accounts, the company and its bank accounts, the filed returns per year. |
| `receipts/<id>.pdf` | Every receipt in the books, named by its id. |
| `bank-statements/<bank>/` | Every bank statement PDF in the books. |
| `manifest.json` | The SHA-256 and size of every other file, and the seals of the filed quarters at the time of the export. |

## Look at it

A browser does not load the export from a `file://` path, because the app fetches its data.
Serve the folder with any static file server:

```sh
npx serve ../audit-2026-10-09
# or
python3 -m http.server --directory ../audit-2026-10-09 8080
```

Then open the address it prints. A link to a view ends in `#/<period>/<tab>`, for example
`#/2026-Q3/vat-report`, so the link works whatever the folder's address is.

The fonts ship with the app (no request to Google or any other third party), so the export looks the same offline.

## Hand it over

1. Zip the folder: `cd .. && zip -r audit-2026-10-09.zip audit-2026-10-09`.
2. Send the zip, for example through your Treuhänder's file exchange.
3. Send the SHA-256 of `manifest.json` by another channel, for example by email or phone.

The recipient unzips the folder and serves it with `npx serve`, as shown above. To check that
nothing changed on the way, they compare the hash:

```sh
shasum -a 256 audit-2026-10-09/manifest.json
```

and, with Vanilla Accounting installed, check every file against the manifest:

```sh
npm run verify-audit -- audit-2026-10-09
```

`verify-audit` lists every file that changed, was added or is missing, and exits with 1 when
there is one. When the folder is as it was exported, it prints `ok` and the seals.

## Host it

Host an export of real books only behind access protection that asks for a login before any
file is served. For example:

- Cloudflare Pages with Cloudflare Access in front of the site, allowing only your auditor's
  email address.
- Netlify with site password protection, where your plan offers it.
- Your own web server with a password (HTTP basic authentication) over HTTPS.

Remove the site when the audit is done.

The demo exports can be hosted openly, for example on GitHub Pages or Netlify. The export runs
under a sub-path such as `https://<user>.github.io/<repo>/`, because every path in it is
relative.

```sh
npm run build:audit -- site --workspace demo
```

## Verify an export later

The manifest makes an export checkable at any later date. `npm run verify-audit -- <dir>`
recomputes the SHA-256 of every file. The seals in the manifest name the hash of each filed
quarter's records (see `npm run seal`). They match the seal files in the workspace's
`filings/<year>/` as long as the filed quarters did not change.
