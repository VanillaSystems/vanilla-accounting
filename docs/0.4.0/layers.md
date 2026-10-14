# Layers

**Status: proposed.**

## The six parts

```
 ┌──────────────────────────────┐  ┌──────────────────────────────┐
 │ views                        │  │ workflows                    │
 │ areas, lists, details, forms │  │ workflow.yaml + step.yaml    │
 │ read: queries                │  │ triggers, steps, runs        │
 │ write: direct edit           │  │ call actions                 │
 └──────────────┬───────────────┘  └──────────────┬───────────────┘
                │ queries · commands               │ actions
 ┌──────────────┴──────────────────────────────────┴───────────────┐
 │ modules     domain rules as DATA, optional CODE                 │ replaceable,
 │             jurisdiction (ch), integrations, layouts            │ overlayable
 ├─────────────────────────────────────────────────────────────────┤
 │ providers   code a module names by id: bytes in or out          │ replaceable
 │             eCH-0217 XML, QR-bill, camt.053, ESTV rates         │
 ├─────────────────────────────────────────────────────────────────┤
 │ engines     generic interpreters of module data                 │ upstream only
 │             tax codes, return, statements, year-end, invoices   │
 ├─────────────────────────────────────────────────────────────────┤
 │ core        records, periods + seals, money, ownership,         │ never replaced
 │             one write door, module loader, run store            │
 └─────────────────────────────────────────────────────────────────┘
```

| Part | Owns | Never does |
|---|---|---|
| **Core** | The books (entries, transactions, mappings, receipts), periods, `closedThrough`, seals, money arithmetic (Rappen), the actor/ownership table, `update(actor, fn)`, the module loader, the run store | name a country, a currency, a vendor or an account number |
| **Engines** | Pure functions over module data: decode a tax code, compute a return from a form definition, build statements from chart metadata, close a year from a template | write, fetch, or know which jurisdiction they serve |
| **Modules** | Data files (YAML) and, where needed, code. One jurisdiction module per workspace; any number of integration modules | import another module, or write except through the core |
| **Providers** | Code a module names by id: file formats, network fetches, parsers of other systems' documents | run in the browser |
| **Views** | The UI areas. They read through queries, make direct edits through the write door, and show the buttons that workflows declare | contain a process or a business rule |
| **Workflows** | Declared processes. Triggers, steps, outcomes, effects, waits, approvals | hold financial truth: the ledger checks every booking a workflow makes |

The research defines these terms in `architecture/customization.md` (core, engines, modules,
providers) and `architecture/workflows/index.md` (process, workflow, step, action, run, event).
This page adds views as a sixth part, because this app's UI is large and must stay out of the
modules' way.

## "Core" means one thing here

Review finding C1 notes that "core" means both platform foundations and the ledger core. For
0.4.0 it means the ledger core: the invariants listed in the table above. There is no separate
platform layer in this release. Identity, deployment and multi-tenant hosting are out of scope
(see [decisions.md](decisions.md)).

## Today's `src/` and where it goes

A first sort, to be checked file by file in migration step 1. "Split" means the folder holds
both generic logic and Swiss data or code.

| Today | Files | Target | Notes |
|---|---|---|---|
| `src/books/` (store, seal, refs, year-close) | 6 | core | `store.ts` and `mutateJournal` become the write door |
| `src/accounting/periods.ts`, `rappen.ts`, `ledger.ts`, `validate.ts` | 4 | core | periods stop assuming quarters (VAT period length comes from the module) |
| `src/accounting/` (rest) | 19 | split | `vat-codes*`, `ziffern.ts`, `declarations.ts`, `return-figures.ts`, `filed-return.ts` → engine + `ch` data; `fx-rates.ts` → ESTV provider; statements → engine + chart data |
| `src/booking/`, `src/intake/` | 7 | split | classification is the first replaceable capability (`accounting.expenses.classification`) |
| `src/invoices/` | 12 | split | rules → engine + `ch/invoicing.yaml`; QR-bill → provider; sheet → module data |
| `src/parsers/` | 7 | providers | camt.053, Wise PDF, statement balances |
| `src/collect/` | 7 | module `mail-collection` + providers | IMAP is bytes in |
| `src/export/` | 5 | provider | the Banana export |
| `src/knowledge/` | 6 | core (layer merge) + engine (gates, gaps) | the two-layer merge is the overlay pattern, already built |
| `src/workspace/` | 17 | core | manifest, schema ladder, migrate; gains `modules.lock.json` |
| `src/server/` | 18 | views (API side) + core | every route already writes through `withBooks`/`assertOpen` |
| `src/app/` | 99 | views | areas register in `src/app/areas/index.ts` |
| `src/cli/` | 35 | command registry (ADR 0005) | each command becomes an action or a view-less command |
| `src/llm/`, `src/audit/`, `src/secrets/`, `src/publish/`, `src/desktop/`, `src/reconcile/` | 18 | infrastructure, unchanged | not part of the module system |

## How the parts depend on each other

Dependencies point one way, and a lint enforces the direction (migration step 2):

```
views ─┐
       ├─▶ modules ─▶ engines ─▶ core
workflows ┘     │
                └─▶ providers ─▶ core (types only)
```

- A jurisdiction module depends on nothing but the engines that interpret it.
- A feature module (invoicing, web shop) asks the jurisdiction by meaning: "the code for a
  domestic sale at 8.1 %", never `"V81"`.
- Only the core writes records. Views and workflows write through `update(actor, fn)`.
- The browser receives data only: `/books.json` and the resolved `/modules.json`. Module and
  provider code never reaches the browser.
