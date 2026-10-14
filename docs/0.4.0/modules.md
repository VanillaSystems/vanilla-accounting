# Modules

**Status: proposed.** The manifest syntax below is a first draft. Migration step 3 settles it
with the `ch` module as the only real user.

## What a module is

A module is a folder with a `module.yaml` and data files. Code is optional. The app ships its
modules under `modules/`. A workspace adds or overlays modules under its own `modules/`.

```
modules/ch/                          shipped with the app
  module.yaml                        id, kind, version, schema, provides, requires
  tax-codes.yaml                     code grammar; each code → the return boxes it feeds
  rates.yaml                         8.1 / 2.6 / 3.8 with validity dates, and the superseded rates
  return.yaml                        the VAT return: boxes (Ziffern), sums as formulas, form 0535
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
| `integration` | many | web shop payouts, a card issuer, mail collection |
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
