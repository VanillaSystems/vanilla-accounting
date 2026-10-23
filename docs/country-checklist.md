# Country checklist

The questions a jurisdiction module must answer before the app can keep books for a country.
Switzerland's answers are in [modules/ch/decisions.yaml](../modules/ch/decisions.yaml). A new
module (`modules/<id>/`) answers every question below in its own `decisions.yaml`, under the same
ids, before its first workspace opens. `tests/country-checklist.test.ts` fails when a module skips
a question, answers one this list does not ask, or points to a file that does not exist.

How to use it with an AI: hand it this file and the Swiss answers, and ask it to answer each
question for the new country with the law that settles it. An answer the AI cannot source stays
marked `unverified` until a person who knows that law confirms it.

## The rule for every answer

**Build exactly the legal minimum. Be stricter only where that country's law requires it, and
name the law.** A rule the law does not ask for costs the person time and buys nothing: it is a
defect, not caution. Where Switzerland needs little (a filed VAT quarter is final, a change to
the books must be detectable), the app does that much. Where another country needs more (a
German entry fixed when it is recorded, a French or Portuguese hash chain), that module asks for
more and cites the paragraph.

Each question names three things:

- **Why** it matters: what goes wrong in the books or on a form when the answer is wrong.
- **Slot**: where a module holds the answer today (file and key), or that it has none yet. «No
  slot» means the answer is written into app code, usually as a Swiss assumption; a second
  country turns it into module data first (docs/0.4.0/modules.md, the data/code rule).
- **Minimum**: what the law asks at least, and what the app must not add on top of it.

## The answer file

```yaml
# modules/<id>/decisions.yaml
schema: 1
module: <id>
answers:
  vat.rates:                       # one key per question id, in the order of this file
    answer: >                      # the country's answer, in plain words
      ...
    law: [MWSTG Art. 25]           # the laws or authority publications that settle it
    where: [modules/ch/rates.yaml] # files that implement it; a #key may follow the path
    unverified: >                  # only when part of the answer is not sure: what to confirm
      ...
    verified: >                    # once checked against the primary sources: the date and the sources
      ...
```

`where` names repository paths. An answer with no implementation names the file that would
change, or the issue that tracks it, in `answer`.

## VAT

### `vat.registration` From which turnover must a firm register, and may it register earlier?

- **Why:** a firm below the threshold files no return and books gross; above it, every sale
  carries tax. The app shows an unregistered firm its turnover against the threshold.
- **Slot:** `registration.yaml#turnoverThreshold`, in the base currency. How the turnover is
  counted (calendar year, rolling twelve months, worldwide or domestic) has no slot.
- **Minimum:** watch the threshold the law names over the period the law names. Do not ask an
  unregistered firm for anything only registered firms need.

### `vat.rates` Which rates apply, and since when?

- **Why:** every taxed sale and every input-tax deduction is a rate times an amount.
- **Slot:** `rates.yaml#rows` (rate, kind, code, name, `superseded`), `invoicing.yaml#rates`.
  No slot for the date a rate starts or ends.
- **Minimum:** the rates in force on each tax point, and the superseded ones for as long as old
  periods can still be corrected.

### `vat.codes` How does a booking say which tax it carries?

- **Why:** the code is the bridge from an entry to the return's boxes. A sale, a purchase, a
  refund and an acquisition tax must be told apart without reading the description.
- **Slot:** `tax-codes.yaml` (codes, `negativePrefix`, `amountSuffix`, `patterns`).
- **Minimum:** one code per distinct box combination the return needs. Codes are a convention,
  not law: reuse the local accounting software's names where people already know them.

### `vat.input-tax` What input tax may a firm deduct, and where does it go on the return?

- **Why:** a deduction on the wrong box or without a right to it changes the tax owed.
- **Slot:** `tax-codes.yaml#purchaseBoxes`, `#codes` (`inputTax`), `#patterns` (corrections and
  reductions of input tax).
- **Minimum:** the boxes the form has and the exclusions the law names. Mixed use and subsidies
  only where the form asks for them.

### `vat.own-use` How is private or non-business use of business assets taxed?

- **Why:** an owner's private share of a car or a phone reduces the input tax or is taxed as
  own consumption; leaving it out understates the tax.
- **Slot:** `year-end.yaml#templates` (a template with a correction code). The private share
  of a payment is a rule (`private:`), not module data.
- **Minimum:** the correction the law asks for, at the time the law asks for it (per payment,
  per period or once a year). Do not force a per-payment split where a yearly flat rate is
  allowed.

### `vat.return-form` Which form is filed, with which boxes and sums?

- **Why:** the return is the figure the authority checks. Every box, sign and formula must match
  the official form.
- **Slot:** `return.yaml` (turnover box, rate rows in `rateOrder`, `deductions`, `inputTax`,
  `derived` formulas, `payable`, `credit`). The loader checks every reference
  (src/core/modules/check.ts).
- **Minimum:** the boxes of the official form, in its order, with its labels. Keep the official
  form's PDF under docs/specs/ as the source.

### `vat.periods` How long is a tax period, and when is the return due?

- **Why:** the period is what gets filed and then locked. The due date drives the reminders for
  missing receipts.
- **Slot:** `periods.yaml#vat` (`length`: month, quarter, half or year; `dueDays`). The periods
  a firm may choose are a fixed list in src/workspace/vat-setup.ts (`VAT_PERIODS`): no slot.
- **Minimum:** the periods the law offers to the firm's kind, the due date the law names.

### `vat.basis` Is tax owed when the invoice is issued or when it is paid?

- **Why:** on the cash basis the payment date is the tax point; on the accrual basis it is the
  invoice date. Every return and every foreign-currency rate depends on it.
- **Slot:** `company.vat.reporting` (`received` or `agreed`, src/workspace/vat-setup.ts), read
  through `agreedBasis()` and `filingBasis()` (src/engines/index.ts); the open-item accounts are the
  year-end module's `receivables` and `payables` roles.
- **Minimum:** the basis the law makes the default, and the other one if the law lets a firm
  choose it.

### `vat.filing` In which format and through which channel is the return filed?

- **Why:** a return the authority's portal cannot import has to be typed in by hand.
- **Slot:** a provider (src/providers/). module.yaml has no `providers` key yet; the CLI calls
  the provider directly.
- **Minimum:** the format the authority accepts. Where filing on paper or by typing is still
  allowed, a printable summary is enough until the import exists.

### `vat.reverse-charge` Who owes the tax on services bought from abroad?

- **Why:** a foreign supplier charges no local tax, so the buyer declares it (acquisition tax,
  reverse charge). Missing it is a common audit finding.
- **Slot:** `rates.yaml#rows` with `kind: acquisition`, the codes that name `acquisition` in
  `tax-codes.yaml`. When a payment is a foreign service is decided in
  src/accounting/acquisition-tax.ts and processes/booking.guide.yaml#purchase_vat.
- **Minimum:** the threshold and the exemptions the law names. Not on goods (import VAT) and
  not on services the law exempts.

### `vat.import` How is import VAT on goods charged and proven?

- **Why:** import VAT is paid to the customs authority, often through a courier. Only the
  customs document proves it for the deduction.
- **Slot:** none in the module. The rule lives in processes/booking.guide.yaml#purchase_vat and
  processes/authorities/; the accounts in `setup.yaml#answers.imports`.
- **Minimum:** the proof the law accepts for the deduction, the account it is booked on.

### `vat.exempt` Which sales carry no tax, and how is each declared?

- **Why:** an export, a service supplied abroad and an exempt service each go to a different
  box. The words on the invoice decide which.
- **Slot:** `invoicing.yaml` (`exemptions`, `territory`, `placeAbroad`), the zero-rate codes
  in `tax-codes.yaml` (`deduction`).
- **Minimum:** the boxes the form has, the country codes of the VAT territory, the wording the
  law asks on such an invoice.

### `vat.simplified` Which simplified methods exist (net rate, flat rate, small business)?

- **Why:** a firm on a simplified method books sales gross and deducts no input tax. Its return
  is another form.
- **Slot:** `return-net-rate.yaml`, `tax-codes.yaml#netRateCodes`. The method names are a fixed
  list in src/workspace/vat-setup.ts (`VAT_METHODS`): a method that is not a net rate has no
  slot.
- **Minimum:** the methods the law offers, their limits and their form. A firm under a
  small-business exemption is a firm that is not registered (`registered: false`).

### `vat.corrections` How is a filed period corrected?

- **Why:** a filed return must not change. A mistake found later is declared in a correction
  return or in the next period, depending on the law.
- **Slot:** the `corrects` tag on an entry and `entriesForReturn` (src/accounting/declarations.ts)
  are generic. The correction form is named in app code (src/app/areas/vat/form0535.ts): no slot.
- **Minimum:** the correction route and the deadline the law names. Never regenerate a filed
  return.

### `vat.method-change` How long does a firm's VAT method or period hold?

- **Why:** a method changed in the middle of a period splits one return across two rule sets.
- **Slot:** none. The app holds the method for a whole calendar year (src/server/routes/config.ts,
  `vatMethodHeld`).
- **Minimum:** hold the method for the period the law names. Refuse only a change the law
  forbids. A waiting time measured in years is the authority's to enforce, not the app's.

## Bookkeeping law

### `books.duty` Who must keep double-entry books, and who may keep simpler records?

- **Why:** a small sole trader may only need a cash book. Asking such a firm for full statements
  would be a requirement the law does not set.
- **Slot:** none. The app always books double entry.
- **Minimum:** double entry costs the person nothing extra, so it may stay. Statements, notes and
  checks that only full books need must not be required of a firm the law exempts.

### `books.principles` Which general principles must the books follow?

- **Why:** completeness, truthfulness, traceability and «no entry without a receipt» are what
  an auditor tests first.
- **Slot:** none. The write door (src/books/store.ts) and the receipt rules are core.
- **Minimum:** the principles the law lists. Where the law allows an entry without an outside
  receipt (a self-made receipt), the app allows it too.

### `books.retention` How long must books, receipts and returns be kept, and how?

- **Why:** a workspace deleted too early loses the proof of every deduction.
- **Slot:** none. The export preset names ten years in a UI text.
- **Minimum:** the longest period any applicable law names, per kind of record (books, receipts,
  returns, records about real estate).

### `books.integrity` When does a record become unchangeable, and how is that proven?

- **Why:** this decides the seal: what it covers, when it is written, how strict the lock is.
  Too loose fails an audit; too strict blocks corrections the law allows.
- **Slot:** none. Seals (src/books/seal.ts), `closedThrough` and the write door are core; what
  triggers a lock (a filed VAT period) and what a seal hashes are fixed in code.
- **Minimum:** name the trigger the law sets (a filed return, a closed year, the moment of
  recording), what must stay unchanged (entries, receipts, filed documents) and the proof it
  accepts (detectable change, a log of changes, a hash chain, certified software). Seal exactly
  that. Examples of countries that ask more than Switzerland, to verify per country: Germany
  (GoBD, § 146 Abs. 4 AO: an entry may not be changed so that its first content is lost; a
  posting is fixed, *festgeschrieben*); France and Portugal (hash-chained records in certified
  invoicing or cash software).

### `books.audit-trail` Must every change be logged, and with what detail?

- **Why:** some laws accept that the books are traceable as a whole; others ask for a log of
  every change to an entry, with who and when.
- **Slot:** none. Each record names who made it (src/books/booked-by.ts); runs write a log
  (src/workflows/runlog.ts); the workspace history is git.
- **Minimum:** the log the law asks for. Do not add a field-level change log where traceability
  of the whole is enough.

### `books.archive-format` In which form must the books be handed to an auditor?

- **Why:** some countries mandate a file (SAF-T, the French FEC, the German data access per
  GoBD). Without it an audit cannot start.
- **Slot:** none. The audit export (src/audit/, docs/audit-export.md) writes a generic bundle.
- **Minimum:** the mandated file format, if any; else readable books and their receipts.

### `books.chart` Is a chart of accounts prescribed or customary?

- **Why:** the chart decides each account's type, normal side and statement line. Accountants
  expect the local standard.
- **Slot:** `accounts.yaml` (the starting chart), `chart.yaml` (classes and types).
- **Minimum:** the prescribed chart where there is one (France's PCG); else the customary one.

### `books.statements` Which layout must the balance sheet and income statement follow?

- **Why:** the statements are filed with the tax return, sometimes published.
- **Slot:** `statements.yaml` (groups by account range), `accounts.yaml#lines` (the legal lines).
- **Minimum:** the minimum structure the law lists, by the method it allows (nature of expense
  or function). Notes only where the firm's size requires them.

### `books.fiscal-year` What may the fiscal year be?

- **Why:** periods, opening balances and the year close all hang on it.
- **Slot:** none. The app supports the calendar year only.
- **Minimum:** the lengths and start dates the law allows, including a first year that is
  shorter or longer.

### `books.year-end` Which steps does the year close need?

- **Why:** accruals, depreciation, provisions, foreign-currency revaluation and the result's
  allocation change the year's figures.
- **Slot:** `year-end.yaml` (account roles, prefilled templates, `byLegalForm`).
- **Minimum:** the entries the law requires; the others offered as templates, never forced.

### `books.opening` How are opening balances entered, and until when may they change?

- **Why:** a firm that switches from another program starts with balances that belong to no
  filed period.
- **Slot:** none. src/accounting/opening-balance.ts takes them until the first year is closed.
- **Minimum:** as long as the law lets the first year's books change.

### `books.annual-filing` What happens to the annual accounts after the close?

- **Why:** approval by the owners, filing with the tax return, publication in a register, an
  audit: each has its own deadline and form.
- **Slot:** none. Not built.
- **Minimum:** the filings the firm's legal form and size require.

### `books.numbering` Must entries or invoices be numbered without gaps?

- **Why:** some countries reject an invoice series with a gap or require numbering per series
  and year.
- **Slot:** none. Invoice numbers are assigned in src/invoices/rules.ts.
- **Minimum:** the numbering the law names. No gapless rule where the law has none.

## Currency and rounding

### `fx.base-currency` In which currency must the books be kept?

- **Why:** every amount is booked and every statement shown in it.
- **Slot:** `module.yaml#baseCurrency`; a workspace overlay may set its own
  (src/core/modules/load.ts).
- **Minimum:** the currency the law names, and the other currencies it allows with their
  conditions.

### `fx.rate-rule` Which exchange rate, of which date, from which source?

- **Why:** a foreign-currency payment is booked and taxed at one rate. The wrong source or date
  changes the return.
- **Slot:** none. src/accounting/fx-rates.ts reads the Swiss authority's daily rates from
  reference/; docs/0.4.0/modules.md plans an `fx.yaml` and a rate provider.
- **Minimum:** the rate source and date the tax law names, with its rule for weekends and
  holidays.

### `fx.revaluation` Are foreign-currency balances revalued at year end?

- **Why:** a bank account in another currency is worth something else on the closing date.
- **Slot:** `year-end.yaml#accounts.fxDifference`.
- **Minimum:** the valuation rule of the law (closing rate, lower of cost or market).

### `fx.rounding` What is the smallest unit, and how is it rounded?

- **Why:** a rounding rule that differs between an entry and its storno leaves a remainder; a
  return rounded per entry can differ from one rounded per rate.
- **Slot:** none. src/accounting/rappen.ts rounds to two decimals, half away from zero.
- **Minimum:** the minor unit, the rounding the authority applies on the return, and any cash
  rounding the law sets.

## Documents

### `docs.invoice-fields` What must an invoice state?

- **Why:** an invoice that lacks a mandatory field costs the customer the deduction.
- **Slot:** none. The fields are checked in src/invoices/rules.ts (`missingForIssue`).
- **Minimum:** the fields the law lists, and the simplified invoice it allows under an amount.

### `docs.e-invoicing` Is a structured e-invoice or a payment slip required?

- **Why:** some countries require e-invoices in B2B trade (Italy's SDI, Germany and France in
  stages); a payment slip standard decides how customers pay.
- **Slot:** a provider (src/providers/). No `providers` key in module.yaml yet.
- **Minimum:** the formats the law requires by date and by kind of customer.

### `docs.input-tax-proof` Which document proves an input-tax deduction?

- **Why:** the app books a rate only when a receipt shows the tax. The law decides what counts
  as that proof.
- **Slot:** none in the module. The rules live in processes/evidence.guide.yaml,
  processes/booking.guide.yaml#purchase_vat, src/booking/receipt-wait.ts and
  src/accounting/receipt-due.ts.
- **Minimum:** the proof the law accepts. Where the law weighs evidence freely, the receipt rule
  is a safe default, and a person can still book with another proof by hand.

### `docs.self-made` When may a firm write its own receipt?

- **Why:** a parking meter or a tip leaves no receipt. A self-made receipt is the way out.
- **Slot:** none. Not built (issue #8).
- **Minimum:** allow it where the law allows it, with the fields the law asks; no input tax on
  it unless the law grants it.

### `docs.scans` May a scan or a photo replace the paper original?

- **Why:** the app compresses own scans and keeps received files as they are (ADR 0008). The
  law decides whether the original may be thrown away.
- **Slot:** none. The rule is in src/intake/ and docs/adr/0008-ingestion-one-inbox.md.
- **Minimum:** the conditions the law sets for a digital copy to replace the original.

### `docs.document-words` Which words name a receipt, a reminder or a statement?

- **Why:** intake tells a receipt from a newsletter by its words, in the country's languages.
- **Slot:** `documents.yaml`.
- **Minimum:** the words of the official and common business languages.

### `docs.company-id` What does a business or VAT number look like, and where must it appear?

- **Why:** the number is checked on setup, printed on invoices and read from receipts to tell a
  domestic supplier from a foreign one.
- **Slot:** none. The format and check digit are in src/workspace/uid.ts.
- **Minimum:** the format and check digit the register publishes, the documents the law requires
  it on.

## Legal forms and the owner

### `entity.legal-forms` Which legal forms does the module offer?

- **Why:** the legal form decides the equity accounts, the owner's account, the year close and
  the profit allocation.
- **Slot:** `year-end.yaml#byLegalForm`, `accounts.yaml` (`legalForms`, `names`). The list of
  forms is fixed in src/workspace/setup.ts (`LEGAL_FORMS`): no slot.
- **Minimum:** the forms of the target group: a sole trader and the common limited company.

### `entity.owner-private` How are the owner's private payments booked?

- **Why:** a sole trader's private withdrawals and a shareholder's current account are booked
  differently and appear on different statement lines.
- **Slot:** `setup.yaml#owner`.
- **Minimum:** the accounts the customary chart uses. Private shares carry no VAT.

### `entity.profit-allocation` How is a company's profit allocated?

- **Why:** legal reserves and a withholding tax on dividends are booked after the owners decide.
- **Slot:** `year-end.yaml#byLegalForm.*.allocation` (reserve, dividend, withholding tax and its
  rate).
- **Minimum:** the reserves the law requires, the withholding tax the law sets. Offered as a
  guided entry, never automatic.

### `entity.payroll` Which social insurances and wage taxes does a payroll book?

- **Why:** wages carry employer and employee contributions, each on its own account and its own
  filing.
- **Slot:** none. `year-end.yaml#templates` has one template; payroll is not built
  (docs/adr/0011-payroll.md).
- **Minimum:** the contributions the law requires, once payroll is built.

## Language and formats

### `locale.languages` In which languages are the books, the app and the documents?

- **Why:** the law may name the languages books may be kept in; customers expect invoices in
  theirs.
- **Slot:** none in the module. The UI languages are src/app/i18n/locales/; invoice texts are in
  src/invoices/texts.ts. docs/0.4.0/modules.md plans `texts/` in the module.
- **Minimum:** the languages the law allows for the books, and the official languages for the UI
  and the documents.

### `locale.formats` How are dates, numbers and amounts written?

- **Why:** a person reads the thousands separator and the decimal mark by habit; a wrong format is misread.
- **Slot:** none. src/app/lib/utils.ts formats with one fixed locale.
- **Minimum:** the country's customary formats; no law usually applies.

## Interfaces

### `data.bank-formats` In which format do the country's banks deliver statements?

- **Why:** the bank import is the first step of every quarter.
- **Slot:** providers (src/providers/camt053/, src/providers/wise-pdf/), chosen by file.
- **Minimum:** the standard format of the country's banks; others as workspace sources
  (ADR 0014, ADR 0015).

### `data.authority-feeds` Which data does the app fetch from authorities?

- **Why:** exchange rates and the business register are fetched, not typed.
- **Slot:** none. src/cli/fetch-estv-rates.ts fetches the Swiss rates; the register lookup is a
  link in src/workspace/uid.ts.
- **Minimum:** the feeds the other answers depend on (`fx.rate-rule`, `docs.company-id`).
