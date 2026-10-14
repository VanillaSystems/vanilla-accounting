# Decisions

**Status: open.** Each decision gets an ADR in `docs/adr/` when it is made; this table then
links to it. Decided on branch `0.4.0` by the leaning, for implementation, open to review: D3 (b),
D4 (a), D5 (a), D9 (a), D12 (a). IDs in parentheses refer to the research repo's review findings.

| ID | Decision | Options | Leaning | Blocks |
|---|---|---|---|---|
| D1 | **Manifest format.** How much does `module.yaml` say? | (a) minimal: id, kind, version, schema, provides, requires, providers; (b) the research list: plus commands, queries, events, permissions, owned data, conformance tests | (a), grow it when a second module needs more | step 3 |
| D2 | **One replacement mechanism or two** (C2). Overlays of module data, and capability providers selected per installation. | (a) both, one lock file; (b) overlays only, a provider is an overlaid `providers:` key | (b): one mechanism, one lock file | step 3 |
| D3 | **Where runs live** (G7, G6). | (a) in the workspace's Git beside the books; (b) a local store outside the workspace, only run summaries in Git; (c) both, by retention | (b): runs hold private inputs and grow fast; the booking links to the run id | step 9 |
| D4 | **Workflow backend.** | (a) own durable runner over the run store; (b) behind an interface with Temporal as a candidate | (a) for 0.4.0, behind an interface | step 9 |
| D5 | **Who owns invariants** (C1). The core, or each domain module? | (a) one ledger core; (b) per module | (a) | step 8 |
| D6 | **Where approvals live** (G8). The switch-on flag must sit outside what the LLM edits. | (a) app-local state outside the workspace; (b) a signed file in the workspace; (c) Git commit signature of a person | open | step 13 |
| D7 | **Workspace code sandbox** (G2). Code modules run with the user's rights. | (a) trust in 0.4.0, documented; (b) a worker with only the declared ports | (a) for 0.4.0; providers shipped by upstream only, workspace code needs review | step 10 |
| D8 | **Can a module add a view?** | (a) no in 0.4.0; (b) a declarative view schema; (c) module code in the browser | (a) | — |
| D9 | **LLM steps and replay** (G4). An LLM step is not deterministic. | (a) replay uses the recorded LLM answer; (b) replay asks again and shows the difference | (a) by default, (b) on request | step 9 |
| D10 | **Folder for app modules and workflows.** | (a) `modules/` and `workflows/` at the repo root; (b) under `src/` | (a): they are data, public, and read by the lint like `processes/` | step 3 |
| D11 | **Who saves the books** (amends ADR 0003 §4). | (a) every change is a commit at once, as ADR 0003 says; (b) workflows and the AI write, a person saves what the AI prepared; filing, seals and year close save themselves | (b): the page shows the work done and the person approves it; (a) stays available as the setting «automatisch speichern» | saving.md, step 13 |
| D12 | **Workspace layout** ([ADR 0013](../adr/0013-workspace-layout-and-ownership.md)). Where the books lie in a company's repository that holds several apps, what is the app's, and when the books split by year. | (a) one folder per app (`vanilla-accounting/`), shared master data reserved in `master-data/`, inside it the customizing (settings, `knowledge/`), the app's `master-data/` (chart of accounts) and `transactional-data/<year>/` (`books/`, `receipts/`, `bank-statements/`, `filings/`, `invoices/`, `expected/`), one owner list in `WorkspacePaths`, everything else in `own/`, all in 0.4.0; (b) the books at the repository's root, split by part (`books/<year>/`, ADR 0003 §3 as written); (c) as today, split later with the cloud instance (ADR 0003) | (a) | step 14 |

## Settled already, for reference

- **Records live in Git** (research A15, 14 October 2026), as they do today.
- **Modular monolith, Node.js and TypeScript.** No services per module.
- **One command registry for CLI and MCP** (ADR 0005). Workflow actions come from it.
- **The browser computes figures from data**; module code stays on the server.
