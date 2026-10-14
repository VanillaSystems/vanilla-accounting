# ADR 0013: The workspace says what is the app's, and the books split by year before the first year close

Status: proposed (2026-10-14). Amends the order of work of
[ADR 0003](0003-deployment-and-collaboration.md); nothing of this built yet.

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

`books.json` holds every record of every year in one file. ADR 0003 §3 already decided the split
(`books/<year>/entries.jsonl`, `transactions.jsonl`, `mappings.jsonl`), but put it fifth in its
order of work, behind the cloud instance, and the 0.4.0 migration has no step for it. The first
year close of a workspace on the app is 31.12.2026. After it, every edit of the new year rewrites
the closed year's records in the same file: diffs of megabytes, and a closed year that only the
seal protects, not the layout.

## Decision

### One list of what the app knows

`WorkspacePaths` (`src/workspace/workspace.ts`) is the single list of the names a workspace may
have at its root. Each name carries its owner:

| Owner | Meaning | Names |
|---|---|---|
| `app` | written by the app; a person changes it only through the app | `books/`, `invoices.json`, `invoices/`, `filings/`, `expected/`, `data/`, `VERSION` |
| `company` | added or edited by a person, read by the app | `belege.workspace.yaml`, `accounts.json`, `receipts/`, `bank-statements/`, `beleg-import/`, `history/`, `knowledge/`, `mail.yaml`, `secret-terms.txt`, `AGENTS.md`, `CLAUDE.md` |
| `own` | the company's, never read or written by the app | `own/` |

The migration, the leak guard, the workspace check and the audit export read this list instead of
keeping their own.

### Everything else goes into `own/`

`own/` is the one folder for files the app has nothing to do with: notes, plans, scripts,
reference documents. The app never reads, writes, moves or migrates anything in it. The leak
guard treats it as secret, like everything unclear.

The workspace check (`npm run doctor`, `src/workspace/checks.ts`) warns about any other name at
the root: "`<name>` is not part of the workspace: move it to `own/` or delete it". It does not
move anything itself.

### `golden/` becomes `expected/`

`golden/` holds the figures the books are expected to give (VAT returns, balance sheet, income
statement, trial balance) per period, and `npm run test:books` compares the books against them.
They are not frozen: `test:books:update` rewrites them when a change of the app is meant to change
a figure, and the diff is reviewed. "Golden master" is testing jargon, and the same word already
names "golden rule 1" (a filed quarter never changes), which means something else. `expected/`
says what the folder is. The scripts follow: `test:books:freeze` → `test:books:init`.

### The year split comes before the first year close

Data by year and record (ADR 0003 §3, seals untouched per ADR 0004) moves out of ADR 0003's order
of work into the 0.4.0 migration as its own step, independent of the cloud instance. It lands
before the first year close of a workspace on the app, and the same migration does the other
renames of this ADR, so a workspace is migrated once.

A closed year's files are never written again. The write door (`update(books, actor, fn)`) opens
only the files of open years; a closed year is read-only by layout, the seal stays the proof.

`receipts/` and `bank-statements/` keep their paths in this step; their year folders
(ADR 0008) follow when ingestion files by year, because every record names its receipt's path.

## Consequences

- A person sees at a glance what the app owns; the workspace check names every stray file.
- One migration changes paths in a workspace: `books.json` → `books/<year>/…`, `golden/` →
  `expected/`, stray names → `own/` (proposed by the check, done by the person).
- The demo workspaces, the test fixtures and the docs (`getting-started.md`,
  `quarter-workflow.md`, `year-end.md`, the AGENTS files) follow in the same step.
- `test:books` must give the same figures before and after the migration; that is the step's gate.

## Alternatives

- **Move the app's files under one folder** (`app/books`, `app/receipts`, …). Clearest, but every
  record names its receipt's path and every filed return its folder; rejected for the cost.
- **Mark ownership outside the files** (Finder tags, a README). Not in git, not checked, goes
  stale; a stopgap only.
- **Keep one `books.json` until a second person works on the books.** The closed-year problem
  comes with the first year close, not with the second person.
