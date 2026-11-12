# Desktop: set up new books

`Neue Buchhaltung anlegen` asks about the company (preset, name, UID, owner, what it does,
language, folder), how it works (legal form, VAT register, method, settlement, period, fiscal
year, start, what it sells, foreign customers, imports, staff, private payments, private use,
payouts) and its bank accounts, then writes the books folder
(`~/Documents/Buchhaltung <year>/`, made unique with ` 2`, a git repository with `vanilla-accounting/`, manifest
`belege.workspace.yaml`) and opens it: Belege of the current quarter, with the AI sidebar open wide on
the setup conversation (`Einrichtung`, `Hallo <owner>. …`, features/setup.md).

## Sub-features

- `ds-presets`: `Beratung, Dienstleistungen (GmbH)` (preselected), `Webshop, Waren (GmbH)`, `Handwerk, Bau
  (GmbH)`, `Selbständig, ohne MWST`, `Etwas anderes`.
  A preset never answers `MWST-Methode` and `Abrechnungsart` (#364): neither has a `button.on` until
  she clicks one, and submitting without them marks `.st-q[data-q=vatMethod|basis].err` with «Bitte jede Frage beantworten.»
  Each has a third button `[data-answer=no-vat]` «Wir rechnen keine MWST ab» with `[data-no-vat-hint]` under it (#347):
  it sets «Im MWST-Register eingetragen?» to `nein` and both questions disappear; the books get `company.vat: { registered: false }`.
- `ds-validate`: UID (required) and IBAN check digits (`«…» ist keine gültige UID`, `ist keine IBAN`);
  spaces in either are accepted. On submit the page jumps to the first error: `Bitte oben prüfen: …
  Die App ist zur ersten Stelle gesprungen.`, or `Bitte jede Frage beantworten.` Bank refusals
  (currency, ledger account class, account or bank twice) come from the server.
- `ds-unsupported`: answers the app cannot handle say so in place and disable the button: `monatlich`
  (`Monatliche Abrechnungen werden noch nicht unterstützt: …`), Geschäftsjahr `anderes`. `vereinbart` is
  supported and shows a caveat (`Eine Rechnung der App wird an ihrem Datum als Forderung (1100) …`).
  Saldosteuersatz is supported: a caveat, `Bewilligte Saldosteuersätze` (Satz, Tätigkeit, Tätigkeitscode),
  and the period switches to halbjährlich.
- `ds-write`: the manifest, `ledger.json`, the chart (`master-data/accounts.json`), `sources/`, `knowledge/`,
  `beleg-import/`, `data/`, the year folder; at the root `AGENTS.md`, `CLAUDE.md`, `.gitignore`, and the
  commit `Workspace set up`. An existing books folder is opened unchanged. Also on the form: `+ Bankkonto`,
  `×`, `Wählen…` (folder), `Wohin die Bücher Ende Jahr gehen …` (optional).

## How to get to it (user POV)

Start screen › `Neue Buchhaltung anlegen` opens «Einrichtung» (FirstRun, books first since #343): «Was
möchtest du?» with `Neue Buchhaltung erstellen` (`[data-answer=create]`). Wait for the line under the
choices (`[data-ai=none]` or `[data-ready=claude]`): without an AI the button opens the form at once (h1
`Neue Buchhaltung anlegen`); with one it opens the setup conversation (DraftConversation), and the link
`Ohne KI einrichten` (`[data-act=by-hand]`) opens the form. Fill top to bottom; `Buchhaltung anlegen` at
the end.

## Driving it with vm.sh + app.mjs

```bash
node $A 09-first "await clickText('Neue Buchhaltung erstellen')"   # no AI on the VM: the form; with one: clickText('Ohne KI einrichten')
node $A 10-setup "await fill('Firmenname','Malerei Huber GmbH')" \
  "await fill('UID', process.env.PERSONA_UID)" "await fill('Inhaber','Thomas Huber')" \
  "await nth(5,'Raiffeisen')" "await nth(8, process.env.PERSONA_IBAN_SPACED)"
node $A 11-created "await clickText('Buchhaltung anlegen','button')" "await wait(5000)"   # URL ends /receipts
$V sh 'cat ~/Documents/"Buchhaltung 2026"/vanilla-accounting/belege.workspace.yaml'
```

Inputs without labels (the bank row) go by index: 0 name, 1 UID, 2 owner, 3 what it does,
4 folder, 5 bank, 6 currency, 7 account, 8 IBAN (with Saldosteuersatz chosen, six rate inputs come
before the bank row). Proof: the URL `/receipts`, the setup sidebar, the manifest's `company:` and
`bankAccounts:`.

The 2026-10-21 regression (new books written but not opened, 409 `noWorkspace`) is fixed by #68
(5e48e48d), guarded by tests/desktop-first-open.test.ts. Driven 2026-10-31 without the VM (see Gotchas):
empty submit → `Bitte oben prüfen: Firmenname …, UID …, Inhaber … Die App ist zur ersten Stelle
gesprungen.`; `monatlich` → the stop and the button disabled; filled → `/receipts`, the manifest and the
commit `Workspace set up`.

## Gotchas

- An error the app shows below the form (`.err`) is easier to read with
  `console.log(await ev("[...document.querySelectorAll('.err')].map(e=>e.innerText).join(' | ')"))` than
  off the shot.
- The default folder is `<Documents>/Buchhaltung <year>`, not the company name.
- Without a VM, the form and the drop run against `desktopServer` (src/desktop/server.ts, as
  tests/desktop.test.ts builds it) on a temp `booksHome` and state file, serving a `vite build` whose
  index.html loads a stub `window.vanilla` (`chooseFolder`, `chooseNewFolder`, `onMenu`, `setLanguage`,
  `saveFile`), with `CLAUDE_BIN`/`CODEX_BIN` set to a stub or to a path that does not exist: FirstRun's
  look at the AI makes one test call on load when a CLI is signed in (tests/first-run-scroll.test.ts does
  all of this; `CLAUDE_STUB_SIGNED_OUT=1` gives «installiert, nicht angemeldet»). Gatekeeper, the move
  offer and the native menu still need the VM.
- Made-up IBANs and UIDs need valid check digits (the persona data has them).
