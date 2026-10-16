# Modules

**Status: proposed.** The manifest syntax below is a first draft. Migration step 3 settles it
with the `ch` module as the only real user.

## The structure at a glance

Two repositories: the app (upstream, the same for every company) and the company's workspace.
The lock marks what nobody replaces; everything else can be overlaid, replaced or added.

```
vanilla-accounting/                     THE APP (upstream)
├── src/core/            🔒             records, periods + seals, money, ownership and the
│                                        write door, module loader, run store
├── src/engines/         upstream only  tax-codes · return · statements · year-end ·
│                                        invoice-rules · setup · text
├── src/providers/       replaceable    by id: ech-0217 · swiss-qr-bill · estv-daily-sell ·
│                        by id          uid-check · camt053 · wise-pdf · imap · banana-export
├── modules/
│   └── ch/              jurisdiction   tax-codes.yaml · rates.yaml · return.yaml · chart.yaml ·
│                        (one slot)     statements.yaml · periods.yaml · year-end.yaml ·
│                                        invoicing.yaml · setup.yaml · fx.yaml · texts/ ·
│                                        invoice/sheet.html · module.yaml
└── workflows/           overlayable    receipt-collection · receipt-intake · bank-import ·
                                         evidence · booking · new-case · vat-filing ·
                                         correction · year-close
                                         (each: workflow.yaml + one folder per step)

a-company-workspace/                    THE COMPANY (one per company)
├── belege.workspace.yaml               identity, banks, jurisdiction: ch
├── books/ receipts/ bank-statements/ filings/        the books
├── knowledge/                          suppliers, customers, authorities, rules per step
├── modules/
│   ├── ch/              overlay        only the files or keys it changes, e.g. invoice/sheet.html
│   └── webshop/         own module     a layout or capability upstream does not have
├── workflows/           overlay        e.g. a trigger switched on, a schedule moved
└── modules.lock.json                   written by the app: what each overlay is based on
```

## How granular a change can be

From the smallest change to the largest. Each level keeps everything below it following
upstream.

| Level | What the company changes | Example | Upstream changes to it |
|---|---|---|---|
| 1 · a key | one value in a module's data | the rate's label, a closing template line | flow in, unless the key was overlaid (then a notice) |
| 2 · a file | one file of a module | `invoice/sheet.html`, `texts/de.yaml` | the other files of the module flow in |
| 3 · a workflow setting | a trigger, a schedule, a step's guide rules | evidence: automatic on; collection at 07:00 | the workflow's steps and code flow in |
| 4 · an implementation | a provider or a capability by id | an own `accounting.expenses.classification`, an own bank parser | the parent module and its other providers flow in |
| 5 · a fork | a whole module under a new id | `ch-acme` | nothing flows; a three-way diff on request |
| 6 · a new module | a module upstream lacks | `webshop`, later `de` | checked against each release's contracts |
| — · the core | nothing | closed periods, seals, the write door | upstream contribution only |

## How many replacement points in 0.4.0

The 54 capability ids in [inspiration/capabilities.yaml](inspiration/capabilities.yaml)
(`accounting.ledger.journal`, `accounting.tax.vat-return`, …) are the vocabulary: they name what
an accounting program does, so programs can be compared and modules can say what they provide.
They are **not** 54 replacement points. 0.4.0 publishes a boundary only where real customization
is expected:

| Replacement point | Kind | Why it is replaceable |
|---|---|---|
| the jurisdiction (`ch`) | module, one slot | another country is another module; the swap is proven with the fictional `xx` |
| `accounting.expenses.classification` | capability | the first replacement experiment of the research: a company's own classifier |
| providers (file formats, rate download, filing XML) | by id | bytes in or out differ by bank, country and authority |
| document layouts | layout, one per document type | every company wants its own invoice |
| collection from outside | a source (ADR 0014), not a module | a web shop, a card issuer, a mail account: each a folder `sources/<id>/` |
| workflows | overlay | triggers, schedules, guide rules differ per company |

Everything else is ordinary code inside the core or an engine. It can become a replacement point
later, when a second implementation is real; a boundary nobody uses only costs.

## Names, and how the workspace swaps an implementation

The names follow the research proposal (`architecture/modules.md`): dotted, like Java packages,
without reversed domains.

| Name | Says | Example |
|---|---|---|
| **capability** | what the app needs, no publisher | `accounting.expenses.classification` |
| **implementation** | who provides it: publisher + capability | `vanilla.accounting.expenses.classification` (upstream), `acme.accounting.expenses.classification` (the company) |
| **module id** | a folder of data and code | `ch`, `webshop`; a fork gets a new id, `ch-acme` |

Callers ask for the capability, never for an implementation. **The workspace chooses**, in its
overlay of the module that declares the slot, with one key (decisions.md D2, leaning (b): one
mechanism, overlays; no second lock file):

```yaml
# a-company-workspace/modules/ch/module.yaml          (the overlay)
overlays: ch
basedOn: 2026.4.0
providers:
  accounting.expenses.classification: acme.accounting.expenses.classification

# a-company-workspace/modules/acme-classifier/module.yaml   (the implementation)
id: acme-classifier
kind: capability
provides: [acme.accounting.expenses.classification@1]   # implements accounting.expenses.classification, contract 1
```

At start the app resolves every capability to exactly one implementation, writes the result to
`modules.lock.json`, and refuses with a sentence when an implementation's contract version is
not supported. Without the overlay key, the upstream `vanilla.…` implementation runs. `vanilla`
and the company's slug are the only publishers in 0.4.0; publisher verification and a registry
are later questions (research, "Namespace convention").

## What a module is

A module is a folder with a `module.yaml` and data files. Code is optional. The app ships its
modules under `modules/`. A workspace adds or overlays modules under its own `modules/`.

```
modules/ch/                          shipped with the app
  module.yaml                        id, kind, version, schema, provides, requires
  tax-codes.yaml                     code grammar; each code → the return boxes it feeds
  rates.yaml                         8.1 / 2.6 / 3.8 with validity dates, and the superseded rates
  return.yaml                        the VAT return: boxes (Ziffern), sums as formulas, form 0535
  return-net-rate.yaml               the net tax rate method's return (form 0553): its codes, the firm's rate rows
  registration.yaml                  the turnover from which a firm must register
  chart.yaml                         KMU chart: account type, normal side, statement line, roles
  statements.yaml                    balance sheet and income statement sections
  periods.yaml                       VAT period (quarter), fiscal year
  year-end.yaml, invoicing.yaml, setup.yaml, fx.yaml
  texts/{de,fr,it,en}.yaml           every label the module adds
  invoice/sheet.html                 the A4 invoice template
  module.ts                          optional: names its providers
```

## Kinds and slots

| Kind | Slots per workspace | Examples |
|---|---|---|
| `jurisdiction` | exactly one | `ch`; later `de`, `at`; a fictional `xx` for the swap test |
| `layout` | one per document type | invoice sheet, reminder letter |
| `capability` | one implementation per capability | `accounting.expenses.classification` |

The workspace names its jurisdiction once, in `belege.workspace.yaml` (`jurisdiction: ch`).

## The manifest

```yaml
# modules/ch/module.yaml
id: ch
kind: jurisdiction
version: 2026.4.0          # the module's own version, CalVer for law-driven data
schema: 1                  # the format of the files below; climbs like books.json
provides:
  - accounting.tax.vat-codes@1
  - accounting.tax.vat-return@1
  - accounting.ledger.chart@1
requires:
  engines: { tax-codes: ^1, return: ^1, statements: ^1 }
providers:                 # code by id, implemented in module.ts or in src/providers
  vat-return.xml: ech-0217
  payment-slip: swiss-qr-bill
  fx.daily-rates: estv-daily-sell
```

A workspace overlay names what it overlays and the version it was written against:

```yaml
# <workspace>/modules/ch/module.yaml
overlays: ch
basedOn: 2026.4.0
```

## The data/code rule

> If it could be a wrong number on a form, it is data. If it is bytes in or out, it is code.

Tax codes, rates, return boxes and their formulas, the chart, statement sections, year-end
templates, invoice rules, setup questions and labels are data. The eCH-0217 XML, the QR-bill,
the UID check, the ESTV rate download, camt.053 and the Banana export are providers.

Data has one more property that code lacks: the risk of a change shows in its shape. A changed
label is presentation; a changed rate is figure-bearing; new code needs review. The upgrade cycle
and the change workflow both read this ([upgrades.md](upgrades.md)).

## Three ways to customize

| Way | The company writes | Upstream changes |
|---|---|---|
| **Overlay** (default) | only the keys or files it changes, under the shipped id | every key it did not touch flows in; a touched key that upstream changed raises a notice |
| **Fork** | a full copy under a new id, named in the workspace manifest | nothing flows; a three-way diff on request |
| **New module** | a module upstream lacks | its schema and contract are checked on every release |

`src/knowledge/layers.ts` already does this for knowledge: the app layer under `processes/`, the
company layer under `knowledge/`, merged by key, with one owner per field. Modules generalize
that merge to all domain data.

## Ports

Modules never import each other. The core loads them once per workspace and hands each one only
the ports it declares:

- `LedgerPort`: read entries, balances, periods.
- `LedgerWritePort`: `update(actor, fn)`. The actor is a person, a module id, or a workflow run.
  The ownership table decides what each actor may replace. A module cannot touch a closed period
  or overwrite a person's entry.
- `JurisdictionPort`: questions by meaning. "Which code for a domestic sale at 8.1 %?", "what
  does `-I81` mean?", "which boxes does this entry feed?". Callers never write a code string.
- `TextPort`: labels in the viewer's language.

## Checks before a module counts

1. **Check.** Every reference resolves, every formula names an existing box, every booked code
   parses, and every figure difference on past periods is explained by a correction case.
2. **Switch on.** A person approves new code, and data that changes figures. The approval card
   shows the effect on the open period. Presentation-only changes apply at once. Approvals live
   outside the workspace, so an LLM editing the workspace cannot approve its own change (see
   [decisions.md](decisions.md), D6).

## Proving the swap

A fictional jurisdiction `xx` lives in `tests/fixtures/modules/xx/`: another currency, monthly VAT
periods, a three-box return, a chart where the normal side does not follow the first digit. A
test books a scenario set against it. A lint fails when `src/` outside `src/providers/` names a
Swiss specific. Both run in `npm test`.
