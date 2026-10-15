# Desktop: set up new books

`Neue Buchhaltung anlegen` asks about the company (preset, name, UID, owner, what it does,
language, folder), how it works (legal form, VAT register, method, settlement, period, fiscal
year, start, what it sells, foreign customers, imports, staff, private payments, private use,
payouts) and its bank accounts, then writes the books folder
(`~/Documents/Buchhaltung <name>/vanilla-accounting/`, manifest `belege.workspace.yaml`) and opens
Belege of the current quarter.

## Sub-features

- `ds-presets`: Beratung (GmbH), Webshop (GmbH), Selbständig ohne MWST, Eigene Antworten.
- `ds-validate`: UID and IBAN check digits (`«…» ist keine gültige UID`, `ist keine IBAN`); spaces
  in either are accepted.
- `ds-unsupported`: answers the app cannot handle say so in place (Saldosteuersatz).
- `ds-write`: the manifest, the chart (`master-data/accounts.json`), the year folder.

## How to get to it (user POV)

Start screen › `Neue Buchhaltung anlegen`; fill top to bottom; `Buchhaltung anlegen` at the end.

## Driving it with vm.sh + app.mjs

```bash
node $A 10-setup "await clickText('Neue Buchhaltung anlegen')" "await fill('Firmenname','Malerei Huber GmbH')" \
  "await fill('UID','CHE-345.678.915')" "await fill('Inhaber','Thomas Huber')" \
  "await nth(5,'Raiffeisen')" "await nth(8,'CH11 8080 8001 2345 6789 1')"
node $A 11-created "await clickText('Buchhaltung anlegen','button')" "await wait(5000)"   # URL ends /receipts
$V sh 'cat ~/Documents/"Buchhaltung Malerei Huber GmbH"/vanilla-accounting/belege.workspace.yaml'
```

Inputs without labels (the bank row) go by index: 0 name, 1 UID, 2 owner, 3 what it does,
4 folder, 5 bank, 6 currency, 7 account, 8 IBAN. Proof: the URL `/receipts`, the manifest's
`company:` and `bankAccounts:`.

## Gotchas

- A validation error far up the form leaves the button silent: the page does not scroll to it.
  Read the text from `app.mjs` (it lists the error) rather than the shot.
- The folder name follows the company name as typed.
- Made-up IBANs and UIDs need valid check digits (the persona data has them).
