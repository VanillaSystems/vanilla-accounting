# Data model

Status: describes branch `0.4.0` on 2026-10-23. Derived from the code, not from a plan. When a type
changes, change its diagram here in the same commit.

This page shows what Vanilla Accounting keeps on disk for one company: the classes, their key
attributes, how they refer to each other, and which file each one lives in. It leaves out what the
app only computes (balances, the VAT return's figures, the views of the UI).

The diagrams are UML class diagrams in Mermaid. GitHub renders them. Each class names its file in
`<<…>>`. An association names the field that holds the reference, read in the direction of the
arrow. A dashed arrow is a reference by key (an id, a ref, an account number) that the code resolves.
A diamond is a value nested inside its owner's record.

| Diagram | What it shows |
|---|---|
| [1. Workspace and settings](#1-workspace-and-settings) | The files of a workspace, the manifest, the ledger head, the chart, the sources |
| [2. The books](#2-the-books-movements-receipts-links-entries) | Movements, statements, receipts, links and journal entries |
| [3. VAT and filing](#3-vat-filing-and-the-locked-past) | Tax codes, return forms, approved and filed returns, seals, corrections, the golden master |
| [4. Knowledge and rules](#4-knowledge-and-rules) | Business files, their matchers, guides, executable booking rules, notes |
| [5. Invoices](#5-invoices) | Customers, invoices, payments of an invoice, reminders, sent documents |
| [6. Logs](#6-questions-and-the-run-log) | Questions to people and the run log |

## Schema versions

Every versioned file carries `schema`. The versions and their forward-only migration steps live in
one place, `src/workspace/schema.ts`.

| File | Version now | Migration ladder |
|---|---|---|
| The books (`ledger.json` with `transactional-data/<year>/books/*.jsonl`) | `BOOKS_SCHEMA = 3` (2: books split by fiscal year, ADR 0013; 3: money accounts as equals, #88, no record changes) | `BOOKS_MIGRATIONS` |
| `belege.workspace.yaml` | `WORKSPACE_SCHEMA = 2` (2: each money account names its `role`, #88) | `MANIFEST_MIGRATIONS` (on the YAML document, comments survive) |
| `invoices.json` | `INVOICES_SCHEMA = 1` | `INVOICES_MIGRATIONS` |
| `questions.jsonl` lines | `QUESTION_LINE_VERSION = 1` (`v` on each line) | none |

A file without `schema` is schema 1. A file newer than the app is refused (`SchemaTooNewError`).
`npm run update` writes migrated files back.

## 1. Workspace and settings

A workspace is the folder `vanilla-accounting/` in one company's repository (ADR 0013). `LAYOUT` in
`src/workspace/workspace.ts` is the one list of the names it may hold, each owned either by the app
(the app writes it) or by the company (a person adds it, the app reads it). The manifest
`belege.workspace.yaml` says who the company is, its VAT setup and the ledger account each money
account books on. `ledger.json` holds the books' schema and their config. The chart of accounts is
`master-data/accounts.json`. Everything dated lives under `transactional-data/<year>/`.

```mermaid
classDiagram
  direction LR
  class Workspace {
    <<vanilla-accounting/>>
    +company: Company
    +filingLength: quarter | half
    +bankAccounts: LedgerBankAccount[]
    +paths: WorkspacePaths
  }
  class Manifest {
    <<belege.workspace.yaml>>
    +schema: number = 2
    +company: Company
    +bankAccounts: LedgerBankAccount[1..*]
    +profile: WorkspaceProfile [0..1]
    +invoicing: InvoicingSettings [0..1]
    +outgoingMail: OutgoingMail [0..1]
  }
  class Company {
    +name: string
    +uid: Uid «CHE-###.###.###»
    +owner: string
    +business: string [0..1]
    +legalForm: LegalForm [0..1]
    +language: string [0..1]
    +address: Address [0..1]
    +vat: VatSetup
  }
  class VatSetup {
    <<union>>
    +registered: boolean
    +method: effective | net-rate
    +reporting: received
    +period: quarterly | half-yearly
    +rates: NetRate[1..2]
  }
  class NetRate {
    +rate: number
    +label: string [0..1]
    +activityId: string [0..1]
  }
  class LedgerBankAccount {
    +bank: string «label, key with currency»
    +currency: string
    +account: string «4-digit»
    +label: string
    +statements: StatementKind [0..1]
    +iban: Iban [0..1]
    +role: bank | cash | owner | employee | card | clearing
  }
  class WorkspaceProfile {
    +preset: Preset
    +sells: SalesKind[]
    +exportTo: string [0..1]
  }
  class InvoicingSettings {
    +payTo: map currency to account, iban, qrIban
    +revenueAccount: string
    +feeAccount: string [0..1]
    +paymentTermsDays: number
    +layout: InvoiceLayout
    +texts: map language to texts
  }
  class OutgoingMail {
    +host: string
    +port: number
    +security: tls | starttls
    +fromAddress: string
  }
  class Ledger {
    <<ledger.json>>
    +schema: number = 3
    +config: AccountingConfig
  }
  class AccountingConfig {
    +closedThrough: date [0..1]
    +approvedReturn: ApprovedReturn [0..1]
    +openingBalances: year to account to CHF
    +openingBalancesNative: year to account to amount, currency
    +vatAdjustments: VatAdjustment[]
    +correctionCases: CorrectionCase[]
  }
  class WorkspaceAccount {
    <<master-data/accounts.json>>
    +number: string «4-digit»
    +name: string
    +type: AccountType
    +line: string «chart line key»
  }
  class FiscalYear {
    <<transactional-data/YYYY/>>
    books/*.jsonl
    receipts/
    bank-statements/BANK/
    filings/
    invoices/
    expected/
    runs.jsonl
    questions.jsonl
  }
  class SourceDecl {
    <<sources/ID/source.yaml>>
    +label: string
    +code: app:ID | ./file.ts
    +settings: map
    +reach: mail | api | web | mac-mail
    +feeds: map feed to output, every
  }
  class InvoiceBook {
    <<invoices.json>>
    +schema: number = 1
  }
  class KnowledgeFolder {
    <<knowledge/>>
    suppliers/ customers/ authorities/
    rules/PROCESS.guide.yaml
    company/TOPIC.md
  }

  Workspace *-- Manifest
  Workspace *-- Ledger
  Workspace *-- "*" WorkspaceAccount : chart
  Workspace *-- "*" FiscalYear
  Workspace *-- "*" SourceDecl
  Workspace *-- "0..1" InvoiceBook
  Workspace *-- KnowledgeFolder
  Manifest *-- Company
  Manifest *-- "1..*" LedgerBankAccount
  Manifest *-- "0..1" WorkspaceProfile
  Manifest *-- "0..1" InvoicingSettings
  Manifest *-- "0..1" OutgoingMail
  Company *-- VatSetup
  VatSetup *-- "0..2" NetRate
  Ledger *-- AccountingConfig
  LedgerBankAccount ..> WorkspaceAccount : account
  InvoicingSettings ..> LedgerBankAccount : payTo.account
  InvoicingSettings ..> WorkspaceAccount : revenueAccount
```

Notes on the diagram:

- `VatSetup` is one of three shapes (src/workspace/vat-setup.ts): `{ registered: false }`, the
  effective method, or the net tax rate method with one or two `NetRate`s. A manifest without
  `registered` and `period` means effective and quarterly.
- A money account is found by `bank` and `currency` together, or by `iban` and `currency` when a
  statement names an IBAN. The manifest refuses the same key twice. Every money account names its
  `role` (#88). At most one is the owner's, and the label `manual` must be the owner's account, for
  payments made privately. `statements` is the reader for a statement when one is imported, not a
  mode: any account takes movements by hand and statements alike. The Bilanz places a money account
  by its chart account, never by its role, so the owner's account and a card account stay
  liabilities.
- `AccountType` is `asset`, `liability`, `equity`, `revenue`, `expense` or `closing`
  (src/workspace/chart.ts). `line` names the line of the Bilanz or Erfolgsrechnung the account is
  shown on.
- No password lives in the workspace. Mail and source secrets go to the keychain or `.env`.
- Top-level names not drawn: `mail.yaml`, `secret-terms.txt`, `modules/`, `workflows/`,
  `beleg-import/` (the inbox), `history/`, `collected/`, `onboarding.json`, `logos/`, `data/`
  (generated copies, not in git), `VERSION`.

## 2. The books: movements, receipts, links, entries

The books are `ledger.json` plus, per fiscal year, six JSON Lines files in
`transactional-data/<year>/books/` (`BOOK_FILES` in src/books/years.ts), one record per line, sorted
by id. `loadBooks` and `saveBooks` in src/books/store.ts are the only door. In memory they form one
`Index`.

A bank movement (`BankTransaction`) moved on one money account. A receipt is linked to a movement
by a `Mapping`. A journal entry books a movement through `transactionRef`. A receipt's VAT facts are
read off the document, and the classifier decides the entry's VAT code from them.

```mermaid
classDiagram
  direction LR
  class BankStatement {
    <<books/statements.jsonl>>
    +bank: string
    +filename: string
    +fromDate: date
    +toDate: date
    +currency: string [0..1]
    +refs: string[0..*]
  }
  class BankTransaction {
    <<books/transactions.jsonl>>
    +ref: string «id»
    +bank: string «money account label, or manual»
    +date: date
    +amount: number
    +currency: string
    +direction: CRDT | DBIT
    +description: string
    +source: manual [0..1]
    +statement: string [0..1] «ref of the statement row that confirmed a hand movement»
    +reference: string [0..1]
    +counterparty: string [0..1]
    +counterpartyIban: string [0..1]
    +bankTxId: string [0..1]
    +type: wise-fee [0..1]
    +noReceiptNeeded: boolean [0..1]
    +businessPart: what, rate [0..1]
    +replaced: JournalEntry[0..*]
    +waitsForPerson: since, why [0..1]
    +waitsForReceipt: since, unread, decided [0..1]
  }
  class BankTransactionPart {
    +amount: number
    +currency: string
    +counterparty: string
    +reference: string [0..1]
    +counterpartyIban: string [0..1]
  }
  class StatementClosingBalance {
    <<books/balances.jsonl>>
    +account: string
    +bank: string
    +currency: string
    +date: date
    +amount: number
    +source: pdf | camt
    +sourceFile: string
  }
  class Receipt {
    <<books/receipts.jsonl + receipts/>>
    +id: string «checksum»
    +filename: string
    +extractedText: string
    +location: staged | archived
    +kind: ReceiptKind [0..1]
    +date: date [0..1]
    +amount: number [0..1]
    +currency: string [0..1]
    +vatId: string [0..1]
    +hasSwissVat: boolean [0..1]
    +vatBy: human [0..1]
    +kindBy: rule | human [0..1]
    +title: vendor, what [0..1]
    +distinctFrom: string[0..*]
    +filedPayment: string [0..1]
  }
  class VatRateGroup {
    +ratePercent: number
    +net: number [0..1]
    +vat: number
    +gross: number [0..1]
  }
  class ReceiptLine {
    +description: string
    +gross: number
    +ratePercent: number [0..1]
    +suggestedAccount: string [0..1]
  }
  class PayoutFacts {
    +sales: number
    +refunds: number
    +fees: number
    +paidOut: number
  }
  class OrderFacts {
    +number: string
    +date: date
    +currency: string
    +gross: number
    +shipTo: country
    +payouts: PayoutShare[]
    +refunds: PayoutShare[]
  }
  class Mapping {
    <<books/mappings.jsonl>>
    +transactionRef: string
    +receiptId: string
    +by: rule | llm | human [0..1]
    +rule: string [0..1]
    +run: string [0..1]
  }
  class JournalEntry {
    <<books/entries.jsonl>>
    +id: string
    +transactionRef: string
    +date: date
    +accountDebit: string
    +accountCredit: string
    +amount: number «CHF»
    +vatCode: string [0..1]
    +description: string [0..1]
    +exchangeCurrency: string [0..1]
    +exchangeRate: number [0..1]
    +corrects: filing key [0..1]
    +origin: classify | manual | year-close | invoice [0..1]
    +rule: string [0..1]
    +by: BookedBy [0..1]
    +receipts: string[0..*]
    +supply: goods | service | exempt [0..1]
    +supplierCountry: string [0..1]
    +run: string [0..1]
  }
  class BookedBy {
    <<union by kind>>
    rule: rule
    code: check
    model: model
    person: at, was
    assistant: at, conversation, was
  }
  class LedgerBankAccount {
    <<belege.workspace.yaml>>
    +bank: string
    +currency: string
    +account: string
  }
  class WorkspaceAccount {
    <<master-data/accounts.json>>
    +number: string
  }

  BankStatement ..> LedgerBankAccount : bank
  BankStatement ..> "*" BankTransaction : refs
  BankTransaction ..> "1" LedgerBankAccount : bank + currency
  BankTransaction *-- "0..*" BankTransactionPart : parts
  StatementClosingBalance ..> LedgerBankAccount : account
  Mapping ..> "1" BankTransaction : transactionRef
  Mapping ..> "1" Receipt : receiptId
  JournalEntry ..> "1" BankTransaction : transactionRef
  JournalEntry ..> "2" WorkspaceAccount : accountDebit, accountCredit
  JournalEntry ..> "*" Receipt : receipts
  JournalEntry *-- "0..1" BookedBy : by
  Receipt *-- "0..*" VatRateGroup : vatSummary
  Receipt *-- "0..*" ReceiptLine : lineItems
  Receipt *-- "0..1" PayoutFacts : payout
  Receipt *-- "0..1" OrderFacts : order
  Receipt ..> "0..1" BankTransaction : filedPayment
  Receipt ..> "*" Receipt : distinctFrom
  ReceiptLine ..> VatRateGroup : ratePercent
```

Notes on the diagram:

- Multiplicities between the main records: a movement has 0..* entries (a split booking writes
  several with the same `transactionRef`) and 0..* mappings. A receipt has 0..* mappings: a grouped
  charge (several invoices in one payment) links many receipts to one movement, and a receipt is
  normally linked to one movement.
- A booking without a payment (#89) carries a ref of its own in `transactionRef`, and its receipts
  in `receipts`. A `Mapping` may name that ref too: a receipt linked to a booking without a payment.
- A hand movement confirmed by a statement row (#88) keeps its own `ref`; `statement` holds the
  row's ref, and `BankStatement.refs` lists the row's ref, not the movement's.
- A Sammelzahlung stays one `BankTransaction`. Its `parts` are what receipts match against and what
  entries split by.
- `amount` of an entry is in CHF. A foreign movement carries `exchangeCurrency` and the ESTV daily
  sell rate of the payment date in `exchangeRate` (ADR 0001).
- `origin: manual` and `by.kind: person` mark a person's entry. Only a person may change or remove
  it (the write door `update` in src/books/store.ts).
- Each record lies in the year file of its date. Records dated on or before
  `config.closedThrough` are frozen and sealed (diagram 3).

## 3. VAT, filing and the locked past

The VAT engine reads codes and return forms from the jurisdiction module (`modules/ch/`), not from
the books. An entry's `vatCode` names a code of `tax-codes.yaml`. The return form maps codes to
boxes (Ziffern). The form is `return.yaml` (form 0550, effective method) or `return-net-rate.yaml`
(form 0553, net tax rate method), chosen by `company.vat`.

A filing period is a quarter (`2026-Q2`) or a half year (`2026-H1`). Approving a return holds the
books (`approvedReturn`). Filing it moves `closedThrough` and writes a seal. A filed period never
changes again (golden rule 1): a correction is a new entry in the open period with `corrects`, and
the 0535 Korrekturabrechnung recomputes the filed period from today's books.

```mermaid
classDiagram
  direction LR
  class TaxCode {
    <<modules/ch/tax-codes.yaml>>
    +code: string «V81, I81, M81-2, B81, F1…»
    +rate: number
    +revenue: Ziffer [0..1]
    +inputTax: Ziffer [0..1]
    +acquisition: Ziffer [0..1]
  }
  class ReturnForm {
    <<modules/ch/return.yaml | return-net-rate.yaml>>
    +turnoverBox: Ziffer
    +rateOrder: Ziffer[]
    +deductions: Ziffer to label, element
    +derived: formulas over Ziffern
  }
  class VatSetup {
    <<belege.workspace.yaml company.vat>>
  }
  class JournalEntry {
    <<books/entries.jsonl>>
    +id: string
    +date: date
    +vatCode: string [0..1]
    +corrects: filing key [0..1]
  }
  class AccountingConfig {
    <<ledger.json config>>
    +closedThrough: date [0..1]
  }
  class ApprovedReturn {
    +period: QuarterKey
    +through: date
    +filed: FiledFigures [0..1]
  }
  class FiledFigures {
    +figures: Ziffer to number
    +payable: number
  }
  class VatAdjustment {
    +id: string
    +period: QuarterKey «declaring return»
    +ziffer: string
    +amount: number
    +reason: string
    +entryIds: string[]
  }
  class CorrectionCase {
    +id: string
    +period: QuarterKey «corrected»
    +title: string
    +wrong: string
    +fix: string
    +originalEntryIds: string[]
    +correctionEntryIds: string[]
    +source: string [0..1]
  }
  class Seal {
    <<filings/seal-Qn.json | seal-Hn.json>>
    +quarter: QuarterKey
    +through: date
    +sha256: string
    +records: entries, transactions, mappings
    +sealedAt: date
    +rule: string
  }
  class FiledReturn {
    <<filings/mwst-ech0217-YYYY-Qn.xml>>
    eCH-0217 v2.0.0, as filed
  }
  class YearCloseRecord {
    <<filings/year-close.json>>
    guided entries done or not needed
  }
  class GoldenMaster {
    <<expected/>>
    books.json «frozen entries and config»
    transaction-refs.json
    NAME.json «expected figures»
  }

  JournalEntry ..> "0..1" TaxCode : vatCode
  VatSetup ..> ReturnForm : method selects
  TaxCode ..> ReturnForm : feeds Ziffern
  AccountingConfig *-- "0..1" ApprovedReturn
  ApprovedReturn *-- "0..1" FiledFigures
  AccountingConfig *-- "0..*" VatAdjustment : vatAdjustments
  AccountingConfig *-- "0..*" CorrectionCase : correctionCases
  VatAdjustment ..> "1..*" JournalEntry : entryIds
  CorrectionCase ..> "0..*" JournalEntry : originalEntryIds
  CorrectionCase ..> "0..*" JournalEntry : correctionEntryIds
  JournalEntry ..> "0..1" FiledReturn : corrects period
  Seal ..> "*" JournalEntry : hashes, dated on or before through
  Seal ..> AccountingConfig : closedThrough reaches through
  FiledReturn .. Seal : one per filed period
  GoldenMaster ..> JournalEntry : frozen copy
```

Notes on the diagram:

- A code carries a rate. The letter is the kind (V sale, I operating expense or investment, M
  material, B Bezugsteuer, F net tax rate). A leading `-` reverses it for a refund. The suffix `-1`
  means the amount is net, `-2` that it is the tax itself. See docs/vat-codes.md.
- A seal hashes the canonical JSON of every journal entry, bank transaction and receipt mapping dated
  on or before `through` (src/books/seal.ts). `loadBooks` checks every seal. Books whose sealed part
  changed load read-only.
- Every entry with `corrects` belongs to exactly one `CorrectionCase`.
- A `VatAdjustment` is only for a VAT event of the open period that refers to a filed entry. It is
  never dated into a filed period.
- Opening balances (`config.openingBalances`) enter no return and no seal.
- `expected/` holds the golden master that `npm run test:books` compares the books against. The
  demo workspaces keep theirs in `tests/golden/<demo>/`.

## 4. Knowledge and rules

Knowledge has two layers. The app layer ships `processes/` (flows, guides and one file per business
that holds for any company). The workspace layer is `knowledge/` in the company's workspace (its
accounts, rules and precedents per business, and its private businesses). A business's two files
are merged into one `Counterparty` (src/knowledge/counterparties.ts). The folder of the file is the
business's main role.

A business owns movements and receipts through its `match` signals, tried strongest first: `uid` (on
a linked receipt), `iban` (the other party on the statement), `domain` (the sender at collection),
`tx` (a part of the bank's counterparty name or of the merchant in the text), `file` (a pattern over
the archived filename). The first tier with exactly one hit decides.

A rule is executable when its `then` is a map (`BookingRule`, src/booking/rules.ts). It stands in
the step `classify` of `knowledge/rules/booking.guide.yaml`, or in a business's file under
`steps: booking.guide.yaml#classify`, where it needs no `when` of its own. A rule whose `when` and
`then` are sentences is a note for people and the AI, and nothing carries it out.

```mermaid
classDiagram
  direction LR
  class Counterparty {
    <<processes/ROLE/ID.yaml + knowledge/ROLE/ID.yaml>>
    +id: string
    +name: string
    +role: supplier | customer | authority
    +roles: Role[0..*]
    +grouped: boolean
    +accounts: string[0..*]
    +origin: vendor, binding
  }
  class Matchers {
    +uid: string[]
    +iban: string[]
    +domain: string[]
    +tx: string[]
    +file: RegExp[]
  }
  class DocumentType {
    +id: string
    +kind: ReceiptKind
    +text: RegExp[]
  }
  class Fact {
    +id: string
    +fact: string
    +source: string
  }
  class Guide {
    <<processes/P.guide.yaml + knowledge/rules/P.guide.yaml>>
    +process: string
    +steps: step id to Section
  }
  class Section {
    +goal: string [0..1]
    +gates: Rule[]
    +rules: Rule[]
    +precedents: list
    +ask_human_when: string[]
  }
  class Rule {
    <<as written>>
    +id: string
    +when: sentence | map
    +then: sentence | map
    +source: string «wish, correction, hand, notes + date»
    +apply: map [0..1]
    +note: string [0..1]
  }
  class BookingRule {
    <<parsed, executable>>
    +id: string
    +when: RuleWhen
    +then: RuleThen
    +off: boolean
    +source: string [0..1]
    +note: string [0..1]
  }
  class RuleWhen {
    +counterparty: business id [0..1]
    +payer: IBAN or name key [0..1]
    +text: regex [0..1]
    +direction: in | out [0..1]
    +amount: over, under [0..1]
    +account: money account [0..1]
  }
  class RuleThen {
    <<union>>
    book: booking
    ask: question, booking [0..1]
  }
  class RuleBooking {
    +account: string
    +vat: string | null
    +private: percent [0..1]
    +fees: account, vat [0..1]
  }
  class Note {
    <<knowledge/ROLE/ID.md | knowledge/company/SLUG.md>>
    +title: string [0..1]
    +steps: string[]
    +text: string
  }
  class BankTransaction {
    <<books>>
    +counterparty: string
    +counterpartyIban: string
    +description: string
  }
  class Receipt {
    <<books>>
    +vatId: string
    +filename: string
  }
  class JournalEntry {
    <<books>>
    +rule: string [0..1]
  }
  class WorkspaceAccount {
    <<master-data/accounts.json>>
  }

  Counterparty *-- Matchers : match
  Counterparty *-- "0..*" DocumentType : documents
  Counterparty *-- "0..*" Fact : facts
  Counterparty *-- "0..*" Section : steps
  Guide *-- "0..*" Section : steps
  Section *-- "0..*" Rule : gates, rules
  Rule ..> "0..1" BookingRule : parsed when then is a map
  BookingRule *-- RuleWhen
  BookingRule *-- RuleThen
  RuleThen *-- "0..1" RuleBooking
  RuleWhen ..> Counterparty : counterparty
  RuleBooking ..> WorkspaceAccount : account
  Matchers ..> "*" BankTransaction : iban, tx
  Matchers ..> "*" Receipt : uid, file
  JournalEntry ..> "0..1" BookingRule : rule
  Note ..> "0..1" Counterparty : partner notes
  BookingRule ..> "0..1" Note : note quotes a sentence
```

Notes on the diagram:

- A shipped business file (`processes/`) holds facts true for every company. It never assumes a VAT
  rate for a receipt that cannot be read. Accounts and company rules go into the workspace file.
- `RuleWhen` conditions must all hold. `private` and `fees` exclude each other, and `fees` goes with
  no `ask`.
- `Rule.apply` carries what code does for a business beyond booking (for example
  `apply: { receipt: none }` on `evidence.guide.yaml#rules`, src/booking/purchase-vat.ts).
- Firma › Regeln counts how often each rule booked from `JournalEntry.rule` and how often it asked
  from the questions (diagram 6).

## 5. Invoices

`invoices.json` holds the customers, the invoices and the documents sent (src/invoices/model.ts).
An issued invoice is frozen with copies of its customer, sender and layout, and its PDF lies in
`transactional-data/<year>/invoices/<number>.pdf`. A payment of an invoice is an allocation of a bank
movement. The paid revenue is booked as journal entries with `origin: invoice`.

```mermaid
classDiagram
  direction LR
  class InvoiceBook {
    <<invoices.json>>
    +schema: number = 1
  }
  class Envelope {
    <<abstract>>
    +id: string
    +createdAt: datetime
    +origin: manual | import
    +deleted: boolean
  }
  class Customer {
    +name: string
    +address: Address
    +language: de | fr | it | en
    +vatId: string [0..1]
    +email: string [0..1]
    +paymentTermsDays: number
  }
  class Invoice {
    <<Draft | Issued>>
    +kind: invoice | credit-note
    +customerId: string
    +date: date
    +currency: CHF | EUR
    +exemption: abroad | export [0..1]
    +creditFor: invoice id [0..1]
    +settlement: refund | offset [0..1]
    +status: draft | issued
  }
  class Issued {
    +number: string
    +issuedAt: datetime
    +dueDate: date
    +reference: string «QR reference»
    +customer: CustomerFields «copy»
    +sender: Sender «copy»
    +layout: InvoiceLayout «copy»
    +pdf: file, sha256
    +cancelled: date, reason [0..1]
  }
  class InvoiceLine {
    +text: string
    +quantity: number
    +unit: Unit [0..1]
    +price: number
    +vatRate: number
    +account: string [0..1]
  }
  class PaymentAllocation {
    +transactionRef: string
    +date: date
    +amount: number
    +fee: number [0..1]
    +by: reference | number | confirmed
  }
  class Reminder {
    +level: number
    +date: date
    +dueDate: date
    +fee: number [0..1]
    +documentId: string
  }
  class SentDocument {
    +invoiceId: string
    +kind: SentKind
    +title: string
    +file: string «invoices/sent/ID.pdf»
    +sentAt: datetime
    +to: string
    +channel: email | download [0..1]
  }
  class Comment {
    +author: string
    +text: string
  }
  class BankTransaction {
    <<books>>
    +ref: string
  }
  class JournalEntry {
    <<books>>
    +origin: invoice
  }

  Envelope <|-- Customer
  Envelope <|-- Invoice
  Envelope <|-- SentDocument
  Envelope <|-- Comment
  Invoice <|-- Issued
  InvoiceBook *-- "*" Customer
  InvoiceBook *-- "*" Invoice
  InvoiceBook *-- "*" SentDocument : sent
  Invoice ..> "1" Customer : customerId
  Invoice *-- "1..*" InvoiceLine : lines
  Invoice *-- "*" Comment : comments
  Invoice ..> "0..1" Invoice : creditFor
  Issued *-- "*" PaymentAllocation : payments
  Issued *-- "*" Reminder : reminders
  PaymentAllocation ..> "1" BankTransaction : transactionRef
  Reminder ..> SentDocument : documentId
  SentDocument ..> Invoice : invoiceId
  JournalEntry ..> BankTransaction : the paying movement
```

A firm that is not registered for VAT issues invoices without VAT: its only rate is 0.

## 6. Questions and the run log

Two append-only logs per fiscal year record what happened around the books. `questions.jsonl` holds
the questions between the people who keep the books, one event per line; a question's state is the
fold of its lines (src/questions/model.ts). `runs.jsonl` holds one line per workflow run that wrote,
waited for a person, got stuck or was discarded (src/workflows/runlog.ts). Entries, mappings and
receipts name their run in `run`.

```mermaid
classDiagram
  direction LR
  class QuestionLine {
    <<questions.jsonl>>
    +v: number = 1
    +id: string «question id»
    +at: datetime
    +by: string
    +event: asked | answered | undone | closed
  }
  class Asked {
    +on: QuestionTarget
    +text: string
    +choices: Choice[]
    +to: string [0..1]
    +origin: person | assistant | booking
    +topic: saleVat [0..1]
  }
  class Answered {
    +answer: choice | text
    +acted: Acted [0..1]
    +from: precedent [0..1]
  }
  class Closed {
    +how: done | withdrawn
    +why: SaleGone [0..1]
  }
  class QuestionTarget {
    +kind: payment | receipt | entry
    +id: string
  }
  class RunLogLine {
    <<runs.jsonl>>
    +run: string
    +workflow: string
    +version: string
    +item: kind, id
    +at: datetime
    +event: done | waiting | stuck | discarded
    +step: string [0..1]
    +reason: string [0..1]
    +wrote: entries, mappings, receipts [0..1]
    +host: local | cloud
  }
  class BankTransaction {
    <<books>>
  }
  class Receipt {
    <<books>>
  }
  class JournalEntry {
    <<books>>
    +run: string [0..1]
  }

  QuestionLine <|-- Asked
  QuestionLine <|-- Answered
  QuestionLine <|-- Closed
  Asked *-- QuestionTarget : on
  QuestionTarget ..> BankTransaction : payment
  QuestionTarget ..> Receipt : receipt
  QuestionTarget ..> JournalEntry : entry
  Answered ..> "*" JournalEntry : acted.booked
  RunLogLine ..> "*" JournalEntry : wrote.entries
  JournalEntry ..> "0..1" RunLogLine : run
```

## Sources in the code

| What | Where |
|---|---|
| Books records (`Index`, `JournalEntry`, `BankTransaction`, `Receipt`, `Mapping`, config) | src/types/index.ts |
| Books on disk, the write door, period lock | src/books/store.ts, src/books/years.ts |
| Seals | src/books/seal.ts |
| The referential integrity check: keys that name no record (`npm run doctor`) | src/accounting/integrity.ts |
| Workspace layout and paths | src/workspace/workspace.ts (`LAYOUT`) |
| Manifest | src/workspace/manifest.ts, src/workspace/vat-setup.ts |
| Schema versions | src/workspace/schema.ts |
| Chart of accounts | src/workspace/chart.ts |
| Business files, matchers, guides, notes | src/knowledge/counterparties.ts, src/knowledge/layers.ts, src/knowledge/notes.ts |
| Booking rules | src/booking/rules.ts |
| Invoices | src/invoices/model.ts |
| Questions, run log | src/questions/model.ts, src/workflows/runlog.ts |
| Sources | src/platform/sources/load.ts |
| Tax codes and return forms | modules/ch/tax-codes.yaml, modules/ch/return.yaml, modules/ch/return-net-rate.yaml |
