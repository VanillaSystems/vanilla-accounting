# 0.4.0: the modular core

**Status: preparation.** This folder specifies the 0.4.0 release before any code moves. Nothing
here is built. Until a page says *decided*, it is a proposal. During preparation, `src/` does not
change for 0.4.0.

## What 0.4.0 is for

Today's app is one Swiss program. Swiss VAT codes, Swiss account numbers, CHF and VAT quarters
appear throughout: 115 of 264 source files name a Swiss specific. Processes live in
`processes/*.flow.yaml`, but the code does not execute them. The YAML describes the code, and
the two drift apart.

0.4.0 rebuilds the app around three ideas from the architecture research
(the `llm-open-architecture` repo of VanillaMachines):

1. **A small core that nobody replaces.** Records, periods and seals, money, ownership, and one
   write door. It never names a country, a vendor or a customer.
2. **Modules that a company can replace or overlay, and still upgrade.** A jurisdiction (`ch`,
   later `de`, `at`), an integration (a web shop, a bank) or a document layout is a module: data
   where possible, code only at the edges. A company changes the keys it needs, and every other
   key keeps following upstream.
3. **Views and workflows are separate.** Views show records and change them by direct edit.
   Workflows are declared in YAML (`workflow.yaml`, `step.yaml`) and run by the app, so the graph
   an employee sees is the program that runs.

The release is done when a fictional second jurisdiction runs on the same core, and the real
books' golden master is unchanged.

## Reading order

| Page | Question it answers |
|---|---|
| [layers.md](layers.md) | Which parts make up the app, and where does today's `src/` end up? |
| [modules.md](modules.md) | What is a module? How is it declared, overlaid, forked, and checked? |
| [workflows.md](workflows.md) | How do `workflow.yaml` and `step.yaml` replace `processes/*.flow.yaml`, and how do runs work? |
| [views.md](views.md) | How do the UI areas relate to modules and workflows? |
| [intake.md](intake.md) | What happens when files are dropped onto the app? |
| [saving.md](saving.md) | How does a regular user save, sync and undo, without git words? |
| [upgrades.md](upgrades.md) | What happens to a company's workspace when a new app version arrives? |
| [migration.md](migration.md) | In which order does the code move, and what proves each step? |
| [decisions.md](decisions.md) | What is still open, and what must be decided before step 1? |
| [inspiration/](inspiration/README.md) | How other accounting programs (Banana, MonKey Office, QuickBooks) feed the design |

## Rules that do not change

0.4.0 changes the structure, not the books. These rules hold across the whole migration:

- **A filed quarter is set in stone.** Seals, `closedThrough`, Korrekturabrechnung and
  `corrects:` work exactly as today (AGENTS.md, golden rule 1).
- **Every migration step ends green.** `npm test` (demo golden master) and `npm run test:books`
  (the real books) pass with no figure change. A step that changes a figure is a bug, unless the
  step says why and carries a **⚠ figures** changelog entry.
- **Workspaces keep opening.** A 0.3.x workspace opens in 0.4.0 through the schema ladder
  (`src/workspace/schema.ts`). Nothing is rewritten without `npm run update`.
- **The public repo stays clean.** `npm run check-public` stays at 0 findings. Inspiration
  material from vendor programs never enters this repo as text or code (see
  [inspiration/](inspiration/README.md)).

## Sources

- Architecture research: the `llm-open-architecture` repo (VanillaMachines), pages
  `architecture/{index,modules,customization}.md`, `architecture/workflows/*.md`,
  `examples/accounting.md`, `research/review-findings.md`. Finding IDs (C1–C8, G1–G12, R1–R6)
  and assumption IDs (A1–A26, P1–P4) are cited as they are written there.
- This repo: ADR 0004 (versions and record envelope), ADR 0005 (one command registry, CLI and
  MCP), ADR 0007 (external references), ADR 0008 (one inbox), `processes/README.md`,
  `docs/redesign/architecture.md`.
