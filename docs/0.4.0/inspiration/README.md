# Inspiration: other accounting programs

**Status: preparation.** Three other programs were studied in their own repos, side by side under `desaroxx/` (each folder name carries a date prefix). This folder fixes
the format those repos deliver in, so that a later session can compare them with this app
mechanically: one capability list, one scenario format, one evidence scale.

## The programs

| Repo | Program | Jurisdictions | How it was studied | State, 14 Oct 2026 |
|---|---|---|---|---|
| `banana-rea` | Banana Accounting 9.0.5 | CH (and others it ships) | native Rust clone, verified file by file against the original | clone done; domain docs in `CONTEXT.md`, `docs/accounting/` |
| `monkey-office` | MonKey Office 2026 (23.2.2) | DE, AT | manuals, decompiled binary, two VM runs with real bookings | learning notes done (`docs/learn/`), 152-event catalogue |
| `quickbooks-desktop` | QuickBooks 2024 for Mac | US | Core Data model, shipped rules files, decompiled code, help book | spec started: 2 of 15 domains in progress, 13 todo |

## What each repo delivers

At its root:

1. **`INSPIRATION.md`**, from [entry-template.md](entry-template.md): program, version,
   jurisdictions, method, reading order, maturity per area, and what must stay private.
2. **`features.yaml`**: one line per id of [capabilities.yaml](capabilities.yaml), with a status,
   an evidence level, and a link. Template below.
3. **`scenarios/<cc>.yaml`**: business events with their expected bookings and return effect, in
   the format of [`examples/scenarios/de.example.yaml`](../../../examples/scenarios/de.example.yaml). One file per jurisdiction.
4. **`jurisdictions/<cc>.md`**: rules true for the country (law, forms, deadlines), kept apart
   from how the program implements them. This is the same split as `processes/authorities/`
   (facts of the law) versus a program's own code.
5. **A glossary column** in its `CONTEXT.md`: the term in this app's vocabulary (`CONTEXT.md` of
   this repo, `processes/README.md`).

```yaml
# features.yaml
schema: 1
program: MonKey Office 2026 (23.2.2)
capabilities:
  accounting.tax.discount-vat:
    status: supported            # supported | partial | absent | unknown
    jurisdictions: [de, at]
    evidence: observed           # see below
    doc: docs/learn/08b-ustva-skonto.md
    notes: The discount is booked gross on a Minderungskonto, whose tax key splits off the VAT correction.
  accounting.payroll.runs:
    status: absent
```

## One evidence scale

The repos tag claims differently. Map them to this scale in `features.yaml` and scenarios:

| Level | Means | Banana | MonKey | QuickBooks |
|---|---|---|---|---|
| `verified` | a reimplementation reproduced the original's output | parity and acceptance tests | — | — |
| `observed` | seen in the running program, its data, or its code | — | OBSERVED | [schema], [data], [code] |
| `documented` | the vendor's manual or help says so | vendor docs mirror | manuals, online docs | [help] |
| `inferred` | reasoned from the above or from general practice | — | INFERRED | [inferred] |
| `unknown` | open | — | UNKNOWN | [unknown] |

## What may cross into this repo

This repo is public (`public-files.txt`, `npm run check-public`). From the inspiration repos,
only these cross:

- **Yes:** capability statuses, scenarios with invented amounts and standard charts, the facts
  of a law with its source (a statute, a tax-office form), and our own words describing how a
  program behaves.
- **No:** vendor text (manuals, help pages, the banana.ch mirror), screenshots, decompiled or
  cloned code, vendor data files (MonKey's `Fa.sdb`, QuickBooks' templates), the installer.

Ideas and behaviour cross. Expression does not.

## How the comparison will run

Not now: after step 11 of the [migration](../migration.md), when the `xx` jurisdiction proves
the swap. Then:

1. Merge every `features.yaml` with this app's own into a coverage matrix: capability × program,
   split by jurisdiction.
2. Replay every scenario through this app's engines. A `de` scenario needs a `de` module, so the
   first run is CH scenarios from Banana. Each mismatch is either a bug here, a gap in a module,
   or a jurisdiction difference to model.
3. For each `platform.*` capability, write how each program handles extensions and upgrades,
   next to [upgrades.md](../upgrades.md), and note what 0.4.0 does differently.
