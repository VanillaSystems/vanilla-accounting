# Replay benchmark

Replays one filing period of a workspace's books from a clean slate and measures what the app does
with it: how many payments it closes untouched and correct, how many need a person and how, how many
it books wrong without saying so, whether the period's VAT figures come out as the real books have
them, and what the model calls cost in tokens. Generic: it works on any workspace.

```
npm run replay -- prepare --source <workspace> --period 2026-Q3 --arm cold  --out <folder>
npm run replay -- run <folder> --stub     # dry run: the real code, no model call
npm run replay -- run <folder> --real     # the claude CLI of this Mac, on its subscription
```

Each run needs its own `prepare` (a folder runs once). The folder holds a copy of the company's books,
its answer key and the result: put it outside every repository (for example under `$TMPDIR`). The source
workspace is only read.

## The copy (cut.ts)

`prepare` copies the workspace folder into `<folder>/repo/` (a git repository of its own) and cuts its
books at the eve of the period, line for line as the books know them, so the seals of the filed periods
hold:

- a payment dated after the cut goes, with its entries; every entry dated after the cut goes;
- a receipt goes when it is linked only to such payments or entries, or linked to none and dated after
  the cut; the links of either go; statements starting after the cut and later balances go;
- the run log empties; questions asked after the cut, VAT adjustments of the period and later, and
  correction cases whose correcting entries went, go.

Left out of the copy: `data/` (this machine's state, the ledger), `sources/`, `mail.yaml` and
`collected/` (no mailbox is read), `handover/`, `output/`, `beleg-import/`, and the year's `expected/`
(the golden figures, which would hold the answer).

The period's inputs go to `<folder>/inputs/`: every statement file whose days reach past the cut, and
every receipt set aside that belongs to the period (linked to one of its payments or entries, or
unlinked and dated in it), under the name it arrived with. Receipts of a later period stay out.

Two arms (`--arm`):

- `cold`: an empty `knowledge/`. The app has its own processes and supplier files and nothing the
  company taught it. A provider's accounts are asked at the drop and answered from the company's file
  (an intake touch).
- `today`: the workspace's `knowledge/` as it is now. An upper bound: part of it was learned from the
  replayed period itself.

## The answer key (key.ts)

`<folder>/key.json`, from the source books before the cut:

- `cases`: the period's bank payments (every movement a statement brought), each with all its entries
  and its receipt links. A case is the unit the replay counts.
- `manual`: movements a person entered by hand (cash, a private outlay). The oracle enters them.
- `other`: entries of the period on no payment: a provider report's (`SR-…`, `SF-…`, booked by the app
  from the dropped report) and a person's own (`hand`).
- the period's VAT adjustments, which the oracle enters, and the period's figures (`vat().figures`),
  with whether that return is filed.
- Corrections of filed periods dated in the period on no payment of it are counted, not replayed: they
  belong to the 0535 of the period they correct, not to this return.

## What counts as right (compare.ts)

Per payment, two things:

- its booking lines: date, debit account, credit account, VAT code and amount in the books' currency,
  to the cent. A negative amount is the same line the other way round. Lines with the same date,
  accounts and code are summed first: one line of 100 equals two of 60 and 40. Descriptions, exchange
  rates and who booked it do not count.
- its receipt links: the same set of receipts, by id (a receipt's id is the hash of its file, so a
  dropped file has the id the real books gave it). One exception: a bank statement's PDF the real books
  keep as a receipt too (a card line's proof) is read by the drop as the statement it is and held once;
  a link to it is not asked of the replay.

## The run (drive.ts)

The app's own server runs on the copy (`src/server/main.ts`), with its runs, approvals and AI settings
in `<folder>/state/` (the app's default model per step; Codex is never asked). Every write goes
through the app's API, so through the write door and the runs:

1. **drop**: one drop session, the bank exports first, then the statement PDFs, then the receipts. A row
   that waits is answered as a person would from the real books: a provider's missing account from the
   company's file of the provider, a statement PDF kept as the month's statement, two receipts the books
   both hold «different», a file the books hold as a receipt taken as one.
2. **run-1**: «Eingang verarbeiten» (the inbox run, started by hand), until every run rests.
3. **oracle-1**: where the app left each payment is recorded (right, wrong, asked, open), then the
   oracle links the receipts the key links and unlinks the others, says «needs no receipt» where the key's
   payment needs none and the app waits for one, and answers the app's sale question by the key's
   booking. It enters the hand movements with their receipts and the period's VAT adjustments.
4. **run-2**: «Eingang verarbeiten» again.
5. **oracle-2**: a payment whose lines still differ is booked as the key books it (by hand when the app
   booked nothing, else in place of the app's lines), links put right again; the same for the hand
   movements and the other refs.
6. The period's figures (`vat().figures`) against the key's.

## The oracle (oracle.ts) and the touches

Each action on a payment is a touch, of one kind:

| kind | when |
|---|---|
| `answer` | the app asked (a question or a task) and the oracle answered it or booked the payment |
| `hand` | the app left the payment unbooked and the oracle booked it |
| `correction` | the app booked it, the oracle booked it otherwise |
| `private` | a booking or correction that puts a share on the owner's account the app did not |
| `link` | receipts linked or unlinked |
| `noReceipt` | «needs no receipt» |

- **untouched and correct**: no touch, and the payment equals the key at the end.
- **silent error**: after the app's own runs the payment was booked, nothing was asked, and it did not
  equal the key (lines, or the links alone).
- **not closed**: the payment differs from the key even after the oracle; a dry run must have none.

## Tokens

Every model call is a line of the copy's `data/llm-ledger.jsonl` (src/llm/ask.ts and judge.ts): step,
provider, model, input, cache create, cache read, output, ok. The result sums them per phase, step and
model, tokens only. With `--stub` (tools/replay/stub-claude.mjs) each prompt gets an answer in its
step's format that decides as little as it can: a match finds no payment, the VAT facts show no tax,
every payment is booked on one expense account without a code (the oracle corrects them all), the rest
is empty. So the app takes each answer once, as it would a real one, and the dry run's ledger counts
about the calls a real run makes; its tokens are an estimate (the prompt's characters / 4, attachments
not counted, no output).

## Output

`<folder>/result.json` (everything, with the payments' refs and diffs) and `<folder>/summary.md`;
`<folder>/state/` has the run log, the server's output, the drop session and the runs. All of it is
company data: it stays in the folder.
