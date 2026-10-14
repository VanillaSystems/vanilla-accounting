# Migration

**Status: proposed order.** Each step ends in a state that a test proves, and none changes a
figure. A step starts only after the decisions it depends on ([decisions.md](decisions.md)) are
marked *decided*.

## Gate for every step

- `npm test` and `npm run test:books` green, with no golden-master update.
- `npm run check-public` at 0 findings, `npm run check-processes` green.
- The old code path is deleted in the same step that moves its callers. No compatibility layer
  survives a step.

## Steps

Done on branch `0.4.0`: 0, 1 ([inventory.md](inventory.md)), 2 (`tests/layers.test.ts`, 40 wrong-way
imports allowed in `tools/layers/allowed.txt`), 3 (without `modules.lock.json`), 4 (`modules/ch/chart.yaml`), 5 (`baseCurrency` in
`module.yaml`, not in `books.json`: no schema change, and a workspace overlay may name its own;
the year-end, setup, provider and parser sites follow in step 10), 6 (`modules/ch/periods.yaml`:
return length and due days; the seals, the filed-return archive and year-close still name
quarters, `QuarterKey`, and follow with step 10), 7.

| # | Step | Ends when | Needs |
|---|---|---|---|
| 0 | **Freeze figures.** Snapshot the golden masters and a 0.3.0 demo workspace as an upgrade fixture. | the fixture opens in a test | — |
| 1 | **Inventory.** Sort every file of `src/` into core, engine, module data, provider, view, infrastructure ([layers.md](layers.md)). List every Swiss specific with its file. | the list is checked in under `docs/0.4.0/inventory.md` | — |
| 2 | **Direction lint.** A test fails on an import that points the wrong way. Start with today's violations as an allow-list that may only shrink. | lint in `npm test` | 1 |
| 3 | **Module loader.** `module.yaml`, resolution, overlay merge, `modules.lock.json`, `/modules.json`. No module uses it yet except an empty `ch`. | loader tests, overlay fixture | D1, D2 |
| 4 | **Normal side from the chart.** Balances stop reading debit/credit from the account number's first digit. `chart.yaml` says it. | golden master unchanged | 3 |
| 5 | **Base currency from the workspace.** CHF stops being implicit; rates are stored against `config.baseCurrency`. | golden master unchanged | 3 |
| 6 | **Periods from the module.** VAT period length comes from `periods.yaml`; quarters are one value of it. | golden master unchanged | 3 |
| 7 | **First slice: tax codes and the return.** Generate `ch/tax-codes.yaml`, `rates.yaml` and `return.yaml` from today's constants; build the engines beside the old code; prove both give the same Ziffern on the frozen books; switch callers; delete the old code. | golden master unchanged, old files gone | 4–6 |
| 8 | **Write door with actors.** `update(actor, fn)` and the ownership table replace direct `mutateJournal` calls. | `period-lock.test.ts`, `books-store.test.ts` extended per actor | 3 |
| 9 | **Workflow runtime, pilot.** `workflows/booking/`: triggers, steps, outcomes, declared effects, runs, replay. The CLI `classify` becomes a manual trigger. | booking by run equals booking by `classify` on the demo | 8, D3, D4 |
| 10 | **Remaining jurisdiction data.** Chart, statements, year-end, invoicing, setup, texts move into `modules/ch/`; providers move into `src/providers/`. | golden master unchanged | 7 |
| 11 | **The swap test.** The `xx` fixture jurisdiction books its scenario set; the lint forbids Swiss specifics outside `src/providers/` and `modules/ch/`. | both in `npm test` | 10 |
| 12 | **Remaining workflows.** Port the other processes ([workflows.md](workflows.md)); `processes/*.flow.yaml` is deleted when its workflow runs. | per workflow, as step 9 | 9 |
| 13 | **Firma › Module and the upgrade cycle.** Notices, switch-on gate, update dialog. | upgrade fixture from step 0 climbs and classifies | 3, 10, D6 |

Steps 4, 5 and 6 come first because the research found the swap blocked by three assumptions in
the core, not by the tax code: the normal side from the account number, CHF as the implicit base
currency, and quarters as the only period.

## What is not in 0.4.0

- A second real jurisdiction (`de`, `at`). The `xx` fixture proves the swap; a real one follows
  with the inspiration work ([inspiration/](inspiration/README.md)).
- A module registry, remote module install, or multi-tenant hosting.
- Module code in the browser.
