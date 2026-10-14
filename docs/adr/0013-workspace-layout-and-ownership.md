# ADR 0013: One folder per app in the company's repository, and the books split by year before the first year close

Status: proposed (2026-10-14), amended the same day: the company's repository holds one folder per
app (`vanilla-accounting/`, later others); inside it the fiscal year is the top folder, and
receipts, statements and filings move into it in the same step. Amends the order of work and the
paths of [ADR 0003](0003-deployment-and-collaboration.md) §3; nothing of this built yet.

## Problem

A workspace's root mixes three kinds of files, and nothing tells them apart:

- **the app's records**, written by the app: `books.json`, `invoices.json`, `filings/`, the
  regression figures in `golden/`;
- **the company's sources and knowledge**, added by a person and read by the app: `receipts/`,
  `bank-statements/`, `history/`, `knowledge/`, `mail.yaml`, `secret-terms.txt`,
  `belege.workspace.yaml`, `accounts.json`;
- **everything else** a person or an agent left there: planning notes, scripts, reference PDFs,
  exports of an earlier bookkeeping program, scratch folders of an agent's OCR session.

A real workspace showed what follows. The owner could not tell which folders the app uses.
Scratch folders were committed with the books by a `git add -A` and stayed for months. A folder of
old exports looked important and was not read by anything. The leak guard, the migrations
(`SKIP` in `src/cli/migrate-workspace.ts`) and the workspace check each keep their own idea of
the layout.

The repository is the books' and nothing else's. A company will run more apps than accounting
(an HR app, other apps of other makers) and keep their data in the same repository, one git
history, one host, one set of permissions. Today the books own the repository's root, so a second
app has no place.

Nothing in a workspace stops growing. `books.json` holds every record of every year in one file;
`receipts/`, `bank-statements/` and `invoices/` hold every file of every year in one folder. ADR
0003 §3 already decided to split the data by year, but put it fifth in its order of work, behind
the cloud instance, and the 0.4.0 migration has no step for it. The first year close of a
workspace on the app is 31.12.2026. After it, every edit of the new year rewrites the closed
year's records in the same file: diffs of megabytes, and a closed year that only the seal
protects, not the layout.

## Decision

### The company's repository holds one folder per app

```
<company repository>/
  AGENTS.md  CLAUDE.md  README.md  .gitignore
  master-data/                 master data more than one app reads (reserved, empty for now)
  own/                         the company's files no app reads
  vanilla-accounting/          the workspace of Vanilla Accounting
  vanilla-hr/                  another app, its own layout
  …
```

- **An app's folder is its workspace.** Vanilla Accounting reads and writes only inside
  `vanilla-accounting/`; everything this ADR says about a workspace is about that folder. Another
  app does the same in its own folder, by its own rules.
- **An app's folder is named after the app** and recognized by its manifest
  (`vanilla-accounting/belege.workspace.yaml`). Finding the workspace from the current directory
  also looks into `vanilla-accounting/` of each directory it passes, so the app runs from the
  repository's root.
- **Apps meet through interfaces, not files.** An app that books (salaries from an HR app) writes
  through Vanilla Accounting's command or API, as a module actor through the write door; it never
  writes into `vanilla-accounting/`.
- **The repository's root holds no app's data:** the files every git repository has, the agents'
  instructions for the whole repository, `master-data/` and `own/`.

### Master data that several apps read lies in `master-data/`

Large systems keep one store of master data (the company, business partners, people) that every
module reads, and each module's transactional data apart. The repository does the same, within
what apps of different makers can share:

- **`master-data/` holds only what more than one app reads,** in a schema the platform publishes
  and every app reads by: first `company.yaml` (name, UID, address, fiscal year), later
  `partners/` (suppliers, customers) and `people/` (the owner, employees).
- **It is reserved now and stays empty until a second app needs a piece of it.** Until then the
  company's identity stays in `vanilla-accounting/belege.workspace.yaml`, and the suppliers in
  `vanilla-accounting/knowledge/`. When a second app arrives, the shared part moves: the partner
  itself to `master-data/partners/`, the booking rules for it stay in the app.
- **Inside an app, the same split holds, with the same names:** the app's own master data in its
  `master-data/`, its transactional data in its `transactional-data/`, and its customizing (the
  settings and rules a person or an LLM changes through the change workflow) at the app's top
  level.
- **Transactional data stays in its app's folder.** Its rules belong to the app that writes it (a
  filed quarter never changes, the seals), and one app's records reach another through that app's
  interface: an HR app books salaries through Vanilla Accounting's write door, as all modules of
  a large system post into its one journal through the ledger's own logic.

### Customizing apart from records, so a large company can cut there

Large systems separate three kinds of data: **customizing** (configuration and rules),
**master data** and **transactional data**. The layout keeps the same cut, because it is where a
large company splits its repository:

- **A small or medium company keeps everything in one repository.** Everyone who works on the
  books may read all of it.
- **A large company keeps code and customizing in the company's repository,** which every
  contributor reads and changes (with an LLM, through review), **and moves master and
  transactional data to records repositories,** one per access domain (the books apart from
  payroll), with the same layout (`master-data/`, `transactional-data/<year>/`). Only the platform
  clones them; people reach them through the web UI and the API, by role. Its changes to the
  financial apps pass review by a second person, the tests and an approval before they go live
  (the change management of an internal control system, OR 728a).
- **The app reads and writes records the same way in both;** only where the records repository
  lies differs.

So `knowledge/` (the booking rules and precedents per supplier, customer and authority) is
customizing and lies at the app's top level, not in `master-data/`. A partner's identity (name,
UID, bank account) is master data; it moves out of `knowledge/` to `master-data/partners/` when a
second app needs it, and the rules for booking it stay in `knowledge/`.

### Inside the app's folder: master data, and transactional data by fiscal year

```
vanilla-accounting/
  belege.workspace.yaml  mail.yaml  secret-terms.txt  VERSION  AGENTS.md   settings  ┐ customizing
  knowledge/        rules per supplier, customer, authority, and per step   ┘
  beleg-import/   data/   history/   invoices.json
  master-data/
    accounts.json     the chart of accounts
  transactional-data/
    2026/
      books/            entries.jsonl, transactions.jsonl, mappings.jsonl (ADR 0003 §3)
      receipts/
      bank-statements/<bank>/
      filings/          VAT returns, seals, year-close.json
      invoices/         PDFs of issued invoices, sent/
      expected/         the figures test:books compares against
    2027/
      …
```

- **Within one app, the year is the unit everything acts on.** Closing, sealing, the auditor
  export of the audited years, the cloud instance's window of years (ADR 0003), the deletion
  after the retention period: each takes one year of every part of the books. With the year on
  top each is one folder; with the part on top (`books/2026/`, `invoices/2026/`) each is one
  folder per part, and "a closed year is read-only" is enforced once per part.
- **The parts of the books are the folders inside the year** (`books/`, `invoices/`), so they
  keep their own namespace.
- **The fiscal year, not the quarter.** The quarter is a period of the Swiss VAT return; another
  jurisdiction files monthly or yearly (the `xx` swap test files yearly). The fiscal year exists
  in every jurisdiction and is the period that closes for good: the fourth quarter stays open
  after its filing for the year-end entries. Quarters remain in file names (`filings/`).
- **What outlives a year and describes a thing is master data** and lies in `master-data/`: the
  chart of accounts. The same name as at the repository's root, one level down: the root's is shared
  by the apps, the app's is its own.
- **Customizing lies at the app's top level:** the settings (the manifest, the mail and
  secret-term lists, `VERSION`, the agents' files) and `knowledge/`.
- **The rest also stays at the top level:** the inbox (`beleg-import/`), the app's working
  files outside git (`data/`), the exports of an earlier program (`history/`), and the records not
  yet split (`invoices.json`: customers and invoices; its split into customers in `master-data/`
  and invoices by year is a later step).

A closed year's folder is never written again. The write door (`update(books, actor, fn)`) opens
only the files of open years; a closed year is read-only by layout, the seal stays the proof.

### A file lies in the year whose entry books it

A receipt or a statement lies in the folder of the fiscal year of the entry that books it. Which
date that is follows the workspace's VAT reporting (`vat.reporting` in `belege.workspace.yaml`):
the payment date when tax is reported on received payments (vereinnahmt), the invoice date when
on agreed payments (vereinbart). The folder follows the method; there is no rule of its own.

- **Booked from two years:** an invoice unpaid at 31.12 is a liability in the annual accounts (a
  year-end entry dated in the old year) and a payment in the new year. It lies in the year of the
  first entry that books it; mappings name a receipt by its id, not its path, so the new year's
  entry links it there.
- **Not booked yet:** ingestion files a new receipt in the open year of its date, or in the
  earliest open year when its date lies in a closed one. When it is booked in another open year,
  it moves there; that changes only its `filename`, which no seal covers.
- **A closed year takes no new file.** A receipt that arrives after its year's close is booked in
  the open year, so it lies there.
- **Issued invoices** lie in the year they are issued, which is always open.

Moving the files costs no sealed data. The seals hash journal entries, bank transactions and
mappings (`src/books/seal.ts`); a mapping names its receipt by id (`receiptId`); the path is the
`filename` of the receipt record, which no seal covers. No journal entry and no filed return names
a receipt's or statement's path (checked on the demo and on a real workspace: none). The filed returns and seals keep their content and change only their folder
(`filings/2026/` → `2026/filings/`). Paths inside the workspace are relative to it, so moving the
whole workspace into `vanilla-accounting/` changes no record either.

### One list of what the app knows

`WorkspacePaths` (`src/workspace/workspace.ts`) is the single list of the names Vanilla
Accounting's folder may hold, in its own top level, in `master-data/` and in a year folder of
`transactional-data/`. Each name carries its owner:

| Owner | Meaning | `vanilla-accounting/` | `master-data/` | `transactional-data/<year>/` |
|---|---|---|---|---|
| `app` | written by the app; a person changes it only through the app | `invoices.json`, `data/`, `VERSION` | | `books/`, `filings/`, `invoices/`, `expected/` |
| `company` | added or edited by a person, read by the app | `belege.workspace.yaml`, `beleg-import/`, `history/`, `mail.yaml`, `secret-terms.txt`, `knowledge/`, `AGENTS.md`, `CLAUDE.md` | `accounts.json` | `receipts/`, `bank-statements/` |

A year folder's name is a four-digit year; `transactional-data/` holds nothing else. The migration, the leak guard, the workspace check and
the audit export read this list instead of keeping their own.

### Everything else goes into `own/`

`own/`, at the repository's root, is the one folder for files no app has anything to do with:
notes, plans, scripts, reference documents. No app reads, writes, moves or migrates anything in
it. The leak guard treats it as secret, like everything unclear.

The workspace check (`npm run doctor`, `src/workspace/checks.ts`) warns about any other name in
`vanilla-accounting/`, its `master-data/`, its `transactional-data/` or a year folder, and at the repository's root about any name that is
neither a git or agent file, `master-data/`, `own/`, nor a folder holding an app's manifest: "`<name>` is not
part of the workspace: move it to `own/` or delete it". It does not move anything itself.

### `golden/` becomes `expected/`

`golden/` holds the figures the books are expected to give (VAT returns, balance sheet, income
statement, trial balance) per period, and `npm run test:books` compares the books against them.
They are not frozen: `test:books:update` rewrites them when a change of the app is meant to change
a figure, and the diff is reviewed. "Golden master" is testing jargon, and the same word already
names "golden rule 1" (a filed quarter never changes), which means something else. `expected/`
says what the folder is, and it lies in the year it checks (`transactional-data/<year>/expected/`). The scripts follow:
`test:books:freeze` → `test:books:init`.

### The layout comes before the first year close

The year split moves out of ADR 0003's order of work into the 0.4.0 migration as its own step
(step 14), independent of the cloud instance. It lands before the first year close of a workspace
on the app, and the same migration does the app folder and the other renames of this ADR, so a
workspace is migrated once.

## Consequences

- A person sees at a glance which folder belongs to which app and what each app owns; the
  workspace check names every stray file.
- A second app joins the repository as a folder beside `vanilla-accounting/`, without a migration
  of the books.
- No folder grows without end: a year's folders stop growing when the year closes, and
  `transactional-data/` gains one folder per year.
- One migration changes paths in a workspace: the books move into `vanilla-accounting/` (with
  `git mv`, history kept); inside it `accounts.json` → `master-data/`;
  `books.json` → `transactional-data/<year>/books/…`, `receipts/` and `bank-statements/` →
  `transactional-data/<year>/…` by the rule above, `filings/<year>/` →
  `transactional-data/<year>/filings/`, `invoices/` → `transactional-data/<year>/invoices/`,
  `golden/` → `transactional-data/<year>/expected/`; stray names → `own/`
  (proposed by the check, done by the person).
- The code that names these paths follows (`workspacePaths`, the workspace resolution, the seal
  and year-close writers, the filed-return readers, the audit export, the scaffold), and so do the
  demo workspaces (`demo/vanilla-accounting/`, so the demo has the shape of a real repository),
  the test fixtures and the docs (`getting-started.md`, `quarter-workflow.md`, `year-end.md`,
  `audit-export.md`, `processes/vat-filing.flow.yaml`, the AGENTS files).
- The step's gate: `npm test` and `npm run test:books` give the same figures before and after,
  with no update of the expected figures; every seal still verifies; `check-public` stays at 0.
- `invoices.json` stays one file for now and grows with every invoice.
- A large company's split (records repositories per access domain behind the platform) is the
  direction, not built; this step only keeps the cut between customizing and records clean.
- The company's identity moves from `belege.workspace.yaml` to `master-data/company.yaml` with
  the second app that needs it, not in this step.

## Alternatives

- **The books at the repository's root** (as today). No place for a second app, and the books'
  check cannot tell another app's files from stray ones. Rejected.
- **The part of the books on top inside the app** (`books/<year>/`, `receipts/<year>/`, …, ADR
  0003 §3 as written). Splits by year too, but a year is then spread over five folders, and
  closing or exporting it touches each. Replaced by the year on top.
- **One shared store without app folders** (`master-data/` and one `transactional-data/` for
  every app, as in a large system of one maker). Works there because one maker owns every module
  and the one schema; here a game and the books would share a folder, every app would have to
  keep the books' closed-year rules, a schema change of one app would break another, and no one
  could say which app may write what. Its useful half, shared master data, is kept. Rejected.
- **The year on top of the repository** (`2026/vanilla-accounting/`, `2026/vanilla-hr/`). Ties
  every app to one fiscal year and one close; an app of another maker has no fiscal year at all.
  Rejected.
- **The quarter as folder.** A Swiss VAT period, not one that closes for good; a yearly or monthly
  jurisdiction would need another layout. Rejected.
- **Keep `receipts/` and `bank-statements/` in place until ingestion files by year** (this ADR
  before its amendment). Assumed every record names its receipt's path; it names its id. A second
  migration for no saving. Rejected.
- **Mark ownership outside the files** (Finder tags, a README). Not in git, not checked, goes
  stale; a stopgap only.
- **Keep one `books.json` until a second person works on the books.** The closed-year problem
  comes with the first year close, not with the second person.
