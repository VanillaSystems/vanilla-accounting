# ADR 0008: One inbox, checked before anything enters the books

Status: accepted (2026-10-10). Partly built: `beleg-import/` and `npm run extract` exist; the
checks, the compression rule, the quarantine and the drop zone do not.

## Problem

Documents arrive by many ways: mailboxes (`npm run collect`), the `beleg-import/` folder, the
phone (`/api/upload`), bank exports (camt.053, camt.052, PDF statements, Wise exports). Today a
file lands in `beleg-import/`, `npm run extract` gives it its id (the SHA-256 of its bytes,
`src/cli/extract.ts`) and its kind, and archiving moves it into `receipts/`, which is in git.

Measured on a real workspace (October 2026, 858 files, 247 MB in `receipts/`):

- **About 28 % is not a receipt:** 51 MB marked `noise`, `duplicate` or `supporting`, and about
  18 MB of catalogues and brochures classified as receipts (the largest file, 9.9 MB, is a supplier's
  product catalogue). Private photos sit among them.
- **The large real receipts are mostly phone scans** (1 to 6 MB each); received e-invoices are
  mostly well under 1 MB.

Whatever enters git stays in its history, also after it is removed. So what is not a receipt
must be stopped before it gets there, and what can be made smaller must be made smaller before
it gets its id.

## Decision

### 1. One inbox for every channel

`beleg-import/` becomes the inbox for every document of every kind, and stays outside git (it
already is). Every channel delivers into it:

| Channel | For | Notes |
|---|---|---|
| **Drop zone in the app** | anyone at the desktop app or a cloud instance | drop anything anywhere on the window (receipts, statements, camt files, a ZIP); the page shows the inbox |
| **The folder itself** | scanners, shared folders, agents, scripts | as today |
| **Mail collection** | receipts sent by mail | as today, into the inbox |
| **Upload endpoint** | the phone, later | per-device tokens ([ADR 0003](0003-deployment-and-collaboration.md), section 9) |

The drop zone and the folder are the same queue: the folder is the inbox on disk, the drop zone
is its door in the UI. Nothing goes from a channel straight into the books.

### 2. The pipeline, in this order

```
 inbox ─► 1 recognize ─► 2 own scan? compress ─► 3 id (SHA-256) ─► 4 duplicate? ─► 5 decide
                                                                                    │
                       ┌────────────────────────────┬───────────────────────────────┤
                       ▼                            ▼                               ▼
              accepted: into the books      quarantine (outside git)       waiting: needs a person
              <year>/receipts/, statements  data/quarantine/ with reason   or the model
```

**1. Recognize what it is,** cheaply first, the model only for what remains:

- **By structure, without a model:** a camt.053 or camt.052 file (XML namespace), a Wise
  statement export, a ZIP (unpacked into the inbox), an image, a PDF.
- **By simple signals:** page count (a catalogue has thirty pages, an invoice one to three),
  size, the sender's rule in `mail.yaml` (newsletter, marketing), words such as Katalog,
  Broschüre, Preisliste, Newsletter, Datenblatt.
- **By the model** (the existing extraction and classification) for the rest: receipt, bank
  statement, supporting document, not a receipt, private.

**2. Compress own scans, never received documents.**

| Source | Compressed? | Why |
|---|---|---|
| Photo or scan the company made (phone, scanner app, the receipt app, an image dropped in) | **yes**, before the id: grayscale or colour at about 150 dpi, text stays readable | the paper is the original; the scan is the company's own copy, and readability is what counts |
| PDF received electronically (mail attachment, portal download, e-invoice) | **no**, kept byte for byte | it is the original document; a recompressed file is a different file whose checksum no longer matches what the supplier sent, and a signature or a QR-bill code inside it can break |

The decision is made from the channel and the file: an image, the receipt app, a scanner app's
producer field in the PDF, or a PDF whose pages are only images from the company's own scanner
count as own scans; a mail attachment counts as received. When unsure, the file is kept as it
is. This applies to every channel, the folder included: a phone photo dropped into
`beleg-import/` is compressed exactly like one from the receipt app. Compression happens
before step 3, so the id is the checksum of the stored file and never changes afterwards (a
receipt whose bytes change gets a new id and loses its links). This rule is an assessment of the
Swiss retention rules (Geschäftsbücherverordnung, MWST), to be confirmed with a Treuhänder.

**3. The id** is the SHA-256 of the stored bytes, as today.

**4. Duplicates** are caught before storing: the same checksum as a stored file, or the same
content (supplier, date, amount, number) as a stored receipt. A duplicate goes to quarantine
with a pointer to the original.

**5. Decide:**

- **Accepted:** receipts into `transactional-data/<year>/receipts/`, statements into `…/bank-statements/` (ADR 0013),
  committed with who brought them and by which channel; a camt file is imported into the books
  directly (it needs no model).
- **Quarantine:** not a receipt, a duplicate, a private photo. Kept in `data/quarantine/`,
  outside git, with the reason; listed in the app as "12 Dateien nicht übernommen", each with
  "doch übernehmen". Nothing is lost, and nothing reaches the history unchecked.
- **Waiting:** the recognition is unsure, or a fact is missing. It stays in the inbox with its
  question.

### 3. The inbox in the app, and the model

The inbox is a list: each item with what it was recognized as, its size, its checks and its
state. Processing the queue is one action with three doors:

- a button in the app ("Eingang verarbeiten"), which runs the steps that need a model on the
  subscription of whoever runs the app locally, or with the cloud instance's key;
- a command for an agent: `vanilla inbox process`, or the MCP tool `process_inbox`
  ([ADR 0005](0005-agents-command-registry-cli-mcp.md)): "Claude, process my inbox";
- automatically after a mail collection, if the company wants it.

Steps that need no model (camt import, checksum, duplicate by checksum, structure checks) run at
once when a file arrives; the inbox shows the rest as "wartet auf Verarbeitung".

### 4. Size

No upload limit of the app's own. A file over about 5 MB that is an own scan is compressed
anyway; a received file over 5 MB is shown with its size. The one hard limit is the git host's
(100 MB per file at GitHub, Bitbucket and Azure DevOps), refused with a clear message instead of
a failed push.

## Consequences

- `extract.ts` gains the recognize step, the own-scan compression before the id (today it only
  converts images to PDF), duplicate detection by content, and the quarantine.
- `beleg-import/` takes statements and camt files too; the Kontoauszüge import uses the same
  inbox.
- The app gets the drop zone and the inbox list (the mockup already has the full-page drop).
- Receipts and statements move into year folders (`transactional-data/<year>/receipts/`, `…/bank-statements/`) with the year split of the books, in the year of the entry that books them ([ADR 0013](0013-workspace-layout-and-ownership.md)).
- Files already in `receipts/` that are not receipts (catalogues, brochures, private photos) can
  be moved to quarantine; they remain in git history unless that history is rewritten, which
  [ADR 0003](0003-deployment-and-collaboration.md) avoids.
- Expected effect, estimated: without the 28 % non-receipts and with scans at a fraction of
  their size, a workspace like the one measured grows by about 150 to 200 MB a year instead of
  about 330 MB.

## Rejected

- **Recompressing received PDFs:** saves little (they are mostly small), and makes a document
  that is no longer the one the supplier sent.
- **Classifying after archiving** (today's order): a mistake is in git history before anyone
  sees it.
- **A hard size limit in the app:** blocks legitimate documents; the host's limit is enough.
- **Separate intakes per kind** (one for receipts, one for statements): one inbox that recognizes
  is simpler for the person dropping a file, who should not have to know what it is.
