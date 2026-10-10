# ADR 0005: Agents work through one command registry, as CLI and as MCP

Status: accepted (2026-10-10), revised the same day after an outside review (Codex). Today's
commands are `npm run …` scripts; nothing of this built yet.

## Problem

Agents do much of the work: Claude Code and Codex for a technical owner, Claude Desktop, Claude
Cowork or ChatGPT for a bookkeeper or Treuhänder who never opens a terminal
([personas](../personas/README.md)). They must work within the app's rules: an agent that edits
`books.json` directly bypasses the closed-quarter seals, the VAT logic and the history.

Two ways to give an agent the app: a command line, or an MCP server. Which one is more
efficient, and which is friendlier?

| | CLI (`vanilla …`) | MCP server |
|---|---|---|
| For | Claude Code, Codex, scripts, scheduled jobs; a person in a terminal | Claude Desktop, Claude Cowork, ChatGPT: people without a terminal |
| Setup | install the CLI, give the agent a shell | add a connector once |
| Context cost | low: the agent reads `--help` or `AGENTS.md` when it needs a command | every tool's description is in the context; tens of fine-grained tools cost thousands of tokens per session (clients that load tool schemas on demand soften this) |
| Safety | the agent has a shell and could bypass the commands | the agent can only do what the tools offer; read-only tools are marked, writes can need confirmation |
| Results | text, or JSON with `--json` | always structured |
| Combining | strong: pipes, scripts, cron | one call at a time |
| Remote | needs a remote mode | MCP over HTTPS reaches a cloud instance through its login gate |

Neither is better for everyone: the CLI is cheaper and more flexible for a technical person;
MCP is friendlier and safer for everyone else.

## Decision

**One command registry, two front ends.** Every operation of the app is defined once, and the
CLI, the MCP server, the desktop app and the web app all call it, so they cannot drift apart.
A command is more than a name and a parameter schema; the registry carries what makes a write
safe ([ADR 0003](0003-deployment-and-collaboration.md), section 7):

| Part | What it is |
|---|---|
| name, description | for `--help`, the MCP tool list, the UI |
| parameters | a schema, checked at the boundary |
| effect | reads, writes, or finalizes (finalizing commands take the finalization lock) |
| permission | which roles may run it ([persona matrix](../personas/README.md#who-can-do-what)) |
| preconditions | the state the change is based on (a record's content hash, or a commit); a stale one is refused |
| idempotency | a key, so a retried call is applied once |
| function | applies the change, commits it with the actor as author, and journals it so a crash can be resumed |
| errors | refusals with a reason the person or agent can act on ("Q2 ist abgeschlossen; buche die Korrektur in Q3") |

- **CLI first** (`vanilla`, an npm package and later a single executable): it covers the owner,
  developers and every agent with a shell, and is today's `npm run` scripts made installable.
- **MCP second:** `vanilla mcp` over stdio for Claude Desktop and Cowork on a company member's
  machine, and the same tools over HTTPS on a cloud instance, behind its login gate, for a
  Treuhänder who wants to work through his own Claude plan
  ([ADR 0003](0003-deployment-and-collaboration.md), section 5).
- **Few, coarse tools** (10 to 15) that match the jobs of the personas, not one per field:
  `import_statement`, `book_open_payments`, `link_receipt`, `vat_report`, `explain_figure`,
  `close_check`, … This keeps the context small and lets the agent think in bookkeeping steps.
- **Every write goes through a command,** whichever front end: it knows the actor, checks
  permission, preconditions and rules, writes the record, and commits with the person as author
  and the front end in the trailer (`Vanilla-Via: cli | mcp | web | ai`).
- **The registry is built first** ([ADR 0003](0003-deployment-and-collaboration.md), order of
  work), on today's storage, before the data layout changes.

## Rejected

- **MCP only:** costs context for the technical owner and loses scripting.
- **CLI only:** leaves the people without a terminal to the browser and gives every agent a shell
  that can bypass the rules.
- **Fine-grained tools** (`set_account`, `set_vat_code`, …): many tool descriptions in every
  session, and agents that think in fields instead of bookkeeping steps.

## Consequences

- The `npm run` scripts become registry entries; `package.json` keeps them as thin aliases for
  developers.
- The MCP server comes with the Electron app ([ADR 0006](0006-desktop-shell.md)) and with the
  cloud instance.
- The persona matrix ([personas](../personas/README.md#who-can-do-what)) is enforced in the
  registry, not in each front end.
