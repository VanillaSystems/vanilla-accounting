# Money movements

## Decided direction (owner, 23.10.2026)

The owner follows accounting best practice with one simple question for the person. Option A below is
chosen; B and C stay as the alternatives considered.

1. **Underneath (option A).** Money accounts are equals: bank, cash box, owner current account,
   employee accounts, credit card, PayPal. Every one of them, a bank account included, takes
   movements from receipts, answers and hand entries, and statement imports when the person has
   them (owner's correction of 23.10.2026, below). A later payment between two money accounts is a
   transfer, carries no VAT, and settles the balance.
2. **On top, one quiet question** on a receipt with no fitting bank movement: «Wer hat bezahlt? ·
   Firma (Bank) · Kasse · Ich privat · Mitarbeiter … · Karte · Noch offen (Rechnung)».
   - «Firma (Bank)» waits for the payment (#29).
   - «Ich privat» books onto the owner account, with an optional business share (#87).
   - «Noch offen» makes an open item with a due date and books nothing (cash basis).
   - The answer is learned per supplier («bezahlt: Kasse (wie immer)») and changes in one click.
   - The phone app asks the same question after the photo.
3. **No setup.** Accounts appear when first used: the cash box asks its opening balance once, an
   employee is named, a card asks which card.
4. **Settling by itself.** A bank payment to the owner, an employee or the card company settles the
   open balance («Ausgleich: 3 Auslagen von «Name», CHF «Betrag»»). No second booking.
5. **One overview «Wer schuldet wem?»**, shown as facts, no reminders.
6. **The AI always knows the way**, never answers «geht nicht»; everything works by hand too.
7. **Input-tax date** per the agent's reading: for an outlay the receipt day, for a card the day
   charged. One central setting, marked «mit Treuhänder bestätigen». **To confirm with the
   Treuhänder** before it is relied on.

**Order of work:**

1. #87 (owner's share): done.
2. #89: a document on a booking without money.
3. Money accounts and the format step (option A; manifest schema 2, books schema 3). **Critical:
   a format change, needs the owner's OK before merge.**
4. «Wer hat bezahlt?» and learning per supplier (#91 cash, #92 employees, #94 card, #95 other accounts).
5. Settling and the overview.
6. Open invoices, credit notes, set-off (#93).
7. Card statements as a source.

The list under «Steps» is the earlier, finer proposal; where it differs, this order wins.

## Owner's correction (23.10.2026): statements are optional on every account

«The bank statements are not always imported. They should be importable, but it's not required.»

- **No fixed mode per account.** There is no `movements: statement | receipts` field. Every money
  account, a bank account included, gets movements from receipts, answers and hand entries, and
  takes statement imports when the person has them. The manifest names only each account's `role`.
- **A statement imported later is matched, not added.** Rows of the statement that fit a movement
  already known are paired with it; only the rest become new movements. No duplicates.
- **Each movement keeps its origin**, statement or receipt/hand, and says whether a statement
  confirms it.
- **Reconciliation against a closing balance** covers the periods a statement covers. An account
  or a month without a statement shows its balance from the movements, marked as not reconciled.

## Built in step 3 (#88): money accounts and the format

**The manifest (schema 2).** Each entry of `bankAccounts` is a money account and names its `role`:
`bank`, `cash`, `owner`, `employee`, `card` or `clearing` (`src/workspace/banks.ts` `MoneyRole`).
`statements` stays: how the account's statements are read when imported, from the bank registry when
not named; it is no mode. An owner's or employee's account may carry the person's own `iban`. The
label `manual` is the owner's account (every filed outlay carries it), so its role must be `owner`,
and at most one account is the owner's. The key stays `bankAccounts`, to keep every manifest and
every reader as they are.

```yaml
schema: 2
bankAccounts:
  - { bank: Raiffeisen, currency: CHF, account: "1021", label: Bank Raiffeisen, statements: camt053, iban: CH…, role: bank }
  - { bank: Kasse, currency: CHF, account: "1000", label: Kasse, role: cash }
  - { bank: manual, currency: CHF, account: "2451", label: Kontokorrent Anna Muster, role: owner }
```

The step 1 → 2 (`MANIFEST_MIGRATIONS[1]`, on the YAML document, so comments stay) gives each account
the role it had implicitly: `owner` for `manual`, `card` for a card issuer of the bank registry,
`bank` otherwise. A change from the Firma page climbs an older manifest first and writes it at
schema 2; `npm run update` does the same with a backup.

**A movement (books schema 3).** `BankTransaction` stays the record of a movement on any money
account. Its `bank` is the money account's label. Two fields carry the origin:

- `source`: absent for a row of an imported statement (every record without it has been one);
  `manual` when a receipt, an answer or a hand entry made it. Unchanged from before.
- `statement` (new): on a movement made by hand, the ref of the statement row that confirmed it.

The step 2 → 3 changes no record: the origin was stored already, and a filed record keeps every
byte, so every seal holds. The version number exists so that an app of schema 2 refuses these books
(`SchemaTooNewError`): it would import a confirmed row a second time and book a cash box's movement
on its first bank account.

**One predicate and a role lookup** (`src/workspace/money-accounts.ts`) replace the scattered
`manual` checks: `byStatement(tx)` (a statement row, or a hand movement a row confirmed),
`madeByHand(tx)`, `accountOf(tx, accounts)` and `roleOf`, `ownerOf`, `banksOf`. `bankAccountFor`
refuses a movement on an account the manifest lacks (`UnknownMoneyAccountError`) instead of booking
it on the first bank account. Every money account is a money account for VAT: a booking between two
of them is a transfer and carries no code (`moneyAccounts`); only a bank's or the cash box's chart
line brings its neighbours along.

**A statement imported later** (`src/books/bank-import.ts` `matchStatementRows`). A row confirms an
open movement made by hand on the same account (label and currency), in the same direction, for the
same amount, within 7 days (`MATCH_DAYS`); when both name a counterparty, the names share a word.
Each row takes one movement, the closest day first, then the pair whose texts share a word. The
movement keeps its ref, its bookings, its links and its origin, and gains `statement`; the row is no
new movement. A re-import finds the row on the movement and adds nothing. Taking the statement back
removes `statement` again, and the movement stays. A filed movement is never matched (it keeps every
byte), so a row whose only fit is a filed hand movement becomes a new movement.

**Reconciliation.** The Bank area lists every account at a bank and every account that takes
statements. A month without a statement is no problem and no badge: «ohne Auszug», with the balance
from the movements, reconciled with no statement, and the well to import one. A statement's own
checks are as before; a hand movement a row confirmed counts as that row. Firma › Geldkonten shows
each money account with its role; an account no statement covers shows the sum of its movements up
to today, «aus den Bewegungen, nicht abgestimmt».

**Accounts appear when first used.** `POST /api/transactions/manual` makes a movement on any money
account (`account`, `direction`, the owner's when none is named). For an account the manifest lacks,
`role` and `label` add it in the same request. No screen calls it yet; «Wer hat bezahlt?» (#91 #92
#94 #95) is its button and the AI's change kind.

Status: direction decided by the owner (23.10.2026, #88); the analysis below is the proposal it rests on. Found by the audit after #87: a receipt
the owner paid privately got stuck because the AI said «a booking needs a payment», although the
app has «Privat oder bar bezahlt». The question was whether other cases are blocked the same way.
They are, and for one reason: the bank movement is the only anchor a receipt can hang on.

## What the code does today

- A booking (`JournalEntry`) carries a `transactionRef`. A receipt reaches it only through
  `Mapping { transactionRef, receiptId }` (src/types/index.ts). `link` (src/server/edits.ts)
  refuses a ref that is not a `BankTransaction`.
- A booking without a payment (Buchungen › «Ohne Zahlung buchen», the AI's `newEntry` without
  `transactionRef`, the year-close templates) gets a fresh manual ref (`nextManualRef`) and no
  transaction. No receipt can be linked to it. `attachEntries` can later move it onto a bank payment.
- The one non-bank movement is the owner's outlay: `privatePayment` writes a `BankTransaction`
  with `bank: 'manual'`, `direction: 'DBIT'`, the receipt's date and amount, linked to it; the
  inbox run books it like any payment, onto the owner's account (src/accounting/bank-accounts.ts
  `ownerAccount`). `manual` is a magic label: about 24 places check `bank === 'manual'` or
  `!== 'manual'` (reconciliation, the Firma › Banken list, the link dialog, `moneyAccounts`, the
  second-payment guard, the owner's account itself). `POST /api/transactions/manual` makes the same
  kind of movement without a receipt; no screen calls it.
- The cash box exists only as a check: `cashNegative` (src/accounting/booking-warnings.ts) warns
  when 1000–1009 falls below zero. Nothing makes a cash movement.
- Credit cards and PayPal are known banks without a reader: src/workspace/banks.ts says «book the
  monthly card bill by hand» and «its payments are booked by hand».
- Supplier invoices: on cash basis nothing is booked until paid (correct, MWSTG Art. 40); an unpaid
  invoice is a receipt «offen» in Belege. There is no list of open bills and no due date.
- The AI sidebar's map (src/server/app-map.ts) gives Belege the kinds `receipt`, `link`, `unlink`,
  `receiptKind`. «Privat oder bar bezahlt» is in neither the map, the prompt
  (src/assistant/claude.ts) nor the change kinds (src/assistant/changes.ts). The prompt's
  `newEntry` example always names a payment. So the AI cannot do what a person can, the reverse of
  MISSION's rule, and it says «geht nicht» or books without the receipt.
- #29 (branch fix-29-wait-for-receipt, src/booking/receipt-wait.ts): a bank debit without a receipt
  waits, except money in, separate fees, transfers to the firm's own IBANs or onto a money account
  (`moneyAccounts`: the bank accounts and accounts on their balance-sheet line), rules that ask,
  receipt-free businesses, firms without input tax. The owner's account is not a money account
  (`moneyAccounts` drops `manual`), and the owner's private IBAN is unknown. So the bank payment
  that reimburses the owner's outlays waits for a receipt it will never get.

## The cases

a: a path by hand · b: the AI knows and offers it · c: the receipt is linked · d: works with #29 ·
e: VAT from the receipt's facts (I0 without Swiss VAT) · f: whatever the AI does, a person can do.

| Case | a | b | c | d | e | f |
|---|---|---|---|---|---|---|
| 1 Owner paid privately or cash, whole | ✓ «Privat oder bar bezahlt» | ✗ not in map, prompt or kinds | ✓ | partial: outlay never waits; the reimbursement waits | ✓ classify reads the linked receipt | partial: the person can, the AI cannot |
| 1 Owner, business share only | ✗ (#87) | ✗ | ✗ | as above | ✗ | ✗ |
| 2 Kasse: purchase from cash | partial: «Ohne Zahlung buchen» D 6xxx / C 1000 | partial: `newEntry` without link | ✗ | n/a: the receipt stays «offen» forever | ✗ code typed by hand | partial |
| 2 Kasse: Bancomat withdrawal, deposit | ✓ booked 1000 / bank | ✓ | n/a | ✓ transfer onto a money account | ✓ no code | ✓ |
| 3 Employee advanced, reimbursed in one payment | partial: link all receipts to the reimbursement | partial: `link` | partial: only to that payment | ✓ waits until linked | partial: booked on the payment date; several receipts per payment is #27 | partial |
| 3 Employee's outlay before reimbursement | ✗ no employee account | ✗ | ✗ | n/a | ✗ | ✗ |
| 4 Supplier invoice not yet paid | partial: nothing booked (correct), no open-bills list | partial | ✓ once paid | ✓ the payment waits for the invoice | ✓ when paid | partial |
| 4 Credit note without payment | partial: link with the next payment of that supplier, else entry without link | partial | partial | ✓ | partial (#27) | partial |
| 4 Paid by set-off (Verrechnung) | ✗ | ✗ | ✗ | n/a | ✗ | ✗ |
| 5 Card, statement not imported | partial: link card receipts to the monthly bank debit | partial | partial | partial: the debit waits; a rule onto the card account still waits (not a money account) | partial: dated on the bill, #27 | partial |
| 6 PayPal, Twint, a second bank without reader | ✗ only entries without link, or a wrong outlay on the owner | ✗ | ✗ | n/a | ✗ | ✗ |
| 7 Eigenbeleg, original lost | ✗ (#8) | ✗ says it can't make PDFs | n/a | partial: «Ohne Vorsteuer buchen» exists, no Eigenbeleg | should be I0 | ✗ |
| 8 Accrual, depreciation, gift received | partial: year-close templates, «Ohne Zahlung buchen» | partial | ✗ `link` needs a transaction | n/a | ✓ templates carry no code | partial |
| 9 Cash sale, Kassenbericht | partial: entry D 1000 / C 3000 V81 by hand | partial | ✗ the sales record has no movement | n/a | partial: rate typed by hand; the sale question only for bank credits | partial |

The demo's Kassenbericht (tools/demo/kaffee.ts) is a card-terminal payout tied to a bank credit, so
it proves nothing about cash.

One double-booking trap found on the way: `assertNotSecondPayment` ignores `manual` payments, so a
person can link a receipt already paid privately to the bank payment that reimburses it, and the
expense and its input tax are booked twice (the matcher itself skips linked receipts).

## The idea

Generalise the anchor from «bank movement» to «movement on a money account».

- A **money account** is a ledger account money sits on or is owed through: a bank account, the
  cash box, the owner's current account, an employee's account, a credit card, a clearing account
  for set-offs. Each says where its movements come from: `statement` (a reader exists) or
  `receipts` (made from receipts, or typed by hand).
- **Statements confirm, they are not required** (owner's correction). Any account takes
  movements by hand and statements when the person has them; a statement row confirms a movement
  already known instead of adding a second one. Reconciliation against the closing balance stays
  strict where a statement exists.
- On every other money account a **receipt makes the movement**: «Bezahlt mit: Firma per Bank /
  Kasse / du privat / Mitarbeiter X / Kreditkarte / noch offen». The movement is dated on the
  receipt, for its amount or the business share (#87), linked with the existing `Mapping`.
- **The booking follows the normal path**: the inbox run books the movement like a bank payment, so
  rules, the rule card, facts-then-code VAT and the private share all apply unchanged. Its other
  side is the money account instead of the bank.
- **A later bank payment settles.** The reimbursement to the owner or an employee, the card bill,
  a cash deposit: a bank payment booked onto a money account is a transfer. It carries no VAT code,
  never waits for a receipt (#29), and lowers that account's balance. Nothing is booked twice,
  because the expense was booked once, on the movement.
- **«noch offen» is not a movement.** On cash basis an unpaid bill books nothing and claims no input
  tax until it is paid (MWSTG Art. 40). It is a receipt state with a due date, listed as an open
  bill; the bank payment links to it and books it as today.
- **A booking without money** (depreciation, accrual, private share, a correction, a gift
  received) **carries its receipt directly**: a `Mapping` on the manual entry's ref. Seals already
  hash a mapping whose ref a closed entry books (src/books/seal.ts `closedPart`), so the Mapping
  shape stays.
- **The AI asks** «Wer hat das bezahlt?» when no rule, precedent or receipt tells, with the same
  choices as the button, and never answers «geht nicht» where a path exists.

## Options

### A. Reuse `BankTransaction`, a money account per label (chosen)

The manifest's `bankAccounts` become money accounts: each entry gains `role` (`bank`, `cash`,
`owner`, `employee`, `card`, `clearing`), and an owner or employee entry may name the person's own
IBANs, so a bank payment to them is recognised as a settlement. (The `movements: statement |
receipts` field first proposed here was dropped by the owner's correction: statements are optional
on every account.) `manual` stays the owner's label, so every filed `bank: 'manual'` transaction stays
byte-identical and no seal changes. A receipt-born movement is a `BankTransaction` with `bank` set
to the money account's label, `source: 'manual'`, a manual ref, and `direction` from the receipt
(money out for a purchase, money in for a cash sale).

- For: everything keyed on a payment works unchanged: classify, rules, `receiptWait`,
  `bookPayment`, `attachEntries`, `relinked`, undo by deleting the movement, seals, the period
  lock. The 24 `manual` checks collapse into one per-movement predicate and a role lookup
  (src/workspace/money-accounts.ts `byStatement`, `roleOf`), which makes the domain explicit
  instead of a magic string.
- Against: the type's name lies («BankTransaction» on the cash box). Every bank-only view filters
  by role.
- Schema: the manifest climbs to schema 2 (each entry gains its `role`); the books climb to schema
  3, because an older app would book a cash movement onto its first bank account (`bankAccountFor`
  fell back to it) and import a confirmed row twice, and must refuse such books
  (`SchemaTooNewError`).

### B. A new `MoneyMovement` collection (considered, not chosen)

A separate list beside `transactions`; `Mapping` and `JournalEntry` name a movement or a
transaction.

- For: honest types; a bank movement can never be confused with a cash one.
- Against: every consumer of `transactionRef` takes a union (classify, rules, receipt-wait, the
  journal, the link dialog, the inbox run, exports). Seals hash a new collection, so the seal rule
  text changes and every existing seal needs a story. A books migration with a real step. Weeks,
  for the same behaviour as A.

### C. Receipts on bookings only, no movements (considered, not chosen; its one piece is step 2)

Allow a `Mapping` on any manual entry, and let the person book cash, private and card purchases
as entries by hand with the receipt attached.

- For: the smallest change; it alone fixes case 8 and stops receipts being lost.
- Against: the AI and the rules never see these purchases: classify runs per payment, so no
  facts-then-code VAT, no rule card, no automation. No balance per money account, nothing to settle
  a reimbursement against. It trades a stuck receipt for hand work, against MISSION's «code first».

**Recommendation, adopted by the owner: A, with C's one piece** (a receipt on a booking without money) as its first
step. B is the same behaviour at many times the cost and risk to seals.

## How it meets the rules

- **Filed periods.** Movements obey `assertOpen` like any transaction. A receipt dated in a filed
  period gets its movement on the first open day with `corrects` (as `privatePayment` does today,
  r8k-10). Filed records keep every byte; seals change neither rule nor content.
- **VAT.** Cash basis: input tax counts when the company pays. For the cash box, the owner and an
  employee that is the day of the outlay, which is the receipt's date: the company owes the person
  from then on (inferred; the Treuhand should confirm for employees). A card purchase counts on the
  card charge, not the bill (inferred, same caveat). VAT comes from the receipt's facts as today:
  a rate code only when the receipt shows Swiss VAT, I0 otherwise, no code on a private share. A
  set-off is a payment received and made on the set-off day (inferred). The settling bank payment
  carries no code.
- **#29.** Wait only for bank-paid receipts. A bank payment onto any money account, the owner's
  and employees' included, is a transfer and never waits. A receipt-born movement is linked from
  birth and never waits. The «Beleg fehlt» item may offer «Wer hat bezahlt?» when the payment was
  in fact a settlement.
- **Reconciliation.** The balance check runs where a statement exists; elsewhere the balance comes
  from the movements, marked as not reconciled. Each money account gets a list with its running balance: Kassenbuch (with the `cashNegative` check),
  Kontokorrent Inhaber, each employee, the card, the clearing account. What is open there is what
  is still owed.
- **Existing paths folded in.** `privatePayment` becomes «Bezahlt mit…» with the owner chosen.
  The Kassenbericht becomes a sales record that makes a money-in movement on the cash box when the
  takings were cash. `POST /api/transactions/manual` becomes the hand form for a movement on any
  receipts-account (PayPal, Twint, a second bank without reader).
- **ADR 0015.** Everything above is generic: roles, not vendors. A card issuer's or PayPal's
  quirks stay in the workspace's knowledge, and a statement reader per provider stays a provider.
- **MISSION.** Each step ships with its button first and its AI change kind in the same PR: the
  person can do by hand whatever the AI does, and the AI can do whatever has a button.

## Steps

Each step ships alone, smallest first.

1. **The AI knows the outlay** (#87): «Privat oder bar bezahlt» in the app map and as a change
   kind; the prompt asks who paid and never books a receipt's purchase without its link.
2. **A receipt on a booking without money** (#89): `link` takes a manual entry's ref; Buchungen and the
   receipt show the link; the AI's `link` takes it too. Seals unchanged.
3. **#29 settlements** (#90): a bank payment booked onto the owner's account, or to the owner's IBAN,
   never waits; the second-payment guard covers a receipt paid privately.
4. **Money accounts in the manifest** (#88): `role`, own IBANs; manifest schema 2, books schema 3;
   one predicate and a role lookup replace the `manual` checks; a statement imported later is
   matched to movements made by hand. Built: see «Built in step 3» above.
5. **«Bezahlt mit…»** on a receipt (#91 cash, #92 employees, #94 card, #95 other accounts) (Kasse, privat, Mitarbeiter, Kreditkarte, another account,
   noch offen), with the business share from #87; AI change kind `paidWith`.
6. **Per-account lists**: Kassenbuch, Kontokorrent, employees, card, with running balance and what
   is open.
7. **Cash sales** (#91): a sales record paid in cash makes a money-in movement on the cash box.
8. **Open bills, credit notes, set-off** (#93): due dates and the open-bills list; a credit note against
   the next invoice; a set-off on a clearing account.
9. **Card statements** (#94): when a reader exists, the card's statement is imported like any
   other, and its rows are matched to the receipt-born movements (the matching of step 3).

Tracked in #88. Related: #87, #29, #27, #8.
